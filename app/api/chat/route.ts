type VideoContext = {
  name?: string;
  type?: string;
  sizeBytes?: number;
  duration?: number;
  width?: number;
  height?: number;
  currentTime?: number;
  trimStartSeconds?: number;
  trimEndSeconds?: number;
  isEditorMode?: boolean;
};

type AudioContext = {
  status?: string;
  summary?: string;
  error?: string | null;
};

type ClipContext = {
  summary?: string;
};

type VisualContext = {
  summary?: string;
};

type HistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

type ModelAction = {
  type: string;
  start?: number | null;
  end?: number | null;
  clip?: number | null;
  reason?: string | null;
};

type ModelJson = {
  assistant_message: string;
  status: "ok" | "needs_info" | "error";
  follow_up?: string | null;
  actions?: ModelAction[];
};

type UsageTotals = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

type FormatResult = {
  content: string;
  parsed: ModelJson | null;
  usage: UsageTotals | null;
};

function parseModelJson(value: string): ModelJson | null {
  try {
    return JSON.parse(value) as ModelJson;
  } catch {
    const match = value.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as ModelJson;
    } catch {
      return null;
    }
  }
}

function parseTimestampToSeconds(token: string): number | null {
  const parts = token.split(":").map(Number);
  if (!parts.length || parts.some((part) => Number.isNaN(part))) return null;
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return parts[0];
}

function extractRangeFromText(text: string) {
  const matches = text.match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g) ?? [];
  if (matches.length < 2) return null;
  const start = parseTimestampToSeconds(matches[0]);
  const end = parseTimestampToSeconds(matches[1]);
  if (start === null || end === null || start >= end) return null;
  return { start, end };
}

function findLastRangeFromHistory(history?: HistoryMessage[]) {
  if (!history?.length) return null;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const text = history[i]?.content ?? "";
    const range = extractRangeFromText(text);
    if (range) return range;
  }
  return null;
}

async function formatToJson({
  raw,
  userMessage,
  videoDuration,
}: {
  raw: string;
  userMessage?: string;
  videoDuration?: number;
}): Promise<FormatResult> {
  const response = await fetch(
    "https://integrate.api.nvidia.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "nvidia/nemotron-3-super-120b-a12b",
        messages: [
          {
            role: "system",
            content:
              "Convert the input into strict JSON only using this schema: " +
              '{"assistant_message": string, "status": "ok"|"needs_info"|"error", "follow_up": string|null, "actions": [{"type": string, "start": number|null, "end": number|null, "clip": number|null, "reason": string|null}]}. ' +
              "Do not add any extra keys. If no actions are needed, use an empty array. Never invent timestamps.",
          },
          {
            role: "user",
            content:
              `User request: ${userMessage ?? ""}\n` +
              `Video duration (seconds): ${videoDuration ?? ""}\n` +
              `Assistant response: ${raw}`,
          },
        ],
        max_tokens: 512,
        temperature: 0,
        top_p: 0.1,
        chat_template_kwargs: { enable_thinking: false },
      }),
    }
  );

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content ?? "";
  const parsed = parseModelJson(content);
  return { content, parsed, usage: data?.usage ?? null };
}

function formatSeconds(value: number) {
  return `${value.toFixed(2)}s`;
}

async function describeFrame(frameDataUrl: string) {
  const response = await fetch(
    "https://integrate.api.nvidia.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "microsoft/phi-4-multimodal-instruct",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "Describe this video frame for editing. Focus on people, actions, objects, and setting.",
              },
              {
                type: "image_url",
                image_url: {
                  url: frameDataUrl,
                },
              },
            ],
          },
        ],
        max_tokens: 256,
        temperature: 0.2,
        top_p: 0.9,
      }),
    }
  );

  const data = await response.json();
  if (!response.ok) {
    const message = data?.error?.message || "Vision model request failed";
    throw new Error(message);
  }

  return {
    description: data?.choices?.[0]?.message?.content as string | undefined,
    usage: data?.usage ?? null,
  };
}

export async function POST(req: Request) {
  const { message, video, frame, audio, visual, clips, history } = (await req.json()) as {
    message?: string;
    video?: VideoContext;
    frame?: string | null;
    audio?: AudioContext;
    visual?: VisualContext;
    clips?: ClipContext;
    history?: HistoryMessage[];
  };

  const editIntentRegex = /\b(trim|cut|remove|delete)\b/i;
  const explicitRange = message ? extractRangeFromText(message) : null;
  const lastRange = findLastRangeFromHistory(history);
  const effectiveRange =
    explicitRange ?? (message && editIntentRegex.test(message) ? lastRange : null);
  const usageTotals: Required<UsageTotals> = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  const addUsage = (usage: UsageTotals | null | undefined) => {
    if (!usage) return;
    if (typeof usage.prompt_tokens === "number") {
      usageTotals.prompt_tokens += usage.prompt_tokens;
    }
    if (typeof usage.completion_tokens === "number") {
      usageTotals.completion_tokens += usage.completion_tokens;
    }
    if (typeof usage.total_tokens === "number") {
      usageTotals.total_tokens += usage.total_tokens;
    }
  };

  const contextLines: string[] = [];
  if (video?.name) contextLines.push(`File: ${video.name}`);
  if (video?.type) contextLines.push(`Type: ${video.type}`);
  if (typeof video?.sizeBytes === "number" && video.sizeBytes > 0) {
    const sizeMb = video.sizeBytes / (1024 * 1024);
    contextLines.push(`Size: ${sizeMb.toFixed(2)} MB`);
  }
  if (typeof video?.duration === "number" && Number.isFinite(video.duration)) {
    contextLines.push(`Duration: ${formatSeconds(video.duration)}`);
  }
  if (
    typeof video?.width === "number" &&
    typeof video?.height === "number" &&
    video.width > 0 &&
    video.height > 0
  ) {
    contextLines.push(`Resolution: ${video.width}x${video.height}`);
  }
  if (
    typeof video?.currentTime === "number" &&
    Number.isFinite(video.currentTime)
  ) {
    contextLines.push(`Playhead: ${formatSeconds(video.currentTime)}`);
  }
  if (
    typeof video?.trimStartSeconds === "number" &&
    typeof video?.trimEndSeconds === "number" &&
    Number.isFinite(video.trimStartSeconds) &&
    Number.isFinite(video.trimEndSeconds)
  ) {
    contextLines.push(
      `Trim range: ${formatSeconds(video.trimStartSeconds)} - ${formatSeconds(
        video.trimEndSeconds
      )}`
    );
  }
  if (typeof video?.isEditorMode === "boolean") {
    contextLines.push(`Editor mode: ${video.isEditorMode ? "on" : "off"}`);
  }
  if (lastRange) {
    contextLines.push(
      `Last mentioned range: ${formatSeconds(lastRange.start)} - ${formatSeconds(
        lastRange.end
      )}`
    );
  }

  if (audio?.summary) {
    contextLines.push(`Audio context:
${audio.summary}`);
  } else if (audio?.status && audio.status !== "done") {
    const statusLine = audio.error
      ? `Audio status: ${audio.status} (${audio.error})`
      : `Audio status: ${audio.status}`;
    contextLines.push(statusLine);
  }

  if (clips?.summary) {
    contextLines.push(`Clip stack:
${clips.summary}`);
  }

  if (visual?.summary) {
    contextLines.push(`Visual context:
${visual.summary}`);
  }

  if (typeof frame === "string" && frame.startsWith("data:image/")) {
    try {
      const frameResult = await describeFrame(frame);
      addUsage(frameResult.usage);
      if (frameResult.description) {
        contextLines.push(`Frame description: ${frameResult.description}`);
      }
    } catch {
      contextLines.push("Frame description: unavailable");
    }
  }

  const messages = [
    {
      role: "system",
      content:
        "You are an AI video editing assistant inside a video editor. Respond as if the edit will happen in this app. Do not suggest external apps, websites, or OS-level steps. Keep replies concise, friendly, and action-focused. Maintain memory of the clip stack and conversation context. Use ONLY the provided video context, audio context, clip stack, and frame description. Do NOT infer or guess content from the file name, title, or metadata. The user is a casual, non-technical editor: avoid jargon like \"timestamps\" unless necessary. If they don't know exact times, offer simple choices like \"beginning / middle / end\" or \"about how long\" and suggest they can move the playhead and say \"use current time\" or adjust the trim handles and say \"use current trim range.\" If the user asks to export/merge, say you are starting the export and avoid claiming it is complete. If the request requires content you do not have (e.g., transcript still processing), say so briefly and ask whether to wait or proceed with visual-only suggestions. If the user asks to trim/cut/remove and does not provide an explicit time range, use the last mentioned range if it exists and confirm briefly; otherwise ask a short follow-up question and do not guess. If the user references a clip without specifying which one, ask which clip number. If the request is missing details, set status to \"needs_info\" and ask at most 2 short, friendly clarifying questions in follow_up. Never fabricate timestamps. Return ONLY strict JSON (no markdown, no extra keys) using this schema: {\"assistant_message\": string, \"status\": \"ok\"|\"needs_info\"|\"error\", \"follow_up\": string|null, \"actions\": [{\"type\": string, \"start\": number|null, \"end\": number|null, \"clip\": number|null, \"reason\": string|null}]}.",
    },
  ];

  if (contextLines.length > 0) {
    messages.push({
      role: "system",
      content: `Video context:
${contextLines.join("\n")}`,
    });
  }

  if (history && history.length) {
    messages.push(...history);
  } else if (message) {
    messages.push({ role: "user", content: message });
  }

  const response = await fetch(
    "https://integrate.api.nvidia.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "nvidia/nemotron-3-super-120b-a12b",
        messages,
        max_tokens: 16384,
        temperature: 1,
        top_p: 0.95,
        chat_template_kwargs: { enable_thinking: false },
      }),
    }
  );

  const data = await response.json();
  if (!response.ok) {
    return Response.json(data, { status: response.status });
  }

  const content = data?.choices?.[0]?.message?.content ?? "";
  addUsage(data?.usage);
  let parsed = parseModelJson(content);
  let formatterContent: string | null = null;

  if (!parsed) {
    const formatted = await formatToJson({
      raw: content,
      userMessage: message,
      videoDuration: video?.duration,
    });
    formatterContent = formatted.content;
    parsed = formatted.parsed;
    addUsage(formatted.usage);
  }

  if (!parsed) {
    const extracted = extractRangeFromText(content);
    parsed = {
      assistant_message: content || "No response from AI",
      status: extracted ? "ok" : "needs_info",
      follow_up: extracted
        ? null
        : "I did not receive structured edit instructions. Could you provide a clear time range?",
      actions: extracted
        ? [
            {
              type: "trim",
              start: extracted.start,
              end: extracted.end,
              clip: null,
              reason: "AI response fallback",
            },
          ]
        : [],
    };
  }

  const isTrimAction = (action: ModelAction) =>
    ["trim", "cut", "remove", "delete"].includes((action?.type ?? "").toLowerCase());
  const hasValidRange = (action: ModelAction) =>
    Number.isFinite(action?.start) &&
    Number.isFinite(action?.end) &&
    (action.start as number) < (action.end as number);

  if (parsed?.actions?.length) {
    const shouldOverride =
      Boolean(explicitRange) ||
      (Boolean(effectiveRange) &&
        message &&
        editIntentRegex.test(message) &&
        parsed.actions.some((action) => isTrimAction(action) && !hasValidRange(action)));
    if (shouldOverride && (explicitRange || effectiveRange)) {
      const rangeToUse = explicitRange ?? effectiveRange!;
      parsed.actions = parsed.actions.map((action) => {
        if (!isTrimAction(action)) return action;
        return {
          ...action,
          start: rangeToUse.start,
          end: rangeToUse.end,
        };
      });
    }
  } else if (
    effectiveRange &&
    message &&
    editIntentRegex.test(message)
  ) {
    parsed.actions = [
      {
        type: "trim",
        start: effectiveRange.start,
        end: effectiveRange.end,
        clip: null,
        reason: explicitRange ? "User range" : "Last mentioned range",
      },
    ];
  }

  if (
    effectiveRange &&
    message &&
    editIntentRegex.test(message) &&
    parsed.status === "needs_info"
  ) {
    parsed.status = "ok";
    parsed.follow_up = null;
    if (!parsed.assistant_message) {
      parsed.assistant_message =
        explicitRange
          ? "Got it. I'll trim that section."
          : "Got it. I'll use the last range you mentioned.";
    }
  }

  if (
    effectiveRange &&
    !explicitRange &&
    message &&
    editIntentRegex.test(message)
  ) {
    parsed.status = "ok";
    parsed.follow_up = null;
    parsed.assistant_message =
      "Got it. I'll trim the last range you mentioned.";
  }

  const assistantMessage =
    parsed.assistant_message || parsed.follow_up || "No response from AI";

  const record = {
    savedAt: new Date().toISOString(),
    request: {
      message,
      video,
      audio,
      visual,
      clips,
      history,
    },
    response: {
      raw: content,
      formatter: formatterContent,
      parsed,
    },
  };

  try {
    const { mkdir, writeFile } = await import("fs/promises");
    const { join } = await import("path");
    const dir = join(process.cwd(), ".ai");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "last-response.json"),
      JSON.stringify(record, null, 2),
      "utf8"
    );
  } catch {
    // ignore write errors in serverless environments
  }

  return Response.json(
    {
      assistantMessage,
      parsed,
      usage: usageTotals,
    },
    { status: 200 }
  );
}
