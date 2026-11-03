import { ageGroup, isUnder12 } from "@/lib/ages";
import { dosingFor } from "@/lib/dosing";
import { glossaryAnswer, isDoseQuestion, RX_DOSE_REFUSAL } from "@/lib/glossary";
import { CONTROLLED_LINE, highAlertClass, interactionFlags, isInjectable, PROVIDER_LINE, productSections } from "@/lib/rx";
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
  for (const d of directions)
    out.push({
      source: d.label === "your prescription label" ? `your prescription bottle directions (${d.brand})` : `openFDA label "${d.label}" directions (${d.brand})`,
      text: d.text,
    });
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

  // Deterministic answers first: units/abbreviations, and prescription dose questions.
  const qLower = question.toLowerCase();
  const rxProducts = products.filter((p) => p.rx);
  const named = rxProducts.filter(
    (p) => p.keys.some((k) => qLower.includes(k)) || p.brand.toLowerCase().split(/[\s/]+/).some((w) => w.length > 3 && qLower.includes(w)),
  );
  const otcNamed = products.some(
    (p) => !p.rx && (p.keys.some((k) => qLower.includes(k)) || p.brand.toLowerCase().split(/[\s/]+/).some((w) => w.length > 3 && qLower.includes(w))),
  );
  const parts: string[] = [];
  if (isDoseQuestion(question)) {
    const targets = named.length ? named : otcNamed ? [] : rxProducts;
    for (const p of targets) {
      const sec = await productSections(p);
      const controlled = !!sec?.controlled || ["opioid", "benzodiazepine"].includes(highAlertClass(p.keys) ?? "");
      const injectable = isInjectable(p) || (sec?.routes ?? []).every((r) => /INTRAVENOUS|INTRAMUSCULAR|SUBCUTANEOUS|EPIDURAL/.test(r)) && (sec?.routes.length ?? 0) > 0;
      if (p.directions) parts.push(`Your ${p.brand} bottle says: "${p.directions}". Follow it exactly and don't change a prescription dose on your own.`);
      else if (injectable) parts.push(`${p.brand} is an injectable medicine. ${PROVIDER_LINE} ${RX_DOSE_REFUSAL}`);
      else parts.push(`${p.brand}: ${RX_DOSE_REFUSAL}`);
      if (controlled) parts.push(CONTROLLED_LINE);
    }
  }
  // Age questions about a prescription: quote its pediatric / geriatric use section.
  const kidQ = /\b(baby|infant|newborn|toddler|child|children|kid|kids|son|daughter|teen|pediatric)\b/i.test(question);
  const oldQ = /\b(elderly|older|senior|grand(ma|pa|mother|father)|geriatric)\b/i.test(question);
  if (kidQ || oldQ) {
    for (const p of named.length ? named : rxProducts) {
      const sec = await productSections(p);
      const text = kidQ ? sec?.pediatric : sec?.geriatric;
      if (!sec || !text) continue;
      const sentence =
        text
          .replace(/^(\d+(\.\d+)?\s+)?(pediatric use|geriatric use)\s*/i, "")
          .split(/(?<=\.)\s+/)
          .find((x) => /not been established|not recommended|should not|contraindicated|under|children|elderly|older/i.test(x)) ??
        text.slice(0, 250);
      parts.push(`The ${sec.label_name} label (${kidQ ? "pediatric use" : "geriatric use"}) says: "${sentence.slice(0, 300)}" Ask the prescriber or pharmacist before giving it.`);
    }
  }
  const gloss = glossaryAnswer(question);
  if (gloss) parts.push(gloss);
  if (parts.length) return Response.json({ answer: parts.join(" "), grounded: true, by: "rules" });

  // Grounding text is fetched server-side from openFDA, not taken from the client.
  const keys = [...new Set(products.flatMap((p) => p.keys))];
  const [labels, dosing] = await Promise.all([Promise.all(keys.map(getLabel)), dosingFor(products, true)]);
  const directions = dosing.rules
    .filter((r) => r.found && r.directions)
    .map((r) => ({ brand: r.brand, label: r.label_name ?? r.brand, text: r.directions! }));
  const chunks = chunksFrom(labels, directions);
  // Prescription labels: boxed warning, contraindications, interactions (fetched server-side).
  const rxSecs = (await Promise.all(products.filter((p) => p.rx).map((p) => productSections(p)))).filter(
    (x): x is NonNullable<typeof x> => !!x,
  );
  // Label sentences where one scanned product's label names another's ingredient or class.
  const xref = products.length > 1 ? (await interactionFlags(products)).flags : [];
  const xrefText = xref.flatMap((f) =>
    (f.evidence ?? []).map((e) => `SOURCE: openFDA label "${e.label}" ${e.section} (about ${f.products.join(" + ")})\n${e.quote}`),
  );
  for (const f of xref)
    for (const e of f.evidence ?? [])
      chunks.unshift({ source: `openFDA label "${e.label}" ${e.section}`, text: `${f.products.join(" + ")}: ${e.quote}` });
  for (const r of rxSecs) {
    for (const sec of [...r.red, ...r.yellow]) {
      for (const sentence of sec.text.split(/(?<=\.)\s+/).slice(0, 80)) {
        if (sentence.length > 30) chunks.push({ source: `openFDA label "${r.label_name}" ${sec.section}`, text: sentence.slice(0, 400) });
      }
    }
  }
  const names = [...keys, ...products.flatMap((p) => p.brand.toLowerCase().split(/\s+/))];

  // A question naming two scanned products that a label cross-reference links: answer from that quote.
  const ql = question.toLowerCase();
  const pairHit = xref.find((f) =>
    f.products.every((b) => b.toLowerCase().split(/[\s/]+/).some((w) => w.length > 3 && ql.includes(w))),
  );
  if (mock || !hasKey()) {
    if (pairHit?.evidence?.length) {
      const e = pairHit.evidence[0];
      return Response.json({
        answer: `The ${e.label} label (${e.section}) says: "${e.quote}" ${pairHit.rx ? "Talk to your pharmacist or prescriber before combining. Do not stop a prescription on your own." : "Ask a pharmacist before combining."}`,
        grounded: true,
        by: mock ? "mock" : "rules",
      });
    }
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
    ...(xrefText.length ? ["INTERACTION SENTENCES FOUND ON THESE LABELS:", ...xrefText] : []),
    ...rxSecs.flatMap((r) =>
      [
        ...(r.boxed ? [{ section: "boxed warning", text: r.boxed }] : []),
        ...(r.pediatric ? [{ section: "pediatric use", text: r.pediatric }] : []),
        ...(r.geriatric ? [{ section: "geriatric use", text: r.geriatric }] : []),
        ...r.red.filter((x) => x.section !== "boxed warning"),
        ...r.yellow,
      ].map((sec) => `SOURCE: openFDA label "${r.label_name}" ${sec.section} (${r.brand}, prescription)\n${sec.text.slice(0, 1800)}`),
    ),
  ].join("\n");

  const system = `You are Nomi, a careful assistant that answers questions about the user's scanned medications (OTC and prescription).
Answer ONLY using the SCANNED PRODUCTS and LABEL TEXT below. Do not use outside knowledge.
- If the label text does not answer the question, or the question is about anything else (other drugs,
  diagnosis, symptoms, children's doses the label does not state, medical conditions not on the label), reply exactly:
  "${REDIRECT}"
- Use the AGE PROFILE. If the label says "do not use" or "ask a doctor" for that age (for example
  "children under 12 years: do not use", or the Reye's syndrome warning for children and teenagers), say so first.${
    !isUnder12(age) ? "" : "\n- Do not apply adult directions to a child; adult directions are for ages 12 and over."
  }
- If an INTERACTION SENTENCE below covers the question, answer from it and quote it.
- For prescription items, never suggest changing, skipping or stopping a prescription dose; say to talk to the
  pharmacist or prescriber.
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
