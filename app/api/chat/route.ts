export async function POST(req: Request) {
  const { message, videoDuration } = await req.json();

  const durationNote = videoDuration
    ? ` The video is ${Math.round(videoDuration)} seconds (${formatTime(videoDuration)}) long.`
    : "";

  const systemPrompt = `You are a video clip assistant.${durationNote}

Extract start and end times from the user's message and call the clip_video function.
Always call the function when you can detect a time range.

Rules:
- "the first N seconds"  → start=0, end=N
- "the last N seconds"   → start=${Math.round(videoDuration ?? 0)}-N, end=${Math.round(videoDuration ?? 0)}
- "from X to Y"          → convert both to seconds
- "0:30" = 30s, "1:20" = 80s, "1:30:00" = 5400s
- If unclear, reply with a short clarifying question instead of calling the function.`;

  const tools = [
    {
      type: "function",
      function: {
        name: "clip_video",
        description:
          "Clip a segment of the video between startSeconds and endSeconds. Call this whenever the user specifies a time range.",
        parameters: {
          type: "object",
          properties: {
            startSeconds: {
              type: "number",
              description: "Start time in seconds (>= 0)",
            },
            endSeconds: {
              type: "number",
              description: "End time in seconds (> startSeconds)",
            },
            explanation: {
              type: "string",
              description:
                "Short confirmation shown to the user, e.g. 'Clipping 0:30 → 1:20 (50 seconds)'",
            },
          },
          required: ["startSeconds", "endSeconds", "explanation"],
        },
      },
    },
  ];

  const response = await fetch(
    "https://integrate.api.nvidia.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemma-4-31b-it",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message },
        ],
        tools,
        tool_choice: "auto",
        max_tokens: 1000,
        temperature: 0.2,
        top_p: 0.9,
      }),
    }
  );

  const data = await response.json();

  // Normalise to the shape Chat.tsx expects:
  // tool call  → { content: [{ type: "tool_use", name: "clip_video", input: {...} }] }
  // plain text → { content: [{ type: "text", text: "..." }] }
  const choice = data.choices?.[0];
  const msg = choice?.message;

  if (msg?.tool_calls?.length) {
    const call = msg.tool_calls[0];
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(call.function.arguments);
    } catch {
      input = {};
    }
    return Response.json({
      content: [{ type: "tool_use", name: "clip_video", input }],
    });
  }

  const text = msg?.content ?? "Sorry, I didn't understand that.";
  return Response.json({
    content: [{ type: "text", text }],
  });
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}