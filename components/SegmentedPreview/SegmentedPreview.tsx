import React, { useEffect, useRef, useState } from "react";
import { Play, Pause } from "lucide-react";
import { formatTime } from "../../utils/formatTime";

type Segment = {
  start: number;
  end: number;
};

interface SegmentedPreviewProps {
  title: string;
  videoSrc: string;
  segments: Segment[];
  emptyLabel: string;
}

export default function SegmentedPreview({
  title,
  videoSrc,
  segments,
  emptyLabel,
}: SegmentedPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [segmentIndex, setSegmentIndex] = useState(0);
  const [isFading, setIsFading] = useState(false);
  const transitioningRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [logicalTime, setLogicalTime] = useState(0);

  const totalDuration = segments.reduce((acc, seg) => acc + (seg.end - seg.start), 0);

  useEffect(() => {
    if (!videoRef.current) return;
    if (!segments.length) {
      videoRef.current.pause();
      return;
    }
    setSegmentIndex(0);
    setLogicalTime(0);
    setIsPlaying(false);
    videoRef.current.currentTime = segments[0].start;
  }, [segments]);

  const transitionTo = (nextIndex: number) => {
    const video = videoRef.current;
    if (!video) return;
    transitioningRef.current = true;
    setIsFading(true);
    const nextStart = segments[nextIndex].start;
    setSegmentIndex(nextIndex);
    window.setTimeout(() => {
      if (!videoRef.current) return;
      videoRef.current.currentTime = nextStart;
      window.setTimeout(() => {
        setIsFading(false);
        transitioningRef.current = false;
      }, 160);
    }, 100);
  };

  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video || !segments.length) return;
    if (transitioningRef.current) return;
    const currentSegment = segments[segmentIndex];
    if (!currentSegment) return;
    
    // Compute the logical time elapsed up to the current segment
    let computedTime = 0;
    for (let i = 0; i < segmentIndex; i++) {
        computedTime += segments[i].end - segments[i].start;
    }
    computedTime += Math.max(0, video.currentTime - currentSegment.start);
    setLogicalTime(computedTime);

    if (video.currentTime >= currentSegment.end - 0.05) {
      const nextIndex = segmentIndex + 1;
      if (nextIndex < segments.length) {
        transitionTo(nextIndex);
      } else {
        video.pause();
        setIsPlaying(false);
        setLogicalTime(totalDuration);
      }
    }
  };

  const handlePlay = () => {
    const video = videoRef.current;
    if (!video || !segments.length) return;
    const currentSegment = segments[segmentIndex] ?? segments[0];
    if (
      video.currentTime < currentSegment.start ||
      video.currentTime > currentSegment.end
    ) {
      video.currentTime = currentSegment.start;
    }
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (isPlaying) {
      videoRef.current.pause();
    } else {
      if (logicalTime >= totalDuration - 0.1) {
        setSegmentIndex(0);
        videoRef.current.currentTime = segments[0].start;
      }
      videoRef.current.play();
    }
  };

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!videoRef.current || !segments.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    let targetLogicalTime = percent * totalDuration;
    
    // Map logical time to the correct segment and actual video timestamp
    for (let i = 0; i < segments.length; i++) {
        const segLen = segments[i].end - segments[i].start;
        if (targetLogicalTime <= segLen || i === segments.length - 1) {
            setSegmentIndex(i);
            videoRef.current.currentTime = segments[i].start + targetLogicalTime;
            setLogicalTime(percent * totalDuration);
            break;
        }
        targetLogicalTime -= segLen;
    }
  };

  return (
    <div className="space-y-3 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4 shadow-2xl backdrop-blur-xl">
      <div className="text-sm font-semibold text-zinc-200">{title}</div>
      {segments.length ? (
        <div className="group relative aspect-video w-full overflow-hidden rounded-xl bg-black">
          <video
            ref={videoRef}
            src={videoSrc}
            className={`h-full w-full object-contain transition-opacity duration-300 ${
              isFading ? "opacity-60" : "opacity-100"
            }`}
            onClick={togglePlay}
            onTimeUpdate={handleTimeUpdate}
            onPlay={handlePlay}
            onPlaying={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
          />
          {/* Custom Overlay Controls */}
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-4 opacity-0 transition-opacity duration-300 group-hover:opacity-100">
            <div className="mb-4 flex items-center gap-4">
              <span className="text-xs font-medium text-zinc-300 w-12 text-right">
                {formatTime(logicalTime)}
              </span>
              <div
                className="relative h-1.5 flex-1 cursor-pointer rounded-full bg-white/20"
                onClick={handleProgressClick}
              >
                <div
                  className="absolute left-0 top-0 h-full rounded-full bg-blue-500 transition-all ease-linear"
                  style={{ width: `${totalDuration > 0 ? (logicalTime / totalDuration) * 100 : 0}%` }}
                />
              </div>
              <span className="text-xs font-medium text-zinc-300 w-12">
                {formatTime(totalDuration)}
              </span>
            </div>
            <div className="flex items-center">
              <button onClick={togglePlay} className="text-white hover:text-blue-400 transition-colors">
                {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-zinc-700 bg-zinc-950/60 p-6 text-center text-sm text-zinc-500">
          {emptyLabel}
        </div>
      )}
    </div>
  );
}
