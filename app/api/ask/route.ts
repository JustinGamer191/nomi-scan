import { ageGroup, isUnder12 } from "@/lib/ages";
import { dosingFor } from "@/lib/dosing";
import { getLabel, labelCitation } from "@/lib/fda";
import { BAD_KEY_HELP, BadKeyError, chat, hasKey, type Msg } from "@/lib/grok";
import type { LabelInfo, Product } from "@/lib/types";

export const maxDuration = 60;

type Body = {
  question?: string;
  products?: (Product & { keys: string[] })[];
  history?: { role: "user" | "assistant"; content: string }[];
  mock?: boolean;
  age?: string;
};

const REDIRECT =
  "I can only answer from the FDA labels of the products you scanned, and they don't cover that. Please ask a pharmacist.";

type Chunk = { source: string; text: string };

function chunksFrom(labels: LabelInfo[], directions: { brand: string; label: string; text: string }[]): Chunk[] {
  const out: Chunk[] = [];
  for (const l of labels) {
    if (!l.found) continue;
    const src = labelCitation(l);
    for (const field of [l.warnings, l.do_not_use, l.ask_doctor, l.stop_use]) {
      if (!field) continue;
      for (const s of field.replace(/^Warnings\s*/i, "").split(/(?<=\.)\s+|\s(?=(?:Ask a doctor|Do not use|Stop use|When using|If pregnant|Keep out))/)) {
        if (s.trim().length > 20) out.push({ source: src, text: s.trim() });
      }
    }
  }
  for (const d of directions) out.push({ source: `openFDA label "${d.label}" directions (${d.brand})`, text: d.text });
  return out;
}

const STOPWORDS = new Set(
  "a an the i me my can could should would will is are am do does did to of in on for with and or it this that these those take taking took both together at be if what when how much many any about it's im i'm".split(
    " ",
  ),
);

// Keyless fallback: return the best-matching label sentence verbatim.
function retrieve(question: string, chunks: Chunk[], names: string[]): string {
  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !names.includes(w));
  if (!words.length) return REDIRECT;
  const SYN: Record<string, string[]> = {
    drowsy: ["drowsiness", "drive", "machinery"],
    sleepy: ["drowsiness", "drive", "machinery"],
    drive: ["drive", "machinery"],
    driving: ["drive", "machinery"],
    drink: ["alcohol"],
    beer: ["alcohol"],
    wine: ["alcohol"],
    kid: ["children"],
    kids: ["children"],
    child: ["children"],
    doctor: ["doctor"],
    stop: ["stop use"],
  };
  const terms = [...new Set(words.flatMap((w) => [w.length > 5 ? w.slice(0, 5) : w.replace(/s$/, ""), ...(SYN[w] ?? [])]))];
  let best: { c: Chunk; score: number } | null = null;
  for (const c of chunks) {
    const t = c.text.toLowerCase();
    const score = terms.filter((w) => t.includes(w)).length;
    if (score > 0 && (!best || score > best.score)) best = { c, score };
  }
  if (!best) return REDIRECT;
  const q = best.c.text.length > 320 ? best.c.text.slice(0, 320) + "..." : best.c.text;
  return `Here is what the label says: "${q}" (Source: ${best.c.source}.) For anything beyond the label, ask a pharmacist.`;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Body;
  const question = (body.question ?? "").trim().slice(0, 500);
  const products = (body.products ?? []).filter((p) => typeof p?.brand === "string" && Array.isArray(p.keys)).slice(0, 5);
  if (!question) return Response.json({ error: "Ask a question." }, { status: 400 });
  if (!products.length) return Response.json({ error: "Scan some products first." }, { status: 400 });
  const mock = !!body.mock || process.env.MOCK === "1";

  // Grounding text is fetched server-side from openFDA, not taken from the client.
  const keys = [...new Set(products.flatMap((p) => p.keys))];
  const [labels, dosing] = await Promise.all([Promise.all(keys.map(getLabel)), dosingFor(products, true)]);
  const directions = dosing.rules
    .filter((r) => r.found && r.directions)
    .map((r) => ({ brand: r.brand, label: r.label_name ?? r.brand, text: r.directions! }));
  const chunks = chunksFrom(labels, directions);
  const names = [...keys, ...products.flatMap((p) => p.brand.toLowerCase().split(/\s+/))];

  if (mock || !hasKey()) {
    return Response.json({ answer: retrieve(question, chunks, names), grounded: true, by: mock ? "mock" : "rules" });
  }

  const age = ageGroup(body.age);
  const context = [
    `AGE PROFILE: the person taking these is ${age.label}.`,
    "",
    "SCANNED PRODUCTS:",
    ...products.map((p) => `- ${p.brand}: ${p.active_ingredients.map((a) => `${a.name} ${a.strength}`).join(", ")}`),
    "",
    "LABEL TEXT (openFDA):",
    ...labels.filter((l) => l.found).map(
      (l) =>
        `SOURCE: ${labelCitation(l)}\n${[l.warnings, l.do_not_use, l.ask_doctor, l.stop_use].filter(Boolean).join("\n")}`,
    ),
    ...directions.map((d) => `SOURCE: openFDA label "${d.label}" directions (${d.brand})\n${d.text}`),
  ].join("\n");

  const system = `You are Nomi, a careful assistant that answers questions about the user's scanned OTC medications.
Answer ONLY using the SCANNED PRODUCTS and LABEL TEXT below. Do not use outside knowledge.
- If the label text does not answer the question, or the question is about anything else (other drugs,
  diagnosis, symptoms, children's doses the label does not state, medical conditions not on the label), reply exactly:
  "${REDIRECT}"
- Use the AGE PROFILE. If the label says "do not use" or "ask a doctor" for that age (for example
  "children under 12 years: do not use", or the Reye's syndrome warning for children and teenagers), say so first.${
    !isUnder12(age) ? "" : "\n- Do not apply adult directions to a child; adult directions are for ages 12 and over."
  }
- Never invent doses, numbers, or risks. Quote or paraphrase the label closely.
- Keep it to 2-4 short sentences in plain English and end with the source label name in parentheses.
- This is not medical advice.

${context}`;

  const history = (body.history ?? []).slice(-6).map((h) => ({
    role: h.role === "assistant" ? ("assistant" as const) : ("user" as const),
    content: String(h.content).slice(0, 1000),
  }));
  const messages: Msg[] = [{ role: "system", content: system }, ...history, { role: "user", content: question }];
  try {
    const answer = (await chat(messages, 0.1)).trim();
    return Response.json({ answer: answer || REDIRECT, grounded: true, by: "grok" });
  } catch (e) {
    if (e instanceof BadKeyError) return Response.json({ error: BAD_KEY_HELP }, { status: 401 });
    return Response.json({ answer: retrieve(question, chunks, names), grounded: true, by: "rules", note: "Grok unavailable; answered from label text." });
  }
}
