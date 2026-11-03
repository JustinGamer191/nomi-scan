// Grok voice (xAI TTS) proxy. The browser never sees XAI_API_KEY: it POSTs text,
// we call https://api.x.ai/v1/tts server-side and stream the MP3 back.
export const maxDuration = 30;

const VOICE = process.env.XAI_VOICE || "eve";

export async function POST(req: Request) {
  const key = process.env.XAI_API_KEY;
  if (!key) return Response.json({ error: "No XAI_API_KEY; use browser voice." }, { status: 503 });
  const body = (await req.json().catch(() => ({}))) as { text?: string };
  const text = (body.text ?? "").trim().slice(0, 800);
  if (!text) return Response.json({ error: "No text." }, { status: 400 });

  try {
    const res = await fetch("https://api.x.ai/v1/tts", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voice_id: VOICE,
        language: "en",
        speed: 1.1,
        output_format: { codec: "mp3", sample_rate: 24000, bit_rate: 64000 },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok || !res.body) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      return Response.json({ error: `xAI TTS ${res.status}: ${detail}` }, { status: 502 });
    }
    return new Response(res.body, {
      headers: { "Content-Type": res.headers.get("content-type") ?? "audio/mpeg", "Cache-Control": "no-store", "X-Voice": VOICE },
    });
  } catch (e) {
    return Response.json({ error: `xAI TTS failed: ${e instanceof Error ? e.message : e}` }, { status: 502 });
  }
}
