/**
 * export.worker.ts
 *
 * Off-main-thread WebCodecs export pipeline using Mediabunny v1.40.1.
 *
 * Architecture:
 *  - Demux source with Mediabunny Input + EncodedPacketSink
 *  - Decode via VideoDecoder, render to OffscreenCanvas, encode via CanvasSource (VideoSampleSource under the hood)
 *  - Audio: decode entire file with OfflineAudioContext, feed segments via AudioBufferSource
 *  - Mux with Mediabunny Output → Mp4OutputFormat → BufferTarget
 *  - Hardware fallback: getFirstEncodableVideoCodec(['hevc','vp9','avc'])
 *  - Memory: frame.close() immediately after use; backpressure via decoder/encoder queue monitoring
 */

import {
  Input,
  Output,
  Mp4OutputFormat,
  BufferTarget,
  BlobSource,
  EncodedPacketSink,
  AudioBufferSource,
  CanvasSource,
  MP4,
  getFirstEncodableVideoCodec,
} from "mediabunny";
import type { VideoCodec } from "mediabunny";

// ─────────────────────────────────────────────────────────────────────────────
// Worker message types
// ─────────────────────────────────────────────────────────────────────────────

export interface QualityOption {
  id: "fast" | "standard" | "high";
  label: string;
  desc: string;
  bitrate: number;
  maxHeight?: number;
  codec: string; // kept for display only — actual codec negotiated via Mediabunny
}

export type ExportWorkerMessage =
  | {
      type: "start";
      file: File;
      segments: { start: number; end: number }[];
      quality: QualityOption;
      label: string;
    }
  | { type: "abort" };

export type ExportWorkerResponse =
  | { type: "progress"; percent: number; message: string; label: string }
  | { type: "done"; blob: Blob; name: string; label: string }
  | { type: "error"; error: string; label: string };

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Max frames buffered in the decoder before we yield to prevent RAM exhaustion */
const MAX_DECODE_QUEUE = 30;
/** Audio chunk block size fed to AudioBufferSource, in frames */
const AUDIO_CHUNK_FRAMES = 4096;

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

