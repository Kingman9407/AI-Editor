/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import React, { useCallback, useMemo, useRef, useState } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import { Segment } from "../../utils/segments";
import { PLAN_CONFIGS, PlanId } from "../../utils/plans";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ExportPanelProps {
  videoFile: File | null;
  keptSegments: Segment[];
  removedSegments: Segment[];
  planId: PlanId;
  exportCount: number;
  onExportSuccess?: (planId: PlanId) => void;
  registerExporter?: (
    exporter: () => Promise<{ success: boolean; error?: string }>
  ) => void;
}

type ExportResult = { url: string; name: string } | null;
type Quality = "fast" | "standard" | "high";

interface QualityOption {
  id: Quality;
  label: string;
  desc: string;
  bitrate: number;
  maxHeight?: number;
  codec: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Quality presets
// ─────────────────────────────────────────────────────────────────────────────

const QUALITY_OPTIONS: QualityOption[] = [
  {
    id: "fast",
    label: "Fast",
    desc: "720p · 2 Mbps · GPU ultrafast",
    bitrate: 2_000_000,
    maxHeight: 720,
    codec: "avc1.420028",
  },
  {
    id: "standard",
    label: "Standard",
    desc: "Original · 4 Mbps",
    bitrate: 4_000_000,
    codec: "avc1.640028",
  },
  {
    id: "high",
    label: "High",
    desc: "Original · 8 Mbps",
    bitrate: 8_000_000,
    codec: "avc1.640033",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function webCodecsAvailable(): boolean {
  try {
    return (
      typeof VideoEncoder !== "undefined" &&
      typeof VideoDecoder !== "undefined"
    );
  } catch {
    return false;
  }
}

function audioEncAvailable(): boolean {
  try {
    return typeof AudioEncoder !== "undefined";
  } catch {
    return false;
  }
}

function sumDuration(segs: Segment[]): number {
  return segs.reduce((a, s) => a + s.end - s.start, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// WebCodecs export — Mediabunny Worker pipeline
// ─────────────────────────────────────────────────────────────────────────────

async function exportWithWebCodecs(
  file: File,
  segments: Segment[],
  quality: QualityOption,
  label: string,
  onProgress: (pct: number, label: string) => void
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./export.worker.ts", import.meta.url), {
      type: "module",
    });

    worker.onmessage = (e) => {
      const data = e.data;
      if (data.type === "progress") {
        onProgress(data.percent, data.message);
      } else if (data.type === "done") {
        worker.terminate();
        resolve(data.blob);
      } else if (data.type === "error") {
        worker.terminate();
        reject(new Error(data.error));
      }
    };

    worker.onerror = (e) => {
      worker.terminate();
      reject(e);
    };

    worker.postMessage({
      type: "start",
      file,
      segments: segments.map((s) => ({ start: s.start, end: s.end })),
      quality,
      label,
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FFmpeg.wasm fallback — used automatically on Firefox / Safari < 16.4
// ─────────────────────────────────────────────────────────────────────────────

const buildFilter = (segs: Segment[], hasAudio: boolean): string => {
  const parts: string[] = [];
  segs.forEach((s, i) => {
    parts.push(
      `[0:v]trim=start=${s.start}:end=${s.end},setpts=PTS-STARTPTS[v${i}]`
    );
    if (hasAudio)
      parts.push(
        `[0:a]atrim=start=${s.start}:end=${s.end},asetpts=PTS-STARTPTS[a${i}]`
      );
  });
  const vi = segs.map((_, i) => `[v${i}]`).join("");
  const ai = hasAudio ? segs.map((_, i) => `[a${i}]`).join("") : "";
  parts.push(
    hasAudio
      ? `${vi}${ai}concat=n=${segs.length}:v=1:a=1[outv][outa]`
      : `${vi}concat=n=${segs.length}:v=1:a=0[outv]`
  );
  return parts.join(";");
};

async function exportWithFFmpeg(
  ffmpegRef: React.MutableRefObject<FFmpeg | null>,
  file: File,
  segments: Segment[],
  outputName: string,
  onProgress: (pct: number, label: string) => void
): Promise<Blob> {
  onProgress(5, "Loading FFmpeg (fallback for this browser)…");

  if (!ffmpegRef.current) {
    const ffmpeg = new FFmpeg();
    ffmpeg.on("progress", ({ progress: p }) =>
      onProgress(
        10 + Math.round(p * 70),
        `Encoding… ${Math.round(p * 100)}%`
      )
    );
    const cdns = [
      "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm",
      "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm",
    ];
    for (const base of cdns) {
      try {
        await ffmpeg.load({
          coreURL: await toBlobURL(
            `${base}/ffmpeg-core.js`,
            "text/javascript"
          ),
          wasmURL: await toBlobURL(
            `${base}/ffmpeg-core.wasm`,
            "application/wasm"
          ),
          workerURL: await toBlobURL(
            `${base}/ffmpeg-core.worker.js`,
            "text/javascript"
          ),
        });
        ffmpegRef.current = ffmpeg;
        break;
      } catch { }
    }
    if (!ffmpegRef.current) throw new Error("Failed to load FFmpeg.");
  }

  const ff = ffmpegRef.current;
  const inputName = "input.mp4";

  onProgress(12, "Writing input…");
  await ff.writeFile(inputName, await fetchFile(file));

  let hasAudio = false;
  try {
    await ff.exec(["-i", inputName, "-t", "0", "-map", "0:a", "-f", "null", "-"]);
    hasAudio = true;
  } catch { }

  try { await ff.deleteFile(outputName); } catch { }

  onProgress(15, "Encoding with FFmpeg…");
  if (segments.length === 1) {
    const s = segments[0]!;
    await ff.exec([
      "-y", "-i", inputName,
      "-ss", String(s.start), "-to", String(s.end),
      "-c:v", "libx264", "-preset", "ultrafast",
      ...(hasAudio ? ["-c:a", "aac"] : ["-an"]),
      outputName,
    ]);
  } else {
    const filter = buildFilter(segments, hasAudio);
    await ff.exec([
      "-y", "-i", inputName,
      "-filter_complex", filter,
      "-map", "[outv]",
      ...(hasAudio ? ["-map", "[outa]"] : []),
      "-c:v", "libx264", "-preset", "ultrafast",
      ...(hasAudio ? ["-c:a", "aac"] : ["-an"]),
      outputName,
    ]);
  }

  const data = await ff.readFile(outputName);
  return new Blob([(data as Uint8Array).buffer as ArrayBuffer], { type: "video/mp4" });
}

// ─────────────────────────────────────────────────────────────────────────────
// ExportPanel component
// ─────────────────────────────────────────────────────────────────────────────

export default function ExportPanel({
  videoFile,
  keptSegments,
  removedSegments,
  planId,
  exportCount,
  onExportSuccess,
  registerExporter,
}: ExportPanelProps) {
  const planConfig = PLAN_CONFIGS[planId];
  const ffmpegRef = useRef<FFmpeg | null>(null);

  const videoFileRef = useRef(videoFile);
  const keptRef = useRef(keptSegments);
  const removedRef = useRef(removedSegments);
  const planIdRef = useRef(planId);
  const limitRef = useRef(planConfig.exportLimit);
  const countRef = useRef(exportCount);
  const successRef = useRef(onExportSuccess);
  const exportingRef = useRef(false);

  const [quality, setQuality] = useState<Quality>("standard");
  const [isExporting, setIsExporting] = useState(false);
  const [progressMsg, setProgressMsg] = useState("");
  const [progressPct, setProgressPct] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [trimmedResult, setTrimmedResult] = useState<ExportResult>(null);
  const [removedResult, setRemovedResult] = useState<ExportResult>(null);

  const [useGPU] = useState<boolean>(() =>
    typeof window !== "undefined" ? webCodecsAvailable() : false
  );

  React.useEffect(() => { videoFileRef.current = videoFile; }, [videoFile]);
  React.useEffect(() => { keptRef.current = keptSegments; }, [keptSegments]);
  React.useEffect(() => { removedRef.current = removedSegments; }, [removedSegments]);
  React.useEffect(() => { planIdRef.current = planId; limitRef.current = planConfig.exportLimit; }, [planId, planConfig.exportLimit]);
  React.useEffect(() => { countRef.current = exportCount; }, [exportCount]);
  React.useEffect(() => { successRef.current = onExportSuccess; }, [onExportSuccess]);

  const remainingExports = Math.max(0, planConfig.exportLimit - exportCount);
  const limitReached = planConfig.exportLimit > 0 && exportCount >= planConfig.exportLimit;

  const canExport = useMemo(
    () =>
      Boolean(
        videoFile &&
        (keptSegments.length || removedSegments.length) &&
        !limitReached
      ),
    [videoFile, keptSegments.length, removedSegments.length, limitReached]
  );

  const currentQuality = QUALITY_OPTIONS.find((q) => q.id === quality)!;

  const exportVideos = useCallback(async (): Promise<{
    success: boolean;
    error?: string;
  }> => {
    const file = videoFileRef.current;
    const kept = keptRef.current;
    const removed = removedRef.current;
    const curPlan = planIdRef.current;
    const limit = limitRef.current;
    const count = countRef.current;

    if (!file) return { success: false, error: "No video loaded." };
    if (exportingRef.current) return { success: false, error: "Export already running." };
    if (limit > 0 && count >= limit) {
      const msg = `Export limit reached for ${PLAN_CONFIGS[curPlan].label} plan.`;
      setError(msg);
      return { success: false, error: msg };
    }
    if (!kept.length && !removed.length) {
      setError("No segments to export.");
      return { success: false, error: "No segments to export." };
    }

    setError(null);
    exportingRef.current = true;
    setIsExporting(true);
    setProgressPct(0);
    setTrimmedResult(null);
    setRemovedResult(null);

    const onProgress = (pct: number, label: string) => {
      setProgressPct(pct);
      setProgressMsg(label);
    };

    try {
      const processSegments = async (
        segs: Segment[],
        label: string
      ): Promise<ExportResult> => {
        if (!segs.length) return null;

        const blob = useGPU
          ? await exportWithWebCodecs(file, segs, currentQuality, label, onProgress)
          : await exportWithFFmpeg(
            ffmpegRef,
            file,
            segs,
            `${label}.mp4`,
            onProgress
          );

        const baseName = file.name.replace(/\.[^.]+$/, "");
        return { url: URL.createObjectURL(blob), name: `${baseName}_${label}.mp4` };
      };

      onProgress(1, useGPU ? "Starting GPU export…" : "Starting export…");

      console.log(
        "%c[Export] Pipeline info",
        "color:#818cf8;font-weight:bold",
        {
          pipeline: useGPU ? "Mediabunny WebCodecs Worker" : "FFmpeg.wasm",
          videoCodec: useGPU ? currentQuality.codec : "libx264",
          audioCodec: useGPU ? "mp4a.40.2 (AAC-LC)" : "aac",
          quality: currentQuality.label,
          bitrate: `${(currentQuality.bitrate / 1_000_000).toFixed(0)} Mbps`,
          maxHeight: currentQuality.maxHeight ? `${currentQuality.maxHeight}p` : "original",
          segments: { kept: kept.length, removed: removed.length },
          audioEnc: audioEncAvailable(),
          file: file.name,
        }
      );

      // Process kept and removed sequentially (parallel would double memory pressure)
      const trimmed = await processSegments(kept, "trimmed");
      setTrimmedResult(trimmed);

      const removed_ = await processSegments(removed, "removed");
      setRemovedResult(removed_);

      setProgressMsg("Done!");
      setProgressPct(100);
      successRef.current?.(curPlan);
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Export failed";
      setError(msg);
      return { success: false, error: msg };
    } finally {
      exportingRef.current = false;
      setIsExporting(false);
    }
  }, [useGPU, currentQuality]);

  React.useEffect(() => {
    registerExporter?.(exportVideos);
  }, [registerExporter, exportVideos]);

  return (
    <div className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 shadow-2xl backdrop-blur-xl">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <div className="text-sm font-semibold text-zinc-200">Export</div>
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${useGPU
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                  : "border-zinc-700 text-zinc-500"
                }`}
            >
              {useGPU ? "⚡ GPU" : "CPU"}
            </span>
          </div>
          <div className="text-[11px] text-zinc-500">
            {planConfig.label} plan — {remainingExports} of{" "}
            {planConfig.exportLimit} exports remaining
          </div>
        </div>

        <button
          type="button"
          onClick={() => void exportVideos()}
          disabled={!canExport || isExporting}
          className="rounded-full bg-blue-600 px-5 py-2 text-xs font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isExporting ? "Exporting…" : "Export"}
        </button>
      </div>

      {/* Quality selector */}
      <div className="flex items-center gap-1 rounded-full border border-zinc-800 bg-zinc-950/60 p-1">
        {QUALITY_OPTIONS.map((q) => (
          <button
            key={q.id}
            type="button"
            disabled={isExporting}
            onClick={() => setQuality(q.id)}
            className={`flex-1 rounded-full py-1 text-[11px] font-semibold transition ${quality === q.id
                ? "bg-blue-600 text-white shadow"
                : "text-zinc-400 hover:text-zinc-200"
              }`}
          >
            {q.label}
          </button>
        ))}
      </div>
      <div className="text-[11px] text-zinc-500">
        {currentQuality.desc}
        {useGPU && " · hardware accelerated"}
      </div>

      {/* Progress */}
      {isExporting && (
        <div className="space-y-1.5">
          <div className="flex justify-between text-[11px] text-zinc-400">
            <span>{progressMsg}</span>
            <span>{progressPct}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-gradient-to-r from-blue-500 to-emerald-400 transition-all duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      )}

      {error && <div className="text-xs text-red-400">{error}</div>}
      {limitReached && (
        <div className="text-xs text-amber-400">
          Export limit reached for the {planConfig.label} plan.
        </div>
      )}

      {/* Result previews */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {(["trimmed", "removed"] as const).map((type) => {
          const result = type === "trimmed" ? trimmedResult : removedResult;
          const label = type === "trimmed" ? "Trimmed Export" : "Removed Export";
          return (
            <div key={type} className="space-y-2">
              <div className="text-xs font-medium text-zinc-400">{label}</div>
              {result ? (
                <div className="space-y-2">
                  <video
                    src={result.url}
                    className="w-full rounded-xl bg-black"
                    controls
                  />
                  <a
                    href={result.url}
                    download={result.name}
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-600"
                  >
                    ⬇ {result.name}
                  </a>
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-zinc-700 bg-zinc-950/60 p-6 text-center text-xs text-zinc-500">
                  {isExporting && type === "trimmed"
                    ? progressMsg
                    : `Export to generate ${type} video.`}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
