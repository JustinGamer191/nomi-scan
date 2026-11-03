import type { Flag, LabelInfo, Product } from "./types";
import { labelCitation } from "./fda";

const ENDPOINT = "https://api.x.ai/v1/chat/completions";
export const MODEL = process.env.XAI_MODEL || "grok-4.20-0309-non-reasoning";

export class MissingKeyError extends Error {}
export class BadKeyError extends Error {}

export type Msg = { role: "system" | "user" | "assistant"; content: unknown };

export const KEY_HELP =
  "No xAI API key configured. Add XAI_API_KEY to .env.local (get one at console.x.ai) and restart, or run with MOCK=1.";
export const BAD_KEY_HELP =
  "xAI rejected the API key. Check XAI_API_KEY in .env.local (create a key at console.x.ai) and restart the server.";

export function hasKey() {
  return !!process.env.XAI_API_KEY;
}

async function failFromResponse(res: Response): Promise<never> {
  const text = await res.text().catch(() => "");
  if (res.status === 401 || res.status === 403 || /api key/i.test(text)) throw new BadKeyError(BAD_KEY_HELP);
  // Never echo request headers; the body from xAI does not contain the key.
  throw new Error(`xAI API ${res.status}: ${text.slice(0, 300)}`);
}

// Grok via the Responses API with the server-side web_search tool.
// Returns the final text plus any cited URLs.
export async function searchResponses(prompt: string): Promise<{ text: string; urls: string[] }> {
  const key = process.env.XAI_API_KEY;
  if (!key) throw new MissingKeyError("XAI_API_KEY is not set");
  const res = await fetch("https://api.x.ai/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      input: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search" }],
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) await failFromResponse(res);
  type Part = { type?: string; text?: string; annotations?: { url?: string }[] };
  const data = (await res.json()) as {
    output_text?: string;
    output?: { type?: string; content?: Part[] }[];
    citations?: (string | { url?: string })[];
  };
  let text = data.output_text ?? "";
  const urls = new Set<string>();
  for (const item of data.output ?? []) {
    for (const part of item.content ?? []) {
      if (part.type === "output_text" && part.text) text = text || part.text;
      for (const a of part.annotations ?? []) if (a.url) urls.add(a.url);
    }
  }
  for (const c of data.citations ?? []) {
    const u = typeof c === "string" ? c : c.url;
    if (u) urls.add(u);
  }
  return { text, urls: [...urls] };
}

export async function chat(messages: Msg[], temperature = 0): Promise<string> {
  const key = process.env.XAI_API_KEY;
  if (!key) throw new MissingKeyError("XAI_API_KEY is not set");
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODEL, messages, temperature }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) await failFromResponse(res);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content ?? "";
}

export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(body);
  } catch {
    // Grab the first top-level array or object.
    const start = body.search(/[[{]/);
    const end = Math.max(body.lastIndexOf("]"), body.lastIndexOf("}"));
    if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1));
    throw new Error("No JSON found");
  }
}

// Keep only the dosing instruction: drop phone numbers, Rx/refill numbers, dates and
// anything after a "Dr." / "Patient" style label, in case the model copied extra text.
export function scrubDirections(text: string): string | undefined {
  const t = text
    .replace(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g, "")
    .replace(/\b(rx|refills?|qty|dr\.?|prescriber|patient|pharmacy|npi|dea)\b[\s#:]*[\w.-]*/gi, "")
    .replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return /\b(take|use|apply|inhale|place|chew|dissolve|instill)\b/i.test(t) ? t : undefined;
}

function validateProducts(raw: unknown): Product[] {
  const arr = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { products?: unknown }).products)
      ? (raw as { products: unknown[] }).products
      : null;
  if (!arr) throw new Error("Expected a JSON array");
  return arr.slice(0, 5).map((p, i) => {
    const o = p as Record<string, unknown>;
    if (typeof o.brand !== "string" || !Array.isArray(o.active_ingredients)) {
      throw new Error(`Item ${i} missing brand or active_ingredients`);
    }
    // Whitelist fields: anything else the model returns (patient name, Rx number,
    // prescriber, pharmacy, phone) is dropped here and never leaves the server.
    const rx = o.rx === true;
    const directions = rx && typeof o.directions === "string" ? scrubDirections(o.directions) : undefined;
    return {
      brand: o.brand.slice(0, 80),
      active_ingredients: (o.active_ingredients as Record<string, unknown>[])
        .filter((a) => a && typeof a.name === "string")
        .map((a) => ({ name: String(a.name).slice(0, 60), strength: String(a.strength ?? "").slice(0, 30) })),
      confidence: Math.max(0, Math.min(1, Number(o.confidence ?? 0.5))),
      ...(rx ? { rx: true, ...(directions ? { directions } : {}) } : {}),
    };
  });
}