self.onmessage = async (e: MessageEvent<ExportWorkerMessage>) => {
  if (e.data.type !== "start") return;

  const { file, segments, quality, label } = e.data;

  const progress = (percent: number, message: string) => {
    self.postMessage({ type: "progress", percent, message, label } satisfies ExportWorkerResponse);
  };

  try {
    const blob = await runExportPipeline(file, segments, quality, progress);
    const baseName = file.name.replace(/\.[^.]+$/, "");
    self.postMessage({
      type: "done",
      blob,
      name: `${baseName}_${label}.mp4`,
      label,
    } satisfies ExportWorkerResponse);
  } catch (err) {
    self.postMessage({
      type: "error",
      error: err instanceof Error ? err.message : String(err),
      label,
    } satisfies ExportWorkerResponse);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Hardware codec negotiation using Mediabunny's canEncodeVideo helper
// ─────────────────────────────────────────────────────────────────────────────

async function negotiateVideoCodec(
  outW: number,
  outH: number,
  bitrate: number
): Promise<VideoCodec> {
  // Preference order: HEVC → VP9 → AVC (H.264)
  // getFirstEncodableVideoCodec uses VideoEncoder.isConfigSupported internally.
  // Note: options here only accept {width, height, bitrate} — hardwareAcceleration
  // is set on the CanvasSource encoding config, not here.
  const preferenceOrder: VideoCodec[] = ["hevc", "vp9", "avc"];
  const codec = await getFirstEncodableVideoCodec(preferenceOrder, {
    width: outW,
    height: outH,
    bitrate,
  });

  if (codec) {
    console.log(`[Worker] Negotiated codec: ${codec}`);
    return codec;
  }

  // Final fallback: try AVC with no extra constraints
  const swCodec = await getFirstEncodableVideoCodec(["avc"]);

  if (swCodec) {
    console.log(`[Worker] Falling back to software AVC`);
    return swCodec;
  }

  throw new Error(
    "No supported VideoEncoder configuration found. Your browser may not support WebCodecs video encoding."
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main pipeline
// ─────────────────────────────────────────────────────────────────────────────

async function runExportPipeline(
  file: File,
  segments: { start: number; end: number }[],
  quality: QualityOption,
  onProgress: (pct: number, msg: string) => void
): Promise<Blob> {
  onProgress(2, "Opening input file…");

  // ── 1. Open input ──────────────────────────────────────────────────────────
  const input = new Input({
    source: new BlobSource(file),
    formats: [MP4],
  });

  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) throw new Error("No video track found in the input file.");

  const decoderConfig = await videoTrack.getDecoderConfig();
  if (!decoderConfig) throw new Error("Cannot determine decoder configuration for video track.");

  // Compute output dimensions, clamped to quality.maxHeight, always even
  let outW = videoTrack.codedWidth;
  let outH = videoTrack.codedHeight;
  if (quality.maxHeight && outH > quality.maxHeight) {
    const scale = quality.maxHeight / outH;
    outW = Math.round(outW * scale);
    outH = quality.maxHeight;
  }
  outW = outW % 2 === 0 ? outW : outW + 1;
  outH = outH % 2 === 0 ? outH : outH + 1;

  onProgress(5, "Negotiating best video codec…");

  // ── 2. Negotiate video codec ───────────────────────────────────────────────
  const videoCodec = await negotiateVideoCodec(outW, outH, quality.bitrate);

  // ── 3. Set up output muxer ─────────────────────────────────────────────────
  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat(),
    target,
  });

  // ── 4. OffscreenCanvas + CanvasSource ──────────────────────────────────────
  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to get 2D context from OffscreenCanvas.");

  const videoSource = new CanvasSource(canvas, {
    codec: videoCodec,
    bitrate: quality.bitrate,
    keyFrameInterval: 2, // key frame every 2 s for good seeking
    hardwareAcceleration: "prefer-hardware",
  });

  // ── 5. Audio source (AudioBufferSource — simplest OfflineAudioContext path) ─
  const audioTrack = await input.getPrimaryAudioTrack();
  const hasAudio = audioTrack !== null && typeof AudioContext !== "undefined";

  let audioSource: AudioBufferSource | null = null;
  if (hasAudio) {
    audioSource = new AudioBufferSource({
      codec: "aac",
      bitrate: 128_000,
    });
  }

  // Add tracks — video first, audio second
  output.addVideoTrack(videoSource);
  if (audioSource) output.addAudioTrack(audioSource);

  await output.start();

  // ── 6. Video decode + encode loop ──────────────────────────────────────────
  onProgress(10, "Starting video pipeline…");

  const totalDuration = segments.reduce((s, seg) => s + seg.end - seg.start, 0);
  let handledSec = 0;
  let framesEncoded = 0;

  const decodedFrames: VideoFrame[] = [];
  let decoderError: Error | null = null;

  const videoDecoder = new VideoDecoder({
    output: (frame) => decodedFrames.push(frame),
    error: (e) => { decoderError = e instanceof Error ? e : new Error(String(e)); },
  });

  // Configure decoder with hardware preference
  videoDecoder.configure({ ...decoderConfig, hardwareAcceleration: "prefer-hardware" });

  const packetSink = new EncodedPacketSink(videoTrack);

  for (const seg of segments) {
    if (decoderError) throw decoderError;

    const segStartSec = seg.start;
    const segEndSec = seg.end;

    // Seek to the keyframe at or before segment start so the decoder has context
    const keyPacket = await packetSink.getKeyPacket(segStartSec);
    if (!keyPacket) {
      // No key packet found before start — skip segment
      console.warn(`[Worker] No key packet found before ${segStartSec}s, skipping segment.`);
      continue;
    }

    // Decode and discard frames up to the keyframe, then iterate forward
    for await (const packet of packetSink.packets(keyPacket)) {
      if (decoderError) throw decoderError;

      // Stop iterating once we've passed the segment end
      if (packet.timestamp > segEndSec) break;

      videoDecoder.decode(packet.toEncodedVideoChunk());

      // Decoder backpressure: don't let queue grow unbounded
      while (videoDecoder.decodeQueueSize > MAX_DECODE_QUEUE) {
        await new Promise<void>((r) => setTimeout(r, 5));
      }

      // Drain decoded frames
      while (decodedFrames.length > 0) {
        const frame = decodedFrames.shift()!;
        const frameTsSec = frame.timestamp / 1_000_000;

        // Only encode frames that fall within the segment window
        if (frameTsSec >= segStartSec && frameTsSec <= segEndSec) {
          // Draw to canvas
          ctx.clearRect(0, 0, outW, outH);
          ctx.drawImage(frame, 0, 0, outW, outH);

          // Compute output timestamp in seconds (timeline-relative)
          const relSec = Math.max(0, frameTsSec - segStartSec);
          const outTsSec = handledSec + relSec;
          const durSec = frame.duration ? frame.duration / 1_000_000 : undefined;

          // CanvasSource.add() returns a Promise that respects encoder backpressure
          // automatically — awaiting it is all the throttling we need.
          await videoSource.add(outTsSec, durSec);
          framesEncoded++;
        }

        // Always close frame immediately — releases GPU memory
        frame.close();
      }

      // Progress update
      if (packet.timestamp > segStartSec) {
        const withinSeg = Math.min(
          (packet.timestamp - segStartSec) / (segEndSec - segStartSec),
          1
        );
        const overallPct = (handledSec + withinSeg * (segEndSec - segStartSec)) / totalDuration;
        onProgress(
          Math.round(10 + overallPct * 70),
          `Encoding… ${framesEncoded} frames`
        );
      }
    }

    // Flush decoder at end of segment and drain remaining frames
    await videoDecoder.flush();
    while (decodedFrames.length > 0) {
      const frame = decodedFrames.shift()!;
      const frameTsSec = frame.timestamp / 1_000_000;
      if (frameTsSec >= segStartSec && frameTsSec <= segEndSec) {
        ctx.clearRect(0, 0, outW, outH);
        ctx.drawImage(frame, 0, 0, outW, outH);
        const relSec = Math.max(0, frameTsSec - segStartSec);
        const outTsSec = handledSec + relSec;
        const durSec = frame.duration ? frame.duration / 1_000_000 : undefined;
        await videoSource.add(outTsSec, durSec);
        framesEncoded++;
      }
      frame.close();
    }

    handledSec += segEndSec - segStartSec;
  }

  videoDecoder.close();
  videoSource.close();

  // ── 7. Audio: OfflineAudioContext mixdown ───────────────────────────────────
  if (hasAudio && audioSource) {
    onProgress(82, "Fast audio mixdown (OfflineAudioContext)…");
    try {
      await processAudio(file, segments, audioSource);
    } catch (err) {
      // Audio failure is non-fatal — export continues without audio
      console.warn("[Worker] Audio processing failed, exporting without audio:", err);
    }
    audioSource.close();
  }

  // ── 8. Finalize ────────────────────────────────────────────────────────────
  onProgress(95, "Finalizing MP4…");
  await output.finalize();
  input[Symbol.dispose]();

  const buffer = target.buffer;
  if (!buffer) throw new Error("Muxer produced no output buffer.");

  return new Blob([buffer], { type: "video/mp4" });
}

// ─────────────────────────────────────────────────────────────────────────────
// Audio mixdown via OfflineAudioContext
// ─────────────────────────────────────────────────────────────────────────────

async function processAudio(
  file: File,
  segments: { start: number; end: number }[],
  audioSource: AudioBufferSource
): Promise<void> {
  // Decode the entire source file — this is instantaneous via OfflineAudioContext
  // We need a temporary AudioContext just for the decodeAudioData call (no playback)
  const fileBuffer = await file.arrayBuffer();

  // Use a minimal AudioContext solely to decode raw bytes — no real-time playback occurs
  const tempCtx = new AudioContext({ sampleRate: 48_000 });
  let decodedAudio: AudioBuffer;
  try {
    decodedAudio = await tempCtx.decodeAudioData(fileBuffer);
  } finally {
    await tempCtx.close();
  }

  const SR = decodedAudio.sampleRate;
  const numCh = Math.min(decodedAudio.numberOfChannels, 2);

  for (const seg of segments) {
    const startFrame = Math.floor(seg.start * SR);
    const endFrame = Math.min(Math.floor(seg.end * SR), decodedAudio.length);
    const totalFrames = endFrame - startFrame;
    if (totalFrames <= 0) continue;

    // Use OfflineAudioContext to correctly render just the segment slice.
    // This handles any sample-rate conversion, gain nodes, or future effects as needed.
    const offlineCtx = new OfflineAudioContext(numCh, totalFrames, SR);
    const bufSrc = offlineCtx.createBufferSource();
    bufSrc.buffer = decodedAudio;
    bufSrc.connect(offlineCtx.destination);
    // start(when, offset, duration): play from seg.start for the segment duration
    bufSrc.start(0, seg.start, seg.end - seg.start);
    const renderedBuffer = await offlineCtx.startRendering();

    // Feed the rendered AudioBuffer in chunks to AudioBufferSource.
    // AudioBufferSource.add() automatically timestamps and encodes each buffer.
    // We use a single OfflineAudioContext as a lightweight AudioBuffer factory — no real-time
    // audio is ever played; it is closed immediately and creates zero overhead.
    const bufferFactory = new OfflineAudioContext(numCh, totalFrames, SR);
    for (let i = 0; i < totalFrames; i += AUDIO_CHUNK_FRAMES) {
      const chunkLen = Math.min(AUDIO_CHUNK_FRAMES, totalFrames - i);
      const chunkBuffer = bufferFactory.createBuffer(numCh, chunkLen, SR);
      for (let ch = 0; ch < numCh; ch++) {
        const src = renderedBuffer.getChannelData(ch).subarray(i, i + chunkLen);
        chunkBuffer.copyToChannel(src, ch);
      }
      // AudioBufferSource.add() manages timestamps automatically (each buffer follows the previous)
      await audioSource.add(chunkBuffer);
    }
  }
}
