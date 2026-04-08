"use client";

import { useVideoPlayer } from "../hooks/useVideoPlayer";
import VideoUpload from "../components/VideoUpload/VideoUpload";
import VideoPlayer from "../components/VideoPlayer/VideoPlayer";
import TrimEditor from "../components/TrimEditor/TrimEditor";
import Chat from "../components/Chat/Chat";
import ClipVideoTool from "../tools/clipVideo/ClipVideoTool";

export default function VideoEditor() {
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
    loadClip,
    toggleEditorMode,
    requestFullscreen,
  } = useVideoPlayer();

  if (!videoSrc) {
    return <VideoUpload onFileUpload={handleFileUpload} />;
  }

  return (
    <div className="min-h-screen bg-zinc-950 p-4 text-zinc-100 sm:p-8">
      <div className="mx-auto max-w-[1400px]">

        {/* Header */}
        <header className="mb-8 flex items-center justify-between">
          <div className="space-y-1">
            <h1 className="text-3xl font-bold tracking-tight text-white bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">
              Video Editor Toolkit
            </h1>
            <p className="text-sm text-zinc-400">
              Editing: <span className="font-mono text-zinc-300">{videoFile?.name}</span>
            </p>
          </div>
          <button
            onClick={clearVideo}
            className="rounded-full border border-zinc-800 bg-zinc-900 px-5 py-2.5 text-sm font-medium text-zinc-300 transition-all hover:bg-zinc-800 hover:text-white shadow-xl hover:shadow-blue-900/20"
          >
            Upload New
          </button>
        </header>

        {/* Layout Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">

          {/* Left Column — Video + Trim + Clip Tool */}
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
              onEnded={() => { }}
              onProgressClick={handleProgressClick}
              onVolumeChange={handleVolumeChange}
              onToggleMute={toggleMute}
              onToggleEditorMode={toggleEditorMode}
              onRequestFullscreen={requestFullscreen}
            />

            {/* Trim Range sliders */}
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

            {/* Clip Video Tool — always visible once video is loaded */}
          </div>

          {/* Right Column — AI Chat */}
          <div className="lg:col-span-1 h-full lg:h-auto min-h-[500px]">
            <Chat videoFile={videoFile} duration={duration} onClipReady={loadClip} />
          </div>

        </div>
      </div>
    </div>
  );
}