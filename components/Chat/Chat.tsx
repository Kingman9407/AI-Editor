import React, { useEffect, useMemo, useRef, useState } from "react";
import { Send } from "lucide-react";
import { formatTime } from "../../utils/formatTime";

interface Message {
  id: string;
  text: string;
  sender: "user" | "system";
}

type MessageLike = {
  id?: string | number;
  text: string;
  sender: "user" | "system";
};

interface VideoContext {
  name: string;
  type: string;
  sizeBytes: number;
  duration: number;
  width: number;
  height: number;
  currentTime: number;
  trimStart: number;
  trimEnd: number;
  isEditorMode: boolean;
}

type AudioSegment = {
  start: number;
  end: number;
  transcript: string;
  category: "speech" | "music" | "sfx";
};

type ClipSegment = {
  id: string;
  start: number;
  end: number;
  reason?: string;
};

type SuggestionSegment = {
  start: number;
  end: number;
  note: string;
};

type VideoInsight = {
  time: number;
  description: string;
};

type ModelAction = {
  type?: string;
  start?: number | null;
  end?: number | null;
  clip?: number | null;
  reason?: string | null;
};

type ChatSession = {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
};

interface ChatProps {
  videoContext?: VideoContext;
  captureFrame?: () => string | null;
  audioSegments?: AudioSegment[];
  audioStatus?: "idle" | "processing" | "done" | "error" | "no-audio";
  audioError?: string | null;
  videoInsights?: VideoInsight[];
  sceneChanges?: number[];
  edits?: ClipSegment[];
  memoryKey?: string;
  onRequestExport?: () => Promise<{ success: boolean; error?: string }>;
  onAddEdit?: (segment: { start: number; end: number; reason?: string }) => void;
  onTokenUsage?: (usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null) => void;
}

const createMessageId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const ensureUniqueMessages = (input: MessageLike[]) => {
  const used = new Set<string>();
  return input.map((message) => {
    const rawId =
      typeof message.id === "string" || typeof message.id === "number"
        ? String(message.id)
        : "";
    let nextId = rawId && !used.has(rawId) ? rawId : createMessageId();
    while (used.has(nextId)) {
      nextId = createMessageId();
    }
    used.add(nextId);
    return { ...message, id: nextId };
  });
};

const hasDuplicateMessageIds = (input: Message[]) => {
  const seen = new Set<string>();
  return input.some((message) => {
    if (seen.has(message.id)) return true;
    seen.add(message.id);
    return false;
  });
};

export default function Chat({
  videoContext,
  captureFrame,
  audioSegments = [],
  audioStatus = "idle",
  audioError = null,
  videoInsights = [],
  sceneChanges = [],
  edits = [],
  memoryKey,
  onRequestExport,
  onAddEdit,
  onTokenUsage,
}: ChatProps) {
  const defaultMessages = useMemo<Message[]>(
    () => [
      {
        id: createMessageId(),
        text: "Welcome to the video editor! How can I help you today?",
        sender: "system",
      },
    ],
    []
  );
  const [messages, setMessages] = useState<Message[]>(defaultMessages);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [statusLog, setStatusLog] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<SuggestionSegment[]>([]);
  const allowLocalActions = false;
  const hasLoadedRef = useRef(false);
  const statusScrollRef = useRef<HTMLDivElement | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);

  const timeRegex =
    /\b(\d{1,2}:\d{2}:\d{2}|\d{1,2}:\d{2}|\d+(?:\.\d+)?s)\b/g;
  const editIntentRegex = /\b(trim|cut|remove|delete)\b/i;
  const exportIntentRegex =
    /\b(export|render|combine|download|final\s+video)\b/i;
  const suggestIntentRegex =
    /\b(important|highlight|highlights|timestamp|time\s*stamp|key part|best part|possible trim|suggest)\b/i;
  const suggestionPickRegex =
    /\b(?:trim|cut|remove)\s*(?:option|clip|suggestion)?\s*(\d+)(?!:)\b/i;

  const stopwords = new Set([
    "trim",
    "cut",
    "remove",
    "delete",
    "part",
    "parts",
    "section",
    "segment",
    "show",
    "find",
    "give",
    "tell",
    "timestamp",
    "time",
    "stamp",
    "important",
    "highlight",
    "highlights",
    "key",
    "best",
    "please",
    "this",
    "that",
    "these",
    "those",
    "the",
    "a",
    "an",
    "and",
    "to",
    "for",
    "of",
    "in",
    "on",
    "with",
    "from",
    "at",
    "is",
    "are",
    "be",
    "i",
    "me",
    "my",
    "you",
    "your",
    "we",
    "us",
    "can",
    "could",
    "should",
    "would",
    "want",
    "need",
    "like",
  ]);

  const buildSessionTitle = (sessionMessages: MessageLike[]) => {
    const firstUser = sessionMessages.find((msg) => msg.sender === "user");
    if (!firstUser) return "New chat";
    const text = firstUser.text.trim();
    if (!text) return "New chat";
    return text.split(/\s+/).slice(0, 6).join(" ");
  };

  const createSession = (sessionMessages: MessageLike[]) => {
    const timestamp = Date.now();
    const normalizedMessages = ensureUniqueMessages(sessionMessages);
    return {
      id: `${timestamp}-${Math.random().toString(16).slice(2)}`,
      title: buildSessionTitle(normalizedMessages),
      messages: normalizedMessages,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  };

  useEffect(() => {
    if (!memoryKey) {
      setMessages(defaultMessages);
      setSessions([]);
      setCurrentSessionId(null);
      hasLoadedRef.current = true;
      return;
    }
    if (typeof window === "undefined") return;

    const sessionsKey = `chat:sessions:${memoryKey}`;
    const currentKey = `chat:current:${memoryKey}`;
    const storedSessions = window.localStorage.getItem(sessionsKey);
    const storedCurrent = window.localStorage.getItem(currentKey);

    let nextSessions: ChatSession[] = [];
    if (storedSessions) {
      try {
        const parsed = JSON.parse(storedSessions) as ChatSession[];
        if (Array.isArray(parsed) && parsed.length) {
          nextSessions = parsed.map((session) => {
            const rawMessages = Array.isArray(session.messages)
              ? session.messages
              : [];
            const normalizedMessages = rawMessages.length
              ? ensureUniqueMessages(rawMessages)
              : defaultMessages;
            return {
              ...session,
              messages: normalizedMessages,
            };
          });
        }
      } catch {
        nextSessions = [];
      }
    }

    if (!nextSessions.length) {
      const legacy = window.localStorage.getItem(`chat:${memoryKey}`);
      let legacyMessages = defaultMessages;
      if (legacy) {
        try {
          const parsedLegacy = JSON.parse(legacy) as MessageLike[];
          if (Array.isArray(parsedLegacy) && parsedLegacy.length) {
            legacyMessages = ensureUniqueMessages(parsedLegacy);
          }
        } catch {
          legacyMessages = defaultMessages;
        }
      }
      const initialSession = createSession(legacyMessages);
      nextSessions = [initialSession];
      window.localStorage.setItem(sessionsKey, JSON.stringify(nextSessions));
      window.localStorage.setItem(currentKey, initialSession.id);
    }

    const activeId =
      storedCurrent && nextSessions.some((session) => session.id === storedCurrent)
        ? storedCurrent
        : nextSessions[0].id;
    const activeSession = nextSessions.find((session) => session.id === activeId);
    if (activeSession) {
      setMessages(activeSession.messages);
    } else {
      setMessages(defaultMessages);
    }
    setSessions(nextSessions);
    setCurrentSessionId(activeId);
    hasLoadedRef.current = true;
  }, [memoryKey]);

  useEffect(() => {
    if (!memoryKey || !hasLoadedRef.current || !currentSessionId) return;
    if (typeof window === "undefined") return;
    const sessionsKey = `chat:sessions:${memoryKey}`;
    const currentKey = `chat:current:${memoryKey}`;
    setSessions((prev) => {
      const updated = prev.map((session) => {
        if (session.id !== currentSessionId) return session;
        const nextMessages = messages;
        return {
          ...session,
          messages: nextMessages,
          title: buildSessionTitle(nextMessages),
          updatedAt: Date.now(),
        };
      });
      window.localStorage.setItem(sessionsKey, JSON.stringify(updated));
      window.localStorage.setItem(currentKey, currentSessionId);
      return updated;
    });
  }, [messages, memoryKey, currentSessionId]);

  useEffect(() => {
    if (!messages.length) return;
    if (!hasDuplicateMessageIds(messages)) return;
    setMessages((prev) => ensureUniqueMessages(prev));
  }, [messages]);

  useEffect(() => {
    if (!statusScrollRef.current) return;
    statusScrollRef.current.scrollTop = statusScrollRef.current.scrollHeight;
  }, [statusLog, status]);

  const handleNewChat = () => {
    const session = createSession(defaultMessages);
    setSessions((prev) => [session, ...prev]);
    setCurrentSessionId(session.id);
    setMessages(session.messages);
    setIsHistoryOpen(false);
  };

  const handleSelectSession = (sessionId: string) => {
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) return;
    setCurrentSessionId(session.id);
    setMessages(session.messages);
    setIsHistoryOpen(false);
  };

  const parseTimeToSeconds = (token: string) => {
    if (token.endsWith("s")) {
      return parseFloat(token.slice(0, -1));
    }
    const parts = token.split(":").map(Number);
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    return Number.isFinite(parts[0]) ? parts[0] : null;
  };

  const extractTimeRange = (text: string) => {
    const matches = text.match(timeRegex) ?? [];
    const values = matches
      .map(parseTimeToSeconds)
      .filter((value): value is number => Number.isFinite(value));
    if (values.length >= 2) {
      return { start: values[0], end: values[1] };
    }
    return null;
  };

  const extractRelativeRange = (text: string) => {
    const directionMatch = text.match(/\b(first|last)\b/i);
    if (!directionMatch) return null;
    const direction = directionMatch[1].toLowerCase();
    const timeTokens = text.match(timeRegex) ?? [];
    let seconds: number | null = null;

    if (timeTokens.length >= 1) {
      seconds = parseTimeToSeconds(timeTokens[0]);
    }

    if (!seconds || !Number.isFinite(seconds)) {
      const unitMatch = text.match(
        /\b(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes)\b/i
      );
      if (unitMatch) {
        const amount = parseFloat(unitMatch[1]);
        const unit = unitMatch[2].toLowerCase();
        const multiplier = unit.startsWith("m") ? 60 : 1;
        seconds = amount * multiplier;
      }
    }

    if (!seconds || !Number.isFinite(seconds) || seconds <= 0) {
      return { needsValue: true as const };
    }

    if (direction === "first") {
      return { start: 0, end: seconds };
    }

    const duration = videoContext?.duration ?? 0;
    if (!duration) {
      return { needsDuration: true as const, seconds };
    }

    return {
      start: Math.max(0, duration - seconds),
      end: duration,
    };
  };

  const extractKeywords = (text: string) => {
    const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
    const tokens = normalized.split(/\s+/).filter(Boolean);
    const keywords = tokens.filter(
      (token) => token.length >= 3 && !stopwords.has(token)
    );
    return Array.from(new Set(keywords));
  };

  const countWords = (text: string) =>
    text.trim() ? text.trim().split(/\s+/).length : 0;

  const truncateText = (text: string, maxLength = 90) => {
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 3).trim()}...`;
  };

  const buildSuggestionMessage = (query: string) => {
    if (!audioSegments.length) {
      const currentTime = videoContext?.currentTime;
      const duration = videoContext?.duration ?? 0;
      const trimStartPercent = videoContext?.trimStart ?? 0;
      const trimEndPercent = videoContext?.trimEnd ?? 100;
      const trimStartSeconds =
        duration > 0 ? (trimStartPercent / 100) * duration : null;
      const trimEndSeconds =
        duration > 0 ? (trimEndPercent / 100) * duration : null;

      const lines: string[] = [
        "I do not have audio to scan for highlights yet.",
      ];
      if (audioStatus === "processing") {
        lines.push("Audio analysis is still running.");
      }
      if (audioStatus === "no-audio") {
        lines.push("No audio track detected, so I can only use your playhead.");
      }
      if (Number.isFinite(currentTime)) {
        lines.push(`Current playhead: ${formatTime(currentTime ?? 0)}.`);
      }
      if (trimStartSeconds !== null && trimEndSeconds !== null && duration > 0) {
        lines.push(
          `Current trim range: ${formatTime(trimStartSeconds)}-${formatTime(
            trimEndSeconds
          )}.`
        );
      }
      lines.push(
        "Move the playhead to the moment you want and say 'use current time', or give a timestamp range."
      );
      return { message: lines.join("\n"), segments: [] as SuggestionSegment[] };
    }

    const keywords = extractKeywords(query);
    const keywordMatches = audioSegments
      .map((segment) => {
        const transcript = segment.transcript.toLowerCase();
        const score = keywords.reduce(
          (acc, keyword) => (transcript.includes(keyword) ? acc + 1 : acc),
          0
        );
        return { segment, score };
      })
      .filter((entry) => entry.score > 0);

    let ranked = keywordMatches;
    if (!ranked.length) {
      ranked = audioSegments
        .filter((segment) => segment.transcript.trim())
        .map((segment) => ({
          segment,
          score: countWords(segment.transcript),
        }));
    }

    if (!ranked.length) {
      ranked = audioSegments.map((segment) => ({
        segment,
        score: segment.category === "speech" ? 1 : 0,
      }));
    }

    const sorted = ranked
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.segment.start - b.segment.start;
      })
      .slice(0, 4);

    const suggestedSegments: SuggestionSegment[] = sorted.map(({ segment }) => {
      const baseNote =
        segment.category === "music"
          ? "background music"
          : segment.category === "sfx"
          ? "background sound"
          : "speech";
      const detail = segment.transcript.trim()
        ? truncateText(segment.transcript.trim())
        : baseNote;
      return {
        start: segment.start,
        end: segment.end,
        note: detail,
      };
    });

    const header = keywords.length
      ? `Possible matches for "${keywords.join(" ")}":`
      : "Possible trim points from the transcript:";
    const lines = suggestedSegments.map(
      (segment, index) =>
        `${index + 1}. ${formatTime(segment.start)}-${formatTime(
          segment.end
        )} - ${segment.note}`
    );
    lines.push(
      "Reply with 'trim 1' to cut one, or send a custom time range."
    );

    return { message: [header, ...lines].join("\n"), segments: suggestedSegments };
  };

  const pushSystemMessage = (text: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: createMessageId(),
        text,
        sender: "system",
      },
    ]);
  };

  const pushStatus = (text: string) => {
    setStatus(text);
    setStatusLog((prev) => {
      const next = prev[prev.length - 1] === text ? prev : [...prev, text];
      return next.slice(-18);
    });
  };

  const applyActionsFromJson = (actions: ModelAction[] | undefined | null) => {
    if (!actions?.length || !onAddEdit) return 0;
    let applied = 0;
    actions.forEach((action) => {
      const actionType = (action?.type ?? "").toLowerCase();
      if (!["trim", "cut", "remove", "delete"].includes(actionType)) return;
      const start = Number(action?.start);
      const end = Number(action?.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return;
      if (start >= end) return;
      onAddEdit({
        start,
        end,
        reason: action?.reason ?? `AI ${actionType}`,
      });
      applied += 1;
    });
    return applied;
  };

  const handleExportRequest = async () => {
    if (!onRequestExport) {
      pushSystemMessage(
        "Export isn't ready yet. Please use the Export panel button once to load it."
      );
      return;
    }
    pushSystemMessage("Starting export...");
    pushStatus("Starting export...");
    const result = await onRequestExport();
    if (result?.success) {
      const note =
        edits.length > 0
          ? "Export complete. Use the Removed Export panel for the collected clips."
          : "Export complete. Check the Export panel for the video.";
      pushSystemMessage(note);
    } else {
      pushSystemMessage(
        `Export failed: ${result?.error ?? "Unknown error"}`
      );
    }
    setStatus(null);
  };

  const buildAudioSummary = () => {
    if (!audioSegments.length) {
      if (audioStatus === "no-audio") {
        return "No audio track detected. Relying on visual frames.";
      }
      if (audioStatus === "processing") {
        return "Audio transcription is processing.";
      }
      if (audioStatus === "error") {
        return `Audio transcription failed: ${audioError ?? "unknown error"}`;
      }
      return "";
    }

    const speechSegments = audioSegments.filter(
      (segment) => segment.category === "speech"
    );
    const musicSegments = audioSegments.filter(
      (segment) => segment.category === "music"
    );
    const sfxSegments = audioSegments.filter(
      (segment) => segment.category === "sfx"
    );

    const formatSegments = (segments: AudioSegment[]) =>
      segments.map((segment) => {
        const range = `${formatTime(segment.start)}-${formatTime(segment.end)}`;
        if (segment.category === "music") {
          return `${range} music`;
        }
        if (segment.category === "sfx") {
          return `${range} background sound`;
        }
        const text = segment.transcript.trim() || "speech";
        return `${range} ${text}`;
      });

    const speechLines = formatSegments(speechSegments);
    const musicLines = formatSegments(musicSegments);
    const sfxLines = formatSegments(sfxSegments);

    const sections: string[] = [];
    if (speechLines.length) {
      sections.push("Speech:", ...speechLines);
    }
    if (musicLines.length) {
      sections.push("Music:", ...musicLines);
    }
    if (sfxLines.length) {
      sections.push("Background sounds:", ...sfxLines);
    }
    return sections.join("\n");
  };

  const buildClipSummary = () => {
    if (!edits.length) return "";
    return edits.map((edit, index) => {
      const overlapping = audioSegments.filter(
        (segment) => segment.end >= edit.start && segment.start <= edit.end
      );
      const audioNotes = overlapping.map((segment) => {
        if (segment.category === "music") {
          return `${formatTime(segment.start)}-${formatTime(segment.end)} music`;
        }
        if (segment.category === "sfx") {
          return `${formatTime(segment.start)}-${formatTime(
            segment.end
          )} background`;
        }
        const text = segment.transcript.trim() || "speech";
        return `${formatTime(segment.start)}-${formatTime(segment.end)} ${text}`;
      });
      const reason = edit.reason ? `Reason: ${edit.reason}` : "Reason: user request";
      const audioLine = audioNotes.length
        ? ` Audio: ${audioNotes.join(" | ")}`
        : "";
      return `Clip ${index + 1}: ${formatTime(edit.start)}-${formatTime(
        edit.end
      )}. ${reason}.${audioLine}`;
    }).join("\n");
  };

  const buildVisualSummary = () => {
    const lines: string[] = [];
    if (videoInsights.length) {
      lines.push(
        "Visual scenes:",
        ...videoInsights.map(
          (insight) => `${formatTime(insight.time)} ${insight.description}`
        )
      );
    }
    if (sceneChanges.length) {
      lines.push(
        "Scene changes:",
        sceneChanges.map((time) => formatTime(time)).join(", ")
      );
    }
    return lines.join("\n");
  };

  const submitMessage = async (text: string) => {
    if (!text.trim()) return;

    const userMessage: Message = {
      id: createMessageId(),
      text,
      sender: "user",
    };

    setMessages((prev) => [...prev, userMessage]);
    const currentInput = text;
    setInput("");
    setStatusLog([]);

    if (exportIntentRegex.test(currentInput)) {
      if (!edits.length) {
        pushSystemMessage("No clips collected yet to export.");
        return;
      }
      await handleExportRequest();
      return;
    }

    if (allowLocalActions && editIntentRegex.test(currentInput)) {
      const pickMatch = currentInput.match(suggestionPickRegex);
      if (pickMatch && suggestions.length) {
        const index = Number.parseInt(pickMatch[1], 10) - 1;
        const suggestion = suggestions[index];
        if (suggestion) {
          onAddEdit?.({
            start: suggestion.start,
            end: suggestion.end,
            reason: `Trim suggestion ${index + 1}`,
          });
          pushSystemMessage(
            `Trim queued: ${formatTime(suggestion.start)}-${formatTime(
              suggestion.end
            )}.`
          );
          setSuggestions([]);
          return;
        }
      }

      const timeRange = extractTimeRange(currentInput);
      const relativeRange = extractRelativeRange(currentInput);
      const useTrimRange =
        /use (current )?trim|use trim range/i.test(currentInput);

      if (!timeRange && !useTrimRange && !relativeRange) {
        const suggestionResult = buildSuggestionMessage(currentInput);
        pushSystemMessage(suggestionResult.message);
        setSuggestions(suggestionResult.segments);
        return;
      }

      if (relativeRange && "needsDuration" in relativeRange) {
        pushSystemMessage(
          "I can remove the last part once the video duration is loaded. Please wait for metadata or press play once."
        );
        return;
      }

      if (relativeRange && "needsValue" in relativeRange) {
        pushSystemMessage(
          "Tell me how many seconds or minutes to remove, like first 30 seconds or last 10 seconds."
        );
        return;
      }

      let start = timeRange?.start ?? 0;
      let end = timeRange?.end ?? 0;

      if (relativeRange && "start" in relativeRange) {
        start = relativeRange.start;
        end = relativeRange.end;
      } else if (useTrimRange && videoContext?.duration) {
        const safeTrimStart = videoContext?.trimStart ?? 0;
        const safeTrimEnd = videoContext?.trimEnd ?? 100;
        start = (safeTrimStart / 100) * videoContext.duration;
        end = (safeTrimEnd / 100) * videoContext.duration;
      }

      if (Number.isFinite(start) && Number.isFinite(end) && start < end) {
        onAddEdit?.({
          start,
          end,
          reason: currentInput,
        });
        pushSystemMessage(`Trim queued: ${formatTime(start)}-${formatTime(end)}.`);
        return;
      } else {
        pushSystemMessage(
          "I still need a valid time range. Please send a range like 00:12-00:18, or use the trim sliders and say use current trim range."
        );
        return;
      }
    }

    if (allowLocalActions && suggestIntentRegex.test(currentInput)) {
      const suggestionResult = buildSuggestionMessage(currentInput);
      pushSystemMessage(suggestionResult.message);
      setSuggestions(suggestionResult.segments);
      return;
    }

    const historyForModel = [...messages, userMessage].map((msg) => ({
      role: msg.sender === "user" ? "user" : "assistant",
      content: msg.text,
    }));

    pushStatus(
      `Got it — checking "${truncateText(currentInput, 60)}"...`
    );
    try {
      const trimmedDuration = videoContext?.duration ?? 0;
      const safeTrimStart = videoContext?.trimStart ?? 0;
      const safeTrimEnd = videoContext?.trimEnd ?? 100;
      const trimStartSeconds =
        trimmedDuration > 0 ? (safeTrimStart / 100) * trimmedDuration : 0;
      const trimEndSeconds =
        trimmedDuration > 0 ? (safeTrimEnd / 100) * trimmedDuration : 0;

      pushStatus("Reviewing the timeline and trim range...");
      if (audioSegments.length) {
        pushStatus("Scanning speech, music, and background sounds...");
      } else if (audioStatus === "processing") {
        pushStatus("Audio is still processing — using visuals for now...");
      } else if (audioStatus === "no-audio") {
        pushStatus("No audio track detected — using visuals only...");
      }

      pushStatus("Capturing the current frame...");
      const frameDataUrl =
        videoContext && captureFrame ? captureFrame() : null;
      pushStatus("Summarizing audio + visuals...");
      const audioSummary = buildAudioSummary();
      const clipSummary = buildClipSummary();
      const visualSummary = buildVisualSummary();

      pushStatus("Sending context to the AI...");

      const requestBody = {
        message: currentInput,
        history: historyForModel,
        video: videoContext
          ? {
              name: videoContext.name,
              type: videoContext.type,
              sizeBytes: videoContext.sizeBytes,
              duration: videoContext.duration,
              width: videoContext.width,
              height: videoContext.height,
              currentTime: videoContext.currentTime,
              trimStartSeconds,
              trimEndSeconds,
              isEditorMode: videoContext.isEditorMode,
            }
          : undefined,
        frame: frameDataUrl,
        audio: audioSummary
          ? {
              status: audioStatus,
              summary: audioSummary,
              error: audioError,
            }
          : undefined,
        visual: visualSummary
          ? {
              summary: visualSummary,
            }
          : undefined,
        clips: clipSummary
          ? {
              summary: clipSummary,
            }
          : undefined,
      };

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      const data = await res.json();

      if (!res.ok) {
        const errorMessage =
          data?.error?.message || `Request failed (${res.status})`;
        throw new Error(errorMessage);
      }

      if (data?.usage) {
        onTokenUsage?.(data.usage);
      }

      pushStatus("Parsing the AI response...");

      const aiText =
        data?.assistantMessage ||
        data?.parsed?.assistant_message ||
        data?.parsed?.follow_up ||
        data?.choices?.[0]?.message?.content ||
        "No response from AI";

      const parsedActions = data?.parsed?.actions;
      const appliedCount = applyActionsFromJson(parsedActions);
      if (appliedCount > 0) {
        pushStatus(`Applying ${appliedCount} edit${appliedCount > 1 ? "s" : ""}...`);
        pushSystemMessage(
          `Applied ${appliedCount} edit${appliedCount > 1 ? "s" : ""} from AI.`
        );
      }

      if (parsedActions?.some((action) =>
        ["export", "render", "combine"].includes(
          (action?.type ?? "").toLowerCase()
        )
      )) {
        pushStatus("Starting export...");
        await handleExportRequest();
      }

      const botMessage: Message = {
        id: createMessageId(),
        text: aiText,
        sender: "system",
      };

      setMessages((prev) => [...prev, botMessage]);
      pushStatus("Ready. Waiting for your next instruction.");
    } catch (error) {
      console.error(error);
      const errorText =
        error instanceof Error ? error.message : "Error connecting to AI";

      setMessages((prev) => [
        ...prev,
        {
          id: createMessageId(),
          text: `Error: ${errorText}`,
          sender: "system",
        },
      ]);
    } finally {
      setStatus(null);
    }
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    void submitMessage(input);
  };

  const buildSegmentNote = (segment: AudioSegment) => {
    if (segment.category === "music") return "music";
    if (segment.category === "sfx") return "background sound";
    const text = segment.transcript.trim();
    return text ? truncateText(text, 80) : "speech";
  };

  const buildQuickPrompt = (segment: AudioSegment) => {
    const range = `${formatTime(segment.start)}-${formatTime(segment.end)}`;
    const note = buildSegmentNote(segment);
    return `Explain what happens in ${range} (${note}).`;
  };

  return (
    <div className="flex h-full min-h-[500px] flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/50 backdrop-blur-xl shadow-2xl">
      {/* Header */}
      <div className="border-b border-zinc-800 bg-zinc-950/50 px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500"></span>
            </span>
            AI Assistant
          </h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsHistoryOpen((prev) => !prev)}
              className="inline-flex items-center gap-2 rounded-full border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-blue-500 hover:text-white"
            >
              <span className="flex flex-col gap-0.5">
                <span className="h-0.5 w-4 rounded-full bg-zinc-400"></span>
                <span className="h-0.5 w-4 rounded-full bg-zinc-400"></span>
                <span className="h-0.5 w-4 rounded-full bg-zinc-400"></span>
              </span>
              History
            </button>
            <button
              type="button"
              onClick={handleNewChat}
              className="rounded-full border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-emerald-400 hover:text-white"
            >
              New Chat
            </button>
          </div>
        </div>
      </div>

      {isHistoryOpen ? (
        <div className="border-b border-zinc-800 bg-zinc-950/40 px-4 py-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Chat History
          </div>
          <div className="mt-2 max-h-40 space-y-2 overflow-y-auto text-xs text-zinc-300">
            {sessions.length ? (
              sessions.map((session) => {
                const isActive = session.id === currentSessionId;
                const updated = new Date(session.updatedAt).toLocaleString();
                return (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => handleSelectSession(session.id)}
                    className={`flex w-full flex-col rounded-xl border px-3 py-2 text-left transition ${
                      isActive
                        ? "border-blue-500 bg-blue-500/10 text-zinc-100"
                        : "border-zinc-800 bg-zinc-950/60 hover:border-blue-500"
                    }`}
                  >
                    <span className="text-sm font-semibold text-zinc-200">
                      {session.title}
                    </span>
                    <span className="text-[11px] text-zinc-400">
                      {updated}
                    </span>
                  </button>
                );
              })
            ) : (
              <div className="rounded-xl border border-dashed border-zinc-700 bg-zinc-950/60 p-4 text-center text-xs text-zinc-500">
                No chat history yet.
              </div>
            )}
          </div>
        </div>
      ) : null}

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${
              msg.sender === "user" ? "justify-end" : "justify-start"
            }`}
          >
            <div
              className={`max-w-[80%] whitespace-pre-line rounded-2xl px-4 py-3 text-sm shadow-sm transition-all animate-in fade-in slide-in-from-bottom-2 ${
                msg.sender === "user"
                  ? "bg-blue-600 justify-end text-white rounded-tr-none"
                  : "bg-zinc-800 text-zinc-200 rounded-tl-none border border-zinc-700/50"
              }`}
            >
              {msg.text}
            </div>
          </div>
        ))}
        {status || statusLog.length ? (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-2xl border border-zinc-700/60 bg-zinc-800/70 px-4 py-3 text-xs text-zinc-300 shadow-sm">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
                AI Progress
              </div>
              <div
                ref={statusScrollRef}
                className="mt-2 max-h-32 space-y-1 overflow-y-auto pr-2 text-[11px] text-zinc-400"
              >
                {statusLog.map((line, index) => {
                  const isLatest = index === statusLog.length - 1 && status;
                  return (
                    <div
                      key={`${line}-${index}`}
                      className={isLatest ? "text-zinc-200 animate-pulse" : ""}
                    >
                      {line}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* Segment Highlights */}
      {audioSegments.length ? (
        <div className="border-t border-zinc-800 bg-zinc-950/40 px-4 py-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Segment Highlights
          </div>
          <div className="mt-2 max-h-32 space-y-2 overflow-y-auto text-xs text-zinc-300">
            {audioSegments.map((segment, index) => {
              const range = `${formatTime(segment.start)}-${formatTime(
                segment.end
              )}`;
              const note = buildSegmentNote(segment);
              return (
                <div
                  key={`${segment.start}-${segment.end}-${index}`}
                  className="flex items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="text-zinc-200">{range}</div>
                    <div className="text-[11px] text-zinc-400">{note}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void submitMessage(buildQuickPrompt(segment))}
                    className="shrink-0 rounded-full border border-zinc-700 bg-zinc-800 px-3 py-1 text-[11px] text-zinc-200 hover:bg-zinc-700"
                  >
                    Ask AI
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* Input Area */}
      <div className="border-t border-zinc-800 bg-zinc-950/50 p-4">
        <form onSubmit={handleSend} className="relative flex items-center">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message..."
            className="w-full rounded-full border border-zinc-700 bg-zinc-900 py-3 pl-5 pr-12 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-all"
          />
          <button
            type="submit"
            disabled={!input.trim()}
            className="absolute right-2 flex h-9 w-9 items-center justify-center rounded-full bg-blue-600 text-white transition-colors hover:bg-blue-500 disabled:opacity-50 disabled:hover:bg-blue-600"
          >
            <Send size={16} />
          </button>
        </form>
      </div>
    </div>
  );
}
