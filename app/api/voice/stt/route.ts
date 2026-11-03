// Grok speech-to-text (xAI STT) proxy: browser uploads a short recording,
// we forward it to https://api.x.ai/v1/stt with the server-side key.
export const maxDuration = 30;

const MAX_BYTES = 10 * 1024 * 1024;

export async function POST(req: Request) {
  const key = process.env.XAI_API_KEY;
  if (!key) return Response.json({ error: "No XAI_API_KEY; use browser speech recognition." }, { status: 503 });
  const form = await req.formData().catch(() => null);
  const audio = form?.get("audio");
  if (!(audio instanceof File) || audio.size === 0) return Response.json({ error: "No audio." }, { status: 400 });
  if (audio.size > MAX_BYTES) return Response.json({ error: "Recording too long." }, { status: 413 });

  const out = new FormData();
  out.append("file", audio, audio.name || "question.webm");
  out.append("language", "en");
  try {
    const res = await fetch("https://api.x.ai/v1/stt", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: out,
      signal: AbortSignal.timeout(20000),
    });
    const data = (await res.json().catch(() => ({}))) as { text?: string };
    if (!res.ok) return Response.json({ error: `xAI STT ${res.status}` }, { status: 502 });
    return Response.json({ text: String(data.text ?? "").trim() });
  } catch (e) {
    return Response.json({ error: `xAI STT failed: ${e instanceof Error ? e.message : e}` }, { status: 502 });
  }
}