const VISION_PROMPT = `You read photos of over-the-counter (OTC) medication packages.
Identify every distinct medication box or bottle in the photo (0 to 5 items), including
pharmacy PRESCRIPTION bottles.
For OTC packages, read the "Drug Facts" / "Active ingredient(s)" from the package.
For a pharmacy prescription label (no Drug Facts panel): read the drug name (brand and/or
generic), its strength, and the directions line (e.g. "Take 1 tablet by mouth twice daily"),
and set "rx": true. For combination drugs list each ingredient (e.g. hydrocodone 5 mg +
acetaminophen 325 mg). NEVER output the patient's name, Rx number, prescriber, pharmacy name,
address, phone number, dates, or refill info. Put the drug name in "brand".
If the
active ingredients are not visible but the product is clearly identifiable, use the
well-known formulation of that exact product and lower the confidence.
If you can see a medication package but cannot read enough to identify it (too small,
blurry, cut off, glare), do NOT guess: leave it out of "products" and describe the
problem in "unreadable".

Return ONLY a JSON object, no prose, no markdown fences:
{"products": [{"brand": string, "active_ingredients": [{"name": string, "strength": string}], "confidence": number between 0 and 1, "rx": boolean, "directions": string or null}],
 "unreadable": string or null}
"unreadable" is a short reason such as "labels too small to read" or "box is blurry"; null if everything was readable.
Use generic ingredient names (e.g. "Acetaminophen", "Doxylamine Succinate").
If no medication is visible at all, return {"products": [], "unreadable": null}.`;

const STRICT_SUFFIX = `

Your previous answer was not valid JSON. Respond with a single raw JSON object that
parses with JSON.parse. The first character must be "{" and the last must be "}".
No explanation, no code fences, no trailing text.`;

export type ImageRead = { products: Product[]; unreadable: string | null };

function validateRead(raw: unknown): ImageRead {
  const products = validateProducts(raw);
  const u = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { unreadable?: unknown }).unreadable : null;
  return { products, unreadable: typeof u === "string" && u.trim() ? u.trim().slice(0, 120) : null };
}

// One Grok vision call per image (run in parallel by the caller), so each
// result and hint can be tied back to the image it came from.
export async function readBoxes(dataUrl: string): Promise<ImageRead> {
  const build = (prompt: string): Msg[] => [
    { role: "system", content: prompt },
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
        { type: "text", text: "List the OTC medications in this photo as JSON." },
      ],
    },
  ];

  const first = await chat(build(VISION_PROMPT));
  try {
    return validateRead(extractJson(first));
  } catch {
    // Bad JSON or wrong shape: retry once with a stricter prompt.
    const second = await chat(build(VISION_PROMPT + STRICT_SUFFIX));
    return validateRead(extractJson(second));
  }
}

// ---------- Explanations, grounded only in openFDA text ----------

function labelExcerpt(l: LabelInfo): string {
  if (!l.found) return `[${l.ingredient}] NO LABEL FOUND`;
  return [
    `SOURCE: ${labelCitation(l)}`,
    l.warnings && `warnings: ${l.warnings}`,
    l.do_not_use && `do_not_use: ${l.do_not_use}`,
    l.ask_doctor && `ask_doctor: ${l.ask_doctor}`,
    l.stop_use && `stop_use: ${l.stop_use}`,
  ]
    .filter(Boolean)
    .join("\n");
}

const EXPLAIN_PROMPT = `You explain medication label warnings in plain English for a
regular person standing in a pharmacy aisle.

Rules:
- Use ONLY the openFDA label text provided. Do not add facts, doses, numbers, or
  risks that are not in that text. If the text does not cover the issue, say the
  label does not address it and suggest asking a pharmacist.
- 2 to 3 short sentences per issue. No medical advice beyond what the label says.
- Cite which label each warning came from using the exact SOURCE string given.

Return ONLY raw JSON, no fences:
{"explanations":[{"id": string, "explanation": string, "citations": [string]}]}`;

