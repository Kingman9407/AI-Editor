"use client";

import React, { useMemo, useRef, useState } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import { Segment } from "../../utils/segments";
import { PLAN_CONFIGS, PlanId } from "../../utils/plans";

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

/**
 * Build an FFmpeg filter_complex string that trims + concatenates segments.
 * Handles the case where there is no audio stream in the video.
 */
const buildFilter = (segments: Segment[], hasAudio: boolean): string => {
  const parts: string[] = [];

  segments.forEach((segment, index) => {
    parts.push(
      `[0:v]trim=start=${segment.start}:end=${segment.end},setpts=PTS-STARTPTS[v${index}]`
    );
    if (hasAudio) {
      parts.push(
        `[0:a]atrim=start=${segment.start}:end=${segment.end},asetpts=PTS-STARTPTS[a${index}]`
      );
    }
  });

  const concatVideoInputs = segments.map((_, i) => `[v${i}]`).join("");
  const concatAudioInputs = hasAudio
    ? segments.map((_, i) => `[a${i}]`).join("")
    : "";

  if (hasAudio) {
    parts.push(
      `${concatVideoInputs}${concatAudioInputs}concat=n=${segments.length}:v=1:a=1[outv][outa]`
    );
  } else {
    parts.push(
      `${concatVideoInputs}concat=n=${segments.length}:v=1:a=0[outv]`
    );
  }

  return parts.join(";");
};

/**
 * Probe whether a video file has an audio stream by inspecting its file bytes.
 * We run `ffprobe`-equivalent logic via ffmpeg itself – write a tiny segment
 * and check stderr for "Audio:" in the stream info.
 * Simpler approach: we just attempt a no-op audio probe using ffmpeg exec.
 */
