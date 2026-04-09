"use client";

import React, { useMemo, useRef, useState } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import { Segment } from "../../utils/segments";

interface ExportPanelProps {
  videoFile: File | null;
  keptSegments: Segment[];
  removedSegments: Segment[];
  registerExporter?: (
    exporter: () => Promise<{ success: boolean; error?: string }>
  ) => void;
}

const buildFilter = (segments: Segment[]) => {
  const parts: string[] = [];
  segments.forEach((segment, index) => {
    parts.push(
      `[0:v]trim=start=${segment.start}:end=${segment.end},setpts=PTS-STARTPTS[v${index}]`
    );
    parts.push(
      `[0:a]atrim=start=${segment.start}:end=${segment.end},asetpts=PTS-STARTPTS[a${index}]`
    );
  });

  const concatInputs = segments
    .map((_, index) => `[v${index}][a${index}]`)
    .join("");
  parts.push(`${concatInputs}concat=n=${segments.length}:v=1:a=1[outv][outa]`);
  return parts.join(";");
};

export default function ExportPanel({
  videoFile,
  keptSegments,
  removedSegments,
  registerExporter,
}: ExportPanelProps) {
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const videoFileRef = useRef<File | null>(videoFile);
  const keptSegmentsRef = useRef<Segment[]>(keptSegments);
  const removedSegmentsRef = useRef<Segment[]>(removedSegments);
  const isExportingRef = useRef(false);
  const [isReady, setIsReady] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trimmedUrl, setTrimmedUrl] = useState<string | null>(null);
  const [removedUrl, setRemovedUrl] = useState<string | null>(null);

  const canExport = useMemo(
    () => Boolean(videoFile && (keptSegments.length || removedSegments.length)),
    [videoFile, keptSegments.length, removedSegments.length]
  );

  const loadFfmpeg = async () => {
    if (ffmpegRef.current) return;
    const ffmpeg = new FFmpeg();
    const baseURLs = [
      "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm",
      "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm",
    ];
    let lastError: unknown = null;

    for (const baseURL of baseURLs) {
      try {
        await ffmpeg.load({
          coreURL: await toBlobURL(
            `${baseURL}/ffmpeg-core.js`,
            "text/javascript"
          ),
          wasmURL: await toBlobURL(
            `${baseURL}/ffmpeg-core.wasm`,
            "application/wasm"
          ),
          workerURL: await toBlobURL(
            `${baseURL}/ffmpeg-core.worker.js`,
            "text/javascript"
          ),
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

  React.useEffect(() => {
    videoFileRef.current = videoFile;
  }, [videoFile]);

  React.useEffect(() => {
    keptSegmentsRef.current = keptSegments;
  }, [keptSegments]);

  React.useEffect(() => {
    removedSegmentsRef.current = removedSegments;
  }, [removedSegments]);

  const setExportingState = (value: boolean) => {
    isExportingRef.current = value;
    setIsExporting(value);
  };

  const exportVideos = React.useCallback(async () => {
    const currentVideo = videoFileRef.current;
    const currentKept = keptSegmentsRef.current;
    const currentRemoved = removedSegmentsRef.current;

    if (!currentVideo) {
      return { success: false, error: "No video loaded." };
    }
    if (isExportingRef.current) {
      return { success: false, error: "Export already running." };
    }
    if (!currentKept.length && !currentRemoved.length) {
      setError("No segments to export.");
      return { success: false, error: "No segments to export." };
    }

    setError(null);
    setExportingState(true);
    setTrimmedUrl(null);
    setRemovedUrl(null);

    try {
      await loadFfmpeg();
      const ffmpeg = ffmpegRef.current;
      if (!ffmpeg) throw new Error("FFmpeg not ready");

      const inputName = "input.mp4";
      const trimmedOutput = "trimmed.mp4";
      const removedOutput = "removed.mp4";

      await ffmpeg.writeFile(inputName, await fetchFile(currentVideo));

      if (currentKept.length) {
        const keptFilter = buildFilter(currentKept);
        await ffmpeg.exec([
          "-i",
          inputName,
          "-filter_complex",
          keptFilter,
          "-map",
          "[outv]",
          "-map",
          "[outa]",
          trimmedOutput,
        ]);

        const trimmedData = await ffmpeg.readFile(trimmedOutput);
        const trimmedBlob = new Blob([trimmedData], { type: "video/mp4" });
        setTrimmedUrl(URL.createObjectURL(trimmedBlob));
      }

      if (currentRemoved.length) {
        const removedFilter = buildFilter(currentRemoved);
        await ffmpeg.exec([
          "-i",
          inputName,
          "-filter_complex",
          removedFilter,
          "-map",
          "[outv]",
          "-map",
          "[outa]",
          removedOutput,
        ]);

        const removedData = await ffmpeg.readFile(removedOutput);
        const removedBlob = new Blob([removedData], { type: "video/mp4" });
        setRemovedUrl(URL.createObjectURL(removedBlob));
      }
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Export failed";
      setError(message);
      return { success: false, error: message };
    } finally {
      setExportingState(false);
    }
  }, []);

  React.useEffect(() => {
    if (registerExporter) {
      registerExporter(exportVideos);
    }
  }, [registerExporter, exportVideos]);

  return (
    <div className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 shadow-2xl backdrop-blur-xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm font-semibold text-zinc-200">Export</div>
        <button
          type="button"
          onClick={exportVideos}
          disabled={!canExport || isExporting}
          className="rounded-full bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isExporting
            ? "Exporting..."
            : isReady
            ? "Export Trimmed + Removed"
            : "Load FFmpeg & Export"}
        </button>
      </div>

      {error ? <div className="text-xs text-red-400">{error}</div> : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <div className="text-xs font-medium text-zinc-400">Trimmed Export</div>
          {trimmedUrl ? (
            <video
              src={trimmedUrl}
              className="w-full rounded-xl bg-black"
              controls
            />
          ) : (
            <div className="rounded-xl border border-dashed border-zinc-700 bg-zinc-950/60 p-6 text-center text-xs text-zinc-500">
              Export to generate trimmed video.
            </div>
          )}
        </div>
        <div className="space-y-2">
          <div className="text-xs font-medium text-zinc-400">Removed Export</div>
          {removedUrl ? (
            <video
              src={removedUrl}
              className="w-full rounded-xl bg-black"
              controls
            />
          ) : (
            <div className="rounded-xl border border-dashed border-zinc-700 bg-zinc-950/60 p-6 text-center text-xs text-zinc-500">
              Export to generate removed segments video.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