export async function explainFlags(
  flags: Flag[],
  labels: Record<string, LabelInfo>,
): Promise<Record<string, { explanation: string; citations: string[] }>> {
  if (flags.length === 0) return {};
  const issues = flags
    .map((f) => {
      const texts = f.evidence?.length
        ? f.evidence.map(
            (e) =>
              `SOURCE: openFDA label "${e.label}" (${e.section})\nQUOTE: ${e.quote}\nMATCH: our code matched ${f.ingredients.join(", ")} (in ${f.products.slice(1).join(", ") || "the other product"}) to this sentence by name or drug class (e.g. ibuprofen is an NSAID, sertraline is an SSRI).`,
          )
        : f.ingredients.map((i) => labelExcerpt(labels[i] ?? { ingredient: i, found: false }));
      return `ISSUE id=${f.id}\nproblem: ${f.title}\nproducts: ${f.products.join(", ")}\nrule source: ${f.source}\nLABEL TEXT:\n${texts.join("\n---\n")}`;
    })
    .join("\n\n=====\n\n");

  const run = async (extra = "") => {
    const out = await chat([
      { role: "system", content: EXPLAIN_PROMPT + extra },
      { role: "user", content: issues },
    ]);
    const parsed = extractJson(out) as { explanations?: { id: string; explanation: string; citations?: string[] }[] };
    if (!parsed?.explanations || !Array.isArray(parsed.explanations)) throw new Error("bad shape");
    return Object.fromEntries(
      parsed.explanations
        // An evidence-backed flag answered with "not addressed" falls back to the quote template.
        .filter((e) => !(flags.find((f) => f.id === e.id)?.evidence?.length && /does not address|not address/i.test(String(e.explanation))))
        .map((e) => [e.id, { explanation: String(e.explanation), citations: (e.citations ?? []).map(String) }]),
    );
  };
  try {
    return await run();
  } catch (e) {
    if (e instanceof MissingKeyError || e instanceof BadKeyError) throw e;
    return await run(
      "\n\nYour previous answer was not valid JSON. Respond with one raw JSON object that parses with JSON.parse. No fences, no extra text.",
    );
  }
}

// Deterministic fallback (used in MOCK mode and if the explanation call fails):
// quotes the label text directly, so it is grounded by construction.
// Pull the most relevant phrase from label text: the clause about combining
// with other products, trimmed to start at the nearest sentence/heading break.
function relevantQuote(text: string, ingredient: string): string {
  const src = text.replace(/^Warnings\s*/i, "").replace(/\s+/g, " ");
  const patterns = [
    new RegExp(`other (drugs?|products?)[^.]{0,60}?containing ${ingredient}`, "i"),
    /other (drugs?|products?) containing[^.]{0,40}?(NSAIDs?|antihistamines?)( \[[^\]]*\])?/i,
    /any other (antihistamines?|sleep-aids?|drugs? containing \w+)/i,
    /(drowsiness|NSAID|decongestant)[^.]{0,80}/i,
  ];
  for (const re of patterns) {
    const m = re.exec(src);
    if (!m) continue;
    const before = src.slice(0, m.index);
    const breakAt = Math.max(before.lastIndexOf(". "), before.lastIndexOf(": "));
    let begin = breakAt >= 0 ? breakAt + 2 : 0;
    if (m.index - begin > 180) begin = m.index;
    let q = src.slice(begin, m.index + m[0].length).trim();
    if (q.length > 260) q = "..." + q.slice(q.length - 257);
    return q;
  }
  const first = src.split(/(?<=\.)\s/)[0] ?? "";
  return first.length > 240 ? first.slice(0, 240).replace(/\s+\S*$/, "") + "..." : first;
}

export function templateExplanation(flag: Flag, labels: Record<string, LabelInfo>) {
  if (flag.evidence?.length) {
    const e = flag.evidence[0];
    return {
      explanation: `The ${e.label} label (${e.section}) warns about using it with ${flag.ingredients.join(", ")}, which is in ${flag.products[1] ?? "another product"}: "${e.quote}"`,
      citations: flag.evidence.map((x) => `openFDA label "${x.label}" (${x.section})`),
    };
  }
  const found = flag.ingredients.map((i) => labels[i]).filter((l): l is LabelInfo => !!l?.found);
  const citations = found.map(labelCitation);
  const lead =
    flag.kind === "duplicate"
      ? `${flag.products.join(" and ")} both contain ${flag.ingredients[0]}, so taking them together doubles up on the same drug.`
      : `${flag.products.join(" and ")} contain ${flag.ingredients.join(" and ")}, which belong to the same group of medicines.`;
  const quote = found
    .map((l) => {
      const q = relevantQuote([l.warnings, l.do_not_use].filter(Boolean).join(" "), l.ingredient);
      return q ? `The ${l.label_name} label says: "${q}"` : "";
    })
    .filter(Boolean)
    .join(" ");
  return {
    explanation: `${lead} ${quote || "No openFDA label text was found for this, so ask a pharmacist."}`.trim(),
    citations,
  };
}
