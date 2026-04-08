"use client";

import React, { useState, useRef } from "react";
import { Scissors, Send, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { clipVideo } from "./clipVideo";
import { parseClipCommand } from "./parseClipCommand";

interface ClipVideoToolProps {
  videoFile: File | null;
  duration: number; // total video duration in seconds
}

type Status = "idle" | "clipping" | "done" | "error";

const EXAMPLES = [
  "cut from 0:30 to 1:20",
  "clip 30s to 90s",
  "trim from 1:00 to 2:30",
  "extract 10 to 45",
];

export default function ClipVideoTool({ videoFile, duration }: ClipVideoToolProps) {
  const [command, setCommand] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!videoFile || !command.trim()) return;

    const parsed = parseClipCommand(command);

    if (!parsed.ok) {
      setStatus("error");
      setMessage(parsed.error);
      return;
    }

    const { startSeconds, endSeconds } = parsed;

    // Guard against out-of-range times
    if (duration > 0 && endSeconds > duration) {
      setStatus("error");
      setMessage(
        `End time (${endSeconds}s) exceeds video duration (${duration.toFixed(1)}s).`
      );
      return;
    }

    setStatus("clipping");
    setProgress(0);
    setMessage(`Clipping ${startSeconds}s → ${endSeconds}s…`);

    const result = await clipVideo({
      videoFile,
      startSeconds,
      endSeconds,
      outputName: "clipped_video",
      onProgress: setProgress,
    });

    if (result.success) {
      setStatus("done");
      setMessage(`✓ Saved as "${result.fileName}"`);
      setCommand("");
    } else {
      setStatus("error");
      setMessage(result.error ?? "Something went wrong.");
    }
  };

  const reset = () => {
    setStatus("idle");
    setMessage("");
    setProgress(0);
    inputRef.current?.focus();
  };

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 backdrop-blur-xl space-y-4">

      {/* Header */}
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/10 text-violet-400 ring-1 ring-violet-500/20">
          <Scissors size={15} />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-white">Clip Video</h3>
          <p className="text-[11px] text-zinc-500 leading-tight">Type a command to cut your video</p>
        </div>
      </div>

      {/* Text Input */}
      <form onSubmit={handleSubmit} className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={command}
          onChange={(e) => { setCommand(e.target.value); setStatus("idle"); setMessage(""); }}
          placeholder='e.g. "cut from 0:30 to 1:20"'
          disabled={status === "clipping"}
          className="flex-1 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500 transition-all disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!command.trim() || !videoFile || status === "clipping"}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-600 text-white shadow-lg shadow-violet-900/30 transition-all hover:bg-violet-500 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-violet-600"
        >
          {status === "clipping"
            ? <Loader2 size={16} className="animate-spin" />
            : <Send size={15} />
          }
        </button>
      </form>

      {/* Progress bar */}
      {status === "clipping" && (
        <div className="space-y-1">
          <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-gradient-to-r from-violet-500 to-blue-500 transition-all duration-150"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-right text-[11px] font-mono text-violet-400">{progress}%</p>
        </div>
      )}

      {/* Status message */}
      {message && (
        <div className={`flex items-start gap-2 rounded-xl px-3 py-2.5 text-xs ${
          status === "done"
            ? "border border-emerald-500/20 bg-emerald-500/10 text-emerald-400"
            : status === "error"
            ? "border border-red-500/20 bg-red-500/10 text-red-400"
            : "border border-zinc-800 bg-zinc-800/50 text-zinc-400"
        }`}>
          {status === "done" && <CheckCircle2 size={13} className="mt-0.5 shrink-0" />}
          {status === "error" && <AlertCircle size={13} className="mt-0.5 shrink-0" />}
          <span>{message}</span>
        </div>
      )}

      {status === "done" && (
        <button onClick={reset} className="text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-300 transition-colors">
          Clip another segment
        </button>
      )}

      {/* Example hints */}
      {status === "idle" && !message && (
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wider text-zinc-600 font-medium">Examples</p>
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                onClick={() => { setCommand(ex); inputRef.current?.focus(); }}
                className="rounded-lg border border-zinc-800 bg-zinc-800/50 px-2.5 py-1 text-[11px] font-mono text-zinc-400 transition-colors hover:border-violet-500/40 hover:text-zinc-200"
              >
                {ex}
              </button>
            ))}
          </div>
        </div>
      )}

      {!videoFile && (
        <p className="text-center text-xs text-amber-500/70">⚠️ Upload a video first.</p>
      )}
    </div>
  );
}
