"use client";

import React, { useState, useRef, useCallback, useEffect } from "react";
import { Send, Loader2, CheckCircle2, AlertCircle, Scissors } from "lucide-react";
import { clipVideo, getFFmpeg } from "../../tools/clipVideo/clipVideo";

interface Message {
  id: number;
  role: "user" | "ai";
  text?: string;
  clipData?: {
    startSeconds: number;
    endSeconds: number;
    explanation: string;
  };
}

interface ChatProps {
  videoFile: File | null;
  duration: number;
  onClipReady?: (blobUrl: string) => void;
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

const HINTS = [
  { label: "cut 0:30 → 1:20", value: "cut from 0:30 to 1:20" },
  { label: "first 30s", value: "clip the first 30 seconds" },
  { label: "last 45s", value: "trim the last 45 seconds" },
  { label: "1:00 → 2:30", value: "extract from 1:00 to 2:30" },
];

function ClipCard({
  startSeconds,
  endSeconds,
  explanation,
  videoFile,
  duration,
  onDone,
  onClipReady,
}: {
  startSeconds: number;
  endSeconds: number;
  explanation: string;
  videoFile: File;
  duration: number;
  onDone: (fileName: string) => void;
  onClipReady?: (blobUrl: string) => void;
}) {
  const [status, setStatus] = useState<"clipping" | "done" | "error">("clipping");
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");
  const hasStarted = useRef(false);

  // Auto-start clipping as soon as the card mounts
  useEffect(() => {
    if (hasStarted.current) return;
    hasStarted.current = true;

    (async () => {
      if (endSeconds > duration + 0.5) {
        setStatus("error");
        setErrorMsg(`End time (${formatTime(endSeconds)}) exceeds video duration (${formatTime(duration)}).`);
        return;
      }

      const result = await clipVideo({
        videoFile,
        startSeconds,
        endSeconds,
        outputName: "clipped_video",
        onProgress: setProgress,
      });

      if (result.success && result.fileName) {
        setStatus("done");
        if (result.blobUrl) onClipReady?.(result.blobUrl);
        onDone(result.fileName);
      } else {
        setStatus("error");
        setErrorMsg(result.error ?? "Something went wrong.");
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mt-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-800 dark:bg-emerald-950/40">
      <p className="mb-2 text-xs font-medium text-emerald-700 dark:text-emerald-400">
        {explanation}
      </p>

      <div className="mb-3 flex items-center gap-2 font-mono text-sm text-emerald-900 dark:text-emerald-100">
        <span>{formatTime(startSeconds)}</span>
        <span className="text-emerald-500">→</span>
        <span>{formatTime(endSeconds)}</span>
        <span className="ml-1 text-xs text-emerald-600 dark:text-emerald-400">
          ({formatTime(endSeconds - startSeconds)})
        </span>
      </div>

      {/* Auto-processing progress */}
      {status === "clipping" && (
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400 mb-1">
            <Loader2 size={11} className="animate-spin shrink-0" />
            <span>{progress < 20 ? "Loading FFmpeg engine…" : "Applying changes to video…"}</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-emerald-200 dark:bg-emerald-800">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-right font-mono text-xs text-emerald-600">{progress}%</p>
        </div>
      )}

      {status === "error" && (
        <div className="flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400">
          <AlertCircle size={12} className="shrink-0" />
          {errorMsg}
        </div>
      )}

      {status === "done" && (
        <div className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 size={13} />
          Done — video updated in player
        </div>
      )}
    </div>
  );
}

export default function Chat({ videoFile, duration, onClipReady }: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 1,
      role: "ai",
      text: "Upload a video then tell me what to clip — e.g. 'cut from 0:30 to 1:20' or 'trim the last 45 seconds'.",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [ffmpegStatus, setFfmpegStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [ffmpegProgress, setFfmpegProgress] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // WebCodecs is built into the browser — mark ready as soon as a video is loaded
  useEffect(() => {
    if (!videoFile) return;
    const supported = typeof VideoEncoder !== "undefined" && typeof AudioEncoder !== "undefined";
    setFfmpegStatus(supported ? "ready" : "error");
    setFfmpegProgress(100);
  }, [videoFile]);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
  }, []);

  const send = async (text: string) => {
    if (!text.trim() || loading) return;

    const userMsg: Message = { id: Date.now(), role: "user", text };
    setMessages((p) => [...p, userMsg]);
    setInput("");
    setLoading(true);
    scrollToBottom();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, videoDuration: duration }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error ?? "API error");
      }

      // Check for tool_use block first
      const toolUse = data.content?.find(
        (b: { type: string; name?: string }) => b.type === "tool_use" && b.name === "clip_video"
      );
      const textBlock = data.content?.find(
        (b: { type: string }) => b.type === "text"
      );

      if (toolUse) {
        const { startSeconds, endSeconds, explanation } = toolUse.input;
        setMessages((p) => [
          ...p,
          {
            id: Date.now() + 1,
            role: "ai",
            clipData: { startSeconds, endSeconds, explanation },
          },
        ]);
      } else if (textBlock) {
        setMessages((p) => [
          ...p,
          { id: Date.now() + 1, role: "ai", text: textBlock.text },
        ]);
      } else {
        setMessages((p) => [
          ...p,
          {
            id: Date.now() + 1,
            role: "ai",
            text: "I couldn't understand that. Try: 'cut from 0:30 to 1:20'.",
          },
        ]);
      }
    } catch (e) {
      setMessages((p) => [
        ...p,
        { id: Date.now() + 1, role: "ai", text: "⚠️ Error connecting to AI." },
      ]);
      console.error(e);
    } finally {
      setLoading(false);
      scrollToBottom();
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    send(input);
  };

  return (
    <div className="flex h-full min-h-[500px] flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      {/* Header */}
      <div className="flex items-center gap-2.5 border-b border-zinc-200 bg-zinc-50 px-5 py-3.5 dark:border-zinc-800 dark:bg-zinc-950">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
        </span>
        <h2 className="text-sm font-medium text-zinc-800 dark:text-zinc-100">
          AI clip assistant
        </h2>
      </div>

      {/* FFmpeg loading banner */}
      {ffmpegStatus === "loading" && (
        <div className="mx-4 mt-3 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2.5 dark:border-blue-800 dark:bg-blue-950/40">
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <div className="flex items-center gap-1.5 text-blue-600 dark:text-blue-400">
              <Loader2 size={11} className="animate-spin shrink-0" />
              <span>Loading FFmpeg engine…</span>
            </div>
            <span className="font-mono text-blue-500">{ffmpegProgress}%</span>
          </div>
          <div className="h-1 w-full overflow-hidden rounded-full bg-blue-200 dark:bg-blue-800">
            <div
              className="h-full rounded-full bg-blue-500 transition-all duration-300"
              style={{ width: `${ffmpegProgress}%` }}
            />
          </div>
        </div>
      )}
      {ffmpegStatus === "ready" && ffmpegProgress === 100 && (
        <div className="mx-4 mt-3 flex items-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-600 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-400">
          <CheckCircle2 size={11} />
          FFmpeg ready — clips will process instantly
        </div>
      )}
      {ffmpegStatus === "error" && (
        <div className="mx-4 mt-3 flex items-center gap-1.5 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400">
          <AlertCircle size={11} />
          FFmpeg failed to load. Clips may be slow.
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex gap-2 items-start ${msg.role === "user" ? "flex-row-reverse" : ""}`}
          >
            <div
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-medium ${msg.role === "user"
                ? "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300"
                : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300"
                }`}
            >
              {msg.role === "user" ? "You" : "AI"}
            </div>

            <div
              className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${msg.role === "user"
                ? "rounded-tr-sm bg-blue-600 text-white"
                : "rounded-tl-sm border border-zinc-200 bg-zinc-50 text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                }`}
            >
              {msg.text && <p>{msg.text}</p>}

              {msg.clipData && videoFile && (
                <ClipCard
                  {...msg.clipData}
                  videoFile={videoFile}
                  duration={duration}
                  onClipReady={onClipReady}
                  onDone={(fileName) => {
                    setMessages((p) => [
                      ...p,
                      {
                        id: Date.now(),
                        role: "ai",
                        text: `Saved as "${fileName}". Want to clip another segment?`,
                      },
                    ]);
                    scrollToBottom();
                  }}
                />
              )}

              {msg.clipData && !videoFile && (
                <p className="mt-1 text-xs text-amber-500">⚠️ Upload a video first.</p>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex gap-2 items-start">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300">
              AI
            </div>
            <div className="rounded-2xl rounded-tl-sm border border-zinc-200 bg-zinc-50 px-3.5 py-3 dark:border-zinc-700 dark:bg-zinc-800">
              <div className="flex gap-1">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="block h-1.5 w-1.5 rounded-full bg-zinc-400 animate-bounce"
                    style={{ animationDelay: `${i * 0.15}s` }}
                  />
                ))}
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Hint chips */}
      {!loading && (
        <div className="flex flex-wrap gap-1.5 px-4 pb-2">
          {HINTS.map((h) => (
            <button
              key={h.value}
              onClick={() => send(h.value)}
              disabled={!videoFile}
              className="rounded-full border border-zinc-300 bg-zinc-100 px-2.5 py-1 text-[11px] font-mono text-zinc-500 transition-colors hover:border-emerald-400 hover:text-emerald-700 disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400"
            >
              {h.label}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div className="border-t border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950">
        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={loading}
            placeholder='e.g. "cut from 0:30 to 1:20" or ask a question...'
            className="flex-1 rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
          <button
            type="submit"
            disabled={!input.trim() || loading}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? <Loader2 size={15} className="animate-spin" /> : <Send size={14} />}
          </button>
        </form>
      </div>
    </div>
  );
}