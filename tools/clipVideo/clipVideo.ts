/**
 * clipVideo — WebCodecs Pipeline
 * ────────────────────────────────
 * Uses the browser's native VideoEncoder / AudioEncoder APIs + webm-muxer
 * for fast, frame-accurate video clipping without any WASM download.
 *
 * Output: WebM (VP9 video + Opus audio)
 * Speed:  ~4× real-time (playbackRate=4; timestamps from video.currentTime
 *         so the output always plays at normal speed)
 */

import { Muxer, ArrayBufferTarget } from "webm-muxer";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ClipVideoOptions {
  videoFile: File;
  startSeconds: number;
  endSeconds: number;
  outputName?: string;
  onProgress?: (pct: number) => void;
}

export interface ClipVideoResult {
  success: boolean;
  blob?: Blob;
  blobUrl?: string;
  fileName?: string;
  error?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function waitForEvent(target: EventTarget, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOk  = () => { cleanup(); resolve(); };
    const onErr = () => { cleanup(); reject(new Error(`${event} error on element`)); };
    const cleanup = () => {
      target.removeEventListener(event,   onOk);
      target.removeEventListener("error", onErr);
    };
    target.addEventListener(event,   onOk,  { once: true });
    target.addEventListener("error", onErr, { once: true });
  });
}

async function pickVideoCodec(w: number, h: number): Promise<string> {
  for (const codec of ["vp09.00.10.08", "vp8"]) {
    try {
      const { supported } = await VideoEncoder.isConfigSupported({ codec, width: w, height: h });
      if (supported) return codec;
    } catch { /* next */ }
  }
  return "vp09.00.10.08";
}

// ─── No-op preload (WebCodecs is built-in — nothing to download) ─────────────
export async function getFFmpeg(_onProgress?: (pct: number) => void): Promise<unknown> {
  _onProgress?.(100);
  return {};
}

// ─── Main clip function ───────────────────────────────────────────────────────

export async function clipVideo(options: ClipVideoOptions): Promise<ClipVideoResult> {
  const { videoFile, startSeconds, endSeconds, outputName, onProgress } = options;

  if (startSeconds >= endSeconds) {
    return { success: false, error: "Start time must be less than end time." };
  }

  if (typeof VideoEncoder === "undefined" || typeof AudioEncoder === "undefined") {
    return {
      success: false,
      error: "WebCodecs not supported. Please use Chrome 94+ or Edge 94+.",
    };
  }

  try {
    onProgress?.(2);

    // ── 1. Setup video element ──────────────────────────────────────────────
    const srcUrl = URL.createObjectURL(videoFile);
    const video  = document.createElement("video");
    video.src    = srcUrl;
    video.muted  = true;
    await waitForEvent(video, "loadedmetadata");

    const { videoWidth: W, videoHeight: H } = video;
    const segDuration = endSeconds - startSeconds;

    // ── 2. Setup muxer ─────────────────────────────────────────────────────
    const encoderCodec = await pickVideoCodec(W, H);
    const muxerVCodec  = encoderCodec.startsWith("vp09") ? "V_VP9" : "V_VP8";

    const target = new ArrayBufferTarget();
    const muxer  = new Muxer({
      target,
      video: { codec: muxerVCodec, width: W, height: H, frameRate: 30 },
      audio: { codec: "A_OPUS", sampleRate: 48_000, numberOfChannels: 2 },
      firstTimestampBehavior: "offset",
    });

    // ── 3. Encode audio ─────────────────────────────────────────────────────
    onProgress?.(5);
    const audioCtx  = new AudioContext({ sampleRate: 48_000 });
    const audioBuf  = await audioCtx.decodeAudioData(await videoFile.arrayBuffer());
    await audioCtx.close();

    const SR          = audioBuf.sampleRate;
    const numChannels = Math.min(audioBuf.numberOfChannels, 2);
    const startSample = Math.floor(startSeconds * SR);
    const endSample   = Math.ceil(endSeconds    * SR);
    const CHUNK       = 1024;

    const audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error:  (e) => console.error("[WebCodecs] AudioEncoder:", e),
    });
    audioEncoder.configure({
      codec: "opus", sampleRate: 48_000,
      numberOfChannels: numChannels, bitrate: 128_000,
    });

    for (let i = startSample; i < endSample; i += CHUNK) {
      const len = Math.min(CHUNK, endSample - i);
      // Build planar f32: channel 0 samples then channel 1 samples
      const pcm = new Float32Array(len * numChannels);
      for (let ch = 0; ch < numChannels; ch++) {
        const src = audioBuf.getChannelData(ch);
        for (let j = 0; j < len; j++) pcm[ch * len + j] = src[i + j] ?? 0;
      }
      const ad = new AudioData({
        format: "f32-planar", sampleRate: 48_000,
        numberOfFrames: len, numberOfChannels: numChannels,
        timestamp: Math.round((i - startSample) / SR * 1_000_000),
        data: pcm,
      });
      audioEncoder.encode(ad);
      ad.close();
    }
    await audioEncoder.flush();
    audioEncoder.close();
    onProgress?.(15);

    // ── 4. Encode video via requestVideoFrameCallback ──────────────────────
    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error:  (e) => console.error("[WebCodecs] VideoEncoder:", e),
    });
    videoEncoder.configure({
      codec: encoderCodec, width: W, height: H,
      bitrate: 6_000_000, framerate: 30,
    });

    video.currentTime = startSeconds;
    await waitForEvent(video, "seeked");

    // Play at 4× — frames arrive 4× faster but timestamps are from
    // video.currentTime (real position), so output plays at normal speed.
    video.playbackRate = 4;

    let frameCount = 0;
    await new Promise<void>((resolve, reject) => {
      const onFrame: VideoFrameRequestCallback = () => {
        if (video.currentTime >= endSeconds || video.ended) {
          video.pause();
          resolve();
          return;
        }

        const timestampUs = Math.round((video.currentTime - startSeconds) * 1_000_000);
        let vf: VideoFrame | null = null;
        try {
          vf = new VideoFrame(video, { timestamp: timestampUs });
          videoEncoder.encode(vf, { keyFrame: frameCount % 150 === 0 });
          frameCount++;
        } catch (e) {
          console.warn("[WebCodecs] Frame encode skipped:", e);
        } finally {
          vf?.close();
        }

        const pct = 15 + Math.round(((video.currentTime - startSeconds) / segDuration) * 80);
        onProgress?.(Math.min(95, pct));

        video.requestVideoFrameCallback(onFrame);
      };

      video.requestVideoFrameCallback(onFrame);
      video.play().catch(reject);
    });

    // ── 5. Finalize ─────────────────────────────────────────────────────────
    await videoEncoder.flush();
    videoEncoder.close();
    muxer.finalize();
    URL.revokeObjectURL(srcUrl);

    const outName = `${outputName ?? "clipped_video"}.webm`;
    const blob    = new Blob([target.buffer], { type: "video/webm" });
    const blobUrl = URL.createObjectURL(blob);

    onProgress?.(100);
    return { success: true, blob, blobUrl, fileName: outName };

  } catch (err) {
    console.error("[WebCodecs] clipVideo error:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "WebCodecs processing failed.",
    };
  }
}
