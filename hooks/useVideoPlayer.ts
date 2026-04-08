"use client";

import { useState, useRef, useEffect, ChangeEvent } from "react";

export function useVideoPlayer() {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(100);
  const [isEditorMode, setIsEditorMode] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);

  // Sync muted state imperatively
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = isMuted;
    }
  }, [isMuted]);

  // Sync volume imperatively
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
    }
  }, [volume]);

  // Create object URL when file changes
  useEffect(() => {
    if (videoFile) {
      const src = URL.createObjectURL(videoFile);
      setVideoSrc(src);
      setIsPlaying(false);
      setCurrentTime(0);
      setTrimStart(0);
      setTrimEnd(100);
      return () => {
        URL.revokeObjectURL(src);
      };
    }
  }, [videoFile]);

  const handleFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type.startsWith("video/")) {
      setVideoFile(file);
    }
  };

  const togglePlay = () => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      const current = videoRef.current.currentTime;
      setCurrentTime(current);

      if (videoRef.current.duration && videoRef.current.duration !== duration) {
        if (videoRef.current.duration !== Infinity) {
          setDuration(videoRef.current.duration);
        }
      }

      if (isEditorMode && duration > 0) {
        const endSeconds = (trimEnd / 100) * duration;
        if (current >= endSeconds && isPlaying) {
          videoRef.current.pause();
          setIsPlaying(false);
        }
      }
    }
  };

  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      setDuration(videoRef.current.duration);
    }
  };

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!progressRef.current || !videoRef.current) return;
    const rect = progressRef.current.getBoundingClientRect();
    const pos = (e.clientX - rect.left) / rect.width;
    const newTime = pos * duration;
    videoRef.current.currentTime = newTime;
    setCurrentTime(newTime);
  };

  const handleVolumeChange = (e: ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    if (val === 0) {
      setIsMuted(true);
    } else if (isMuted) {
      setIsMuted(false);
    }
  };

  const toggleMute = () => {
    const newMutedState = !isMuted;
    setIsMuted(newMutedState);
    if (!newMutedState && volume === 0) {
      setVolume(1);
    }
  };

  const handleTrimStartChange = (e: ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    if (val < trimEnd) {
      setTrimStart(val);
      if (videoRef.current) {
        videoRef.current.currentTime = (val / 100) * duration;
      }
    }
  };

  const handleTrimEndChange = (e: ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    if (val > trimStart) {
      setTrimEnd(val);
    }
  };

  const resetTrim = () => {
    setTrimStart(0);
    setTrimEnd(100);
    if (videoRef.current) {
      videoRef.current.currentTime = 0;
    }
  };

  const clearVideo = () => {
    setVideoSrc(null);
    setVideoFile(null);
  };

  // Load a clipped blob URL into the player (replaces current src)
  const loadClip = (blobUrl: string) => {
    setVideoSrc(blobUrl);
    setIsPlaying(false);
    setCurrentTime(0);
    setTrimStart(0);
    setTrimEnd(100);
    if (videoRef.current) {
      videoRef.current.currentTime = 0;
    }
  };

  const toggleEditorMode = () => setIsEditorMode(!isEditorMode);

  const requestFullscreen = () => {
    if (videoRef.current?.requestFullscreen) {
      videoRef.current.requestFullscreen();
    }
  };

  return {
    // State
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
    // Refs
    videoRef,
    progressRef,
    // Handlers
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
  };
}