const probeHasAudio = async (ffmpeg: FFmpeg, inputName: string): Promise<boolean> => {
  // Run a 0-second null mux and check if it succeeds with audio mapping
  try {
    const logs: string[] = [];
    ffmpeg.on("log", ({ message }) => logs.push(message));
    await ffmpeg.exec([
      "-i", inputName,
      "-t", "0",
      "-map", "0:a",
      "-f", "null",
      "-",
    ]);
    ffmpeg.off("log", () => {});
    return true;
  } catch {
    return false;
  }
};

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

  // Stable refs so the callback doesn't need re-registration on every prop change
  const videoFileRef = useRef<File | null>(videoFile);
  const keptSegmentsRef = useRef<Segment[]>(keptSegments);
  const removedSegmentsRef = useRef<Segment[]>(removedSegments);
  const planIdRef = useRef<PlanId>(planId);
  const exportLimitRef = useRef(planConfig.exportLimit);
  const exportCountRef = useRef(exportCount);
  const onExportSuccessRef = useRef(onExportSuccess);
  const isExportingRef = useRef(false);

  const [isReady, setIsReady] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  type ExportResult = { url: string; name: string } | null;
  const [trimmedResult, setTrimmedResult] = useState<ExportResult>(null);
  const [removedResult, setRemovedResult] = useState<ExportResult>(null);

  const remainingExports = Math.max(0, planConfig.exportLimit - exportCount);
  const limitReached =
    planConfig.exportLimit > 0 && exportCount >= planConfig.exportLimit;

  const canExport = useMemo(
    () =>
      Boolean(
        videoFile &&
          (keptSegments.length || removedSegments.length) &&
          !limitReached
      ),
    [videoFile, keptSegments.length, removedSegments.length, limitReached]
  );

  // ── Sync refs ─────────────────────────────────────────────────────────────
  React.useEffect(() => { videoFileRef.current = videoFile; }, [videoFile]);
  React.useEffect(() => { planIdRef.current = planId; exportLimitRef.current = planConfig.exportLimit; }, [planId, planConfig.exportLimit]);
  React.useEffect(() => { exportCountRef.current = exportCount; }, [exportCount]);
  React.useEffect(() => { onExportSuccessRef.current = onExportSuccess; }, [onExportSuccess]);
  React.useEffect(() => { keptSegmentsRef.current = keptSegments; }, [keptSegments]);
  React.useEffect(() => { removedSegmentsRef.current = removedSegments; }, [removedSegments]);

  // ── Load FFmpeg ────────────────────────────────────────────────────────────
  const loadFfmpeg = async () => {
    if (ffmpegRef.current) return;
    const ffmpeg = new FFmpeg();

    ffmpeg.on("progress", ({ progress: p }) => {
      setProgress(`${Math.round(p * 100)}%`);
    });

    const baseURLs = [
      "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm",
      "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm",
    ];

    let lastError: unknown = null;
    for (const baseURL of baseURLs) {
      try {
        await ffmpeg.load({
          coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
          wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
          workerURL: await toBlobURL(`${baseURL}/ffmpeg-core.worker.js`, "text/javascript"),
        });
        ffmpegRef.current = ffmpeg;
        setIsReady(true);
        return;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError ?? new Error("Failed to load FFmpeg");
  };

  // ── Export a single list of segments into one output MP4 ─────────────────
  const exportSegments = async (
    ffmpeg: FFmpeg,
    inputName: string,
    hasAudio: boolean,
    segments: Segment[],
    outputName: string,
    label: string
  ): Promise<string> => {
    setProgress(`Building ${label}…`);

    // Ensure the output file doesn't already exist in the virtual FS
    try { await ffmpeg.deleteFile(outputName); } catch { /* ignore */ }

    if (segments.length === 1) {
      // Fast path: single segment — no concat needed, just trim
      const seg = segments[0];
      const args = [
        "-y",
        "-i", inputName,
        "-ss", String(seg.start),
        "-to", String(seg.end),
        "-c:v", "libx264",
        "-preset", "ultrafast",
        ...(hasAudio ? ["-c:a", "aac"] : ["-an"]),
        outputName,
      ];
      await ffmpeg.exec(args);
    } else {
      // Multiple segments — use filter_complex with concat
      const filter = buildFilter(segments, hasAudio);
      const args = [
        "-y",
        "-i", inputName,
        "-filter_complex", filter,
        "-map", "[outv]",
        ...(hasAudio ? ["-map", "[outa]"] : []),
        "-c:v", "libx264",
        "-preset", "ultrafast",
        ...(hasAudio ? ["-c:a", "aac"] : ["-an"]),
        outputName,
      ];
      await ffmpeg.exec(args);
    }

    const data = await ffmpeg.readFile(outputName);
    const blob = new Blob([data], { type: "video/mp4" });
    return URL.createObjectURL(blob);
  };

  // ── Main export handler ────────────────────────────────────────────────────
  const exportVideos = React.useCallback(async (): Promise<{ success: boolean; error?: string }> => {
    const currentVideo = videoFileRef.current;
    const currentKept = keptSegmentsRef.current;
    const currentRemoved = removedSegmentsRef.current;
    const currentPlanId = planIdRef.current;
    const limit = exportLimitRef.current;
    const count = exportCountRef.current;

    if (!currentVideo) return { success: false, error: "No video loaded." };
    if (isExportingRef.current) return { success: false, error: "Export already running." };
    if (limit > 0 && count >= limit) {
      const msg = `Export limit reached for the ${PLAN_CONFIGS[currentPlanId].label} plan.`;
      setError(msg);
      return { success: false, error: msg };
    }
    if (!currentKept.length && !currentRemoved.length) {
      setError("No segments to export.");
      return { success: false, error: "No segments to export." };
    }

    setError(null);
    isExportingRef.current = true;
    setIsExporting(true);
    setProgress("Loading FFmpeg…");
    setTrimmedResult(null);
    setRemovedResult(null);

    try {
      await loadFfmpeg();
      const ffmpeg = ffmpegRef.current!;

      const inputName = "input.mp4";
      setProgress("Writing input file…");
      await ffmpeg.writeFile(inputName, await fetchFile(currentVideo));

      // Probe once for audio
      setProgress("Probing audio stream…");
      const hasAudio = await probeHasAudio(ffmpeg, inputName);

      if (currentKept.length) {
        const url = await exportSegments(
          ffmpeg, inputName, hasAudio, currentKept, "trimmed.mp4", "trimmed video"
        );
        const baseName = currentVideo.name.replace(/\.[^.]+$/, "");
        setTrimmedResult({ url, name: `${baseName}_trimmed.mp4` });
      }

      if (currentRemoved.length) {
        const url = await exportSegments(
          ffmpeg, inputName, hasAudio, currentRemoved, "removed.mp4", "removed segments"
        );
        const baseName = currentVideo.name.replace(/\.[^.]+$/, "");
        setRemovedResult({ url, name: `${baseName}_removed.mp4` });
      }

      setProgress("Done!");
      onExportSuccessRef.current?.(currentPlanId);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Export failed";
      setError(message);
      return { success: false, error: message };
    } finally {
      isExportingRef.current = false;
      setIsExporting(false);
    }
  }, []);

  React.useEffect(() => {
    if (registerExporter) registerExporter(exportVideos);
  }, [registerExporter, exportVideos]);

  // ── UI ────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 shadow-2xl backdrop-blur-xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="text-sm font-semibold text-zinc-200">Export</div>
          <div className="text-[11px] text-zinc-500">
            {planConfig.label} plan — {remainingExports} of{" "}
            {planConfig.exportLimit} exports remaining
          </div>
        </div>
        <button
          type="button"
          onClick={exportVideos}
          disabled={!canExport || isExporting}
          className="rounded-full bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isExporting
            ? `Exporting… ${progress}`
            : isReady
            ? "Export Trimmed + Removed"
            : "Load FFmpeg & Export"}
        </button>
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}
      {limitReached && (
        <div className="text-xs text-amber-400">
          Export limit reached for the {planConfig.label} plan.
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Trimmed Export */}
        <div className="space-y-2">
          <div className="text-xs font-medium text-zinc-400">Trimmed Export</div>
          {trimmedResult ? (
            <div className="space-y-2">
              <video
                src={trimmedResult.url}
                className="w-full rounded-xl bg-black"
                controls
              />
              <a
                href={trimmedResult.url}
                download={trimmedResult.name}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-600"
              >
                ⬇ Download {trimmedResult.name}
              </a>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-zinc-700 bg-zinc-950/60 p-6 text-center text-xs text-zinc-500">
              {isExporting ? progress || "Processing…" : "Export to generate trimmed video."}
            </div>
          )}
        </div>

        {/* Removed Export */}
        <div className="space-y-2">
          <div className="text-xs font-medium text-zinc-400">Removed Export</div>
          {removedResult ? (
            <div className="space-y-2">
              <video
                src={removedResult.url}
                className="w-full rounded-xl bg-black"
                controls
              />
              <a
                href={removedResult.url}
                download={removedResult.name}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-600"
              >
                ⬇ Download {removedResult.name}
              </a>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-zinc-700 bg-zinc-950/60 p-6 text-center text-xs text-zinc-500">
              {isExporting ? progress || "Processing…" : "Export to generate removed segments video."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
