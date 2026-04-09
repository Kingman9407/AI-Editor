"use client";

import React, { useCallback, useState } from "react";
import { useVideoPlayer } from "../hooks/useVideoPlayer";
import VideoUpload from "../components/VideoUpload/VideoUpload";
import VideoPlayer from "../components/VideoPlayer/VideoPlayer";
import TrimEditor from "../components/TrimEditor/TrimEditor";
import Chat from "../components/Chat/Chat";
import SegmentedPreview from "../components/SegmentedPreview/SegmentedPreview";
import EditList from "../components/EditList/EditList";
import ExportPanel from "../components/ExportPanel/ExportPanel";
import { buildKeptSegments, normalizeSegments } from "../utils/segments";
import MediaSidebar from "../components/MediaSidebar/MediaSidebar";
import { PLAN_CONFIGS, PLAN_ORDER, PlanId } from "../utils/plans";

type TokenUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

type TokenSource = "chat" | "audio" | "vision";

export default function VideoEditor() {
  const [planId, setPlanId] = useState<PlanId>("free");
  const planConfig = PLAN_CONFIGS[planId];
  const [exportCounts, setExportCounts] = useState<Record<PlanId, number>>({
    free: 0,
    plus: 0,
    pro: 0,
  });
  const exportCount = exportCounts[planId];
  const handleExportSuccess = useCallback((planUsed: PlanId) => {
    setExportCounts((prev) => ({
      ...prev,
      [planUsed]: prev[planUsed] + 1,
    }));
  }, []);

  const [exporter, setExporter] = useState<
    null | (() => Promise<{ success: boolean; error?: string }>)
  >(null);
  const [tokenUsage, setTokenUsage] = useState({
    total: 0,
    chat: 0,
    audio: 0,
    vision: 0,
  });
  const addTokenUsage = (source: TokenSource, usage?: TokenUsage | null) => {
    if (!usage) return;
    const total =
      typeof usage.total_tokens === "number"
        ? usage.total_tokens
        : (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
    if (!total) return;
    setTokenUsage((prev) => ({
      total: prev.total + total,
      chat: source === "chat" ? prev.chat + total : prev.chat,
      audio: source === "audio" ? prev.audio + total : prev.audio,
      vision: source === "vision" ? prev.vision + total : prev.vision,
    }));
  };
  const {
    videoFile,
    videoSrc,
    isPlaying,
    duration,
    currentTime,
    volume,
    isMuted,
    trimStart,
    trimEnd,
    isEditorMode,
    videoWidth,
    videoHeight,
    audioSegments,
    audioStatus,
    audioError,
    audioProgress,
    videoInsights,
    videoInsightStatus,
    videoInsightError,
    sceneChanges,
    sceneStatus,
    sceneError,
    edits,
    videoRef,
    progressRef,
    handleFileUpload,
    togglePlay,
    handleTimeUpdate,
    handleLoadedMetadata,
    handleProgressClick,
    handleVolumeChange,
    toggleMute,
    handleTrimStartChange,
    handleTrimEndChange,
    resetTrim,
    clearVideo,
    toggleEditorMode,
    requestFullscreen,
    addEdit,
    clearEdits,
    undoLastEdit,
    removeEdit,
    captureFrame,
    seekToTime,
  } = useVideoPlayer({
    onTokenUsage: (source, usage) => addTokenUsage(source, usage),
    analysis: planConfig.analysis,
  });

  const normalizedEdits = normalizeSegments(
    edits.map((edit) => ({ start: edit.start, end: edit.end })),
    duration
  );
  const keptSegments = buildKeptSegments(duration, normalizedEdits);
  const removedSegments = normalizedEdits;

  if (!videoSrc) {
    return <VideoUpload onFileUpload={handleFileUpload} />;
  }

  return (
    <div className="min-h-screen bg-zinc-950 p-4 text-zinc-100 sm:p-8">
      <div className="mx-auto max-w-[1400px]">
        {/* Header */}
        <header className="mb-8 flex items-center justify-between">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wide text-zinc-500">
              <span>Tokens</span>
              <span className="rounded-full border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-zinc-200">
                {tokenUsage.total.toLocaleString()}
              </span>
              <span className="text-zinc-500">Chat</span>
              <span className="font-mono text-zinc-300">
                {tokenUsage.chat.toLocaleString()}
              </span>
              <span className="text-zinc-500">Audio</span>
              <span className="font-mono text-zinc-300">
                {tokenUsage.audio.toLocaleString()}
              </span>
              <span className="text-zinc-500">Vision</span>
              <span className="font-mono text-zinc-300">
                {tokenUsage.vision.toLocaleString()}
              </span>
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-white bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">
              Video Editor Toolkit
            </h1>
            <p className="text-sm text-zinc-400">
              Editing: <span className="font-mono text-zinc-300">{videoFile?.name}</span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center rounded-full border border-zinc-800 bg-zinc-900/70 p-1 shadow-xl">
              {PLAN_ORDER.map((planOption) => {
                const isActive = planOption === planId;
                return (
                  <button
                    key={planOption}
                    type="button"
                    onClick={() => setPlanId(planOption)}
                    className={`rounded-full px-4 py-1.5 text-xs font-semibold uppercase tracking-wide transition ${
                      isActive
                        ? "bg-blue-600 text-white shadow"
                        : "text-zinc-300 hover:text-white"
                    }`}
                  >
                    {PLAN_CONFIGS[planOption].label}
                  </button>
                );
              })}
            </div>
            <button
              onClick={clearVideo}
              className="rounded-full border border-zinc-800 bg-zinc-900 px-5 py-2.5 text-sm font-medium text-zinc-300 transition-all hover:bg-zinc-800 hover:text-white shadow-xl hover:shadow-blue-900/20"
            >
              Upload New
            </button>
          </div>
        </header>

        {/* Layout Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left Column (Video + Trim Editor) - Takes up 2 columns */}
          <div className="lg:col-span-2 flex flex-col gap-6">
            <VideoPlayer
              videoRef={videoRef}
              progressRef={progressRef}
              videoSrc={videoSrc}
              isPlaying={isPlaying}
              duration={duration}
              currentTime={currentTime}
              volume={volume}
              isMuted={isMuted}
              isEditorMode={isEditorMode}
              onTogglePlay={togglePlay}
              onTimeUpdate={handleTimeUpdate}
              onLoadedMetadata={handleLoadedMetadata}
              onEnded={() => {}}
              onProgressClick={handleProgressClick}
              onVolumeChange={handleVolumeChange}
              onToggleMute={toggleMute}
              onToggleEditorMode={toggleEditorMode}
              onRequestFullscreen={requestFullscreen}
            />

            {/* Trim Editor (only shown in editor mode) */}
            {isEditorMode && (
              <TrimEditor
                duration={duration}
                trimStart={trimStart}
                trimEnd={trimEnd}
                onTrimStartChange={handleTrimStartChange}
                onTrimEndChange={handleTrimEndChange}
                onReset={resetTrim}
              />
            )}
          </div>

          {/* Right Column (Sidebar + Chat) - Takes up 1 column */}
          <div className="lg:col-span-1 flex flex-col gap-6">
            <MediaSidebar
              planId={planId}
              videoContext={{
                name: videoFile?.name ?? "unknown",
                type: videoFile?.type ?? "unknown",
                sizeBytes: videoFile?.size ?? 0,
                duration,
                width: videoWidth,
                height: videoHeight,
              }}
              audioSegments={audioSegments}
              audioStatus={audioStatus}
              audioError={audioError}
              audioProgress={audioProgress}
              videoInsights={videoInsights}
              videoInsightStatus={videoInsightStatus}
              videoInsightError={videoInsightError}
              sceneChanges={sceneChanges}
              sceneStatus={sceneStatus}
              sceneError={sceneError}
            />
            <div className="h-full min-h-[500px]">
             <Chat
               planId={planId}
               memoryKey={
                 videoFile
                   ? `${videoFile.name}-${videoFile.size}-${videoFile.lastModified}`
                   : undefined
               }
               videoContext={{
                 name: videoFile?.name ?? "unknown",
                 type: videoFile?.type ?? "unknown",
                 sizeBytes: videoFile?.size ?? 0,
                 duration,
                 width: videoWidth,
                 height: videoHeight,
                 currentTime,
                 trimStart,
                 trimEnd,
                 isEditorMode,
               }}
               captureFrame={captureFrame}
               audioSegments={audioSegments}
               audioStatus={audioStatus}
               audioError={audioError}
               videoInsights={videoInsights}
               sceneChanges={sceneChanges}
              edits={edits}
              onTokenUsage={(usage) => addTokenUsage("chat", usage)}
              onRequestExport={async () => {
                if (!exporter) {
                  return {
                    success: false,
                     error: "Exporter not ready. Click Load FFmpeg & Export once.",
                   };
                 }
                 return exporter();
               }}
               onAddEdit={addEdit}
             />
            </div>
          </div>
        </div>

        <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <SegmentedPreview
            title="Trimmed Preview"
            videoSrc={videoSrc}
            segments={keptSegments}
            emptyLabel="No trims yet. Ask the AI to remove a segment."
          />
          <SegmentedPreview
            title="Removed Preview"
            videoSrc={videoSrc}
            segments={removedSegments}
            emptyLabel="No removed segments yet."
          />
        </div>

        <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <EditList
            edits={edits}
            videoSrc={videoSrc}
            previewSegments={normalizedEdits}
            onSelect={(time) => seekToTime(time, true)}
            onUndoLast={undoLastEdit}
            onRemove={removeEdit}
            onClear={clearEdits}
          />
          <ExportPanel
            videoFile={videoFile}
            keptSegments={keptSegments}
            removedSegments={removedSegments}
            planId={planId}
            exportCount={exportCount}
            onExportSuccess={handleExportSuccess}
            registerExporter={(exporterFn) => setExporter(() => exporterFn)}
          />
        </div>
      </div>
    </div>
  );
}
