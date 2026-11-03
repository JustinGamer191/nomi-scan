import { BadKeyError, chat, extractJson, hasKey } from "@/lib/grok";
import { isHHMM, parseScheduleText, type HHMMBlock } from "@/lib/schedule";

export const maxDuration = 60;

// Pasted schedule text -> busy blocks for today. Grok parses free-form text;
// the built-in parser handles MOCK mode, no key, and Grok failures.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { text?: string; mock?: boolean };
  const text = (body.text ?? "").slice(0, 4000);
  if (!text.trim()) return Response.json({ error: "Paste your schedule first." }, { status: 400 });
  const mock = !!body.mock || process.env.MOCK === "1";

  if (!mock && hasKey()) {
    try {
      const out = await chat([
        {
          role: "system",
          content: `Convert the user's schedule for TODAY into busy time blocks. Use only times stated in the text.
Return ONLY raw JSON: {"blocks":[{"label": string, "start": "HH:MM", "end": "HH:MM"}]} using 24-hour time.
If a time has no am/pm, use the most sensible reading for a student's day (classes 8am to 9pm).`,
        },
        { role: "user", content: text },
      ]);
      const j = extractJson(out) as { blocks?: HHMMBlock[] };
      const blocks = (j.blocks ?? [])
        .filter((b) => isHHMM(b.start) && isHHMM(b.end) && b.end > b.start)
        .map((b) => ({ label: String(b.label ?? "Busy").slice(0, 60), start: b.start, end: b.end }));
      if (blocks.length) return Response.json({ blocks, by: "grok" });
    } catch (e) {
      if (e instanceof BadKeyError) {
        return Response.json({ blocks: parseScheduleText(text), by: "rules", note: "xAI key rejected; used built-in parser." });
      }
    }
  }
  return Response.json({ blocks: parseScheduleText(text), by: "rules" });
}
