export async function POST(req: Request) {
  const { message } = await req.json();

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
        messages: [{ role: "user", content: message }],
        max_tokens: 1000,
        temperature: 0.7,
        top_p: 0.9,
      }),
    }
  );

  const data = await response.json();
  return Response.json(data);
}
