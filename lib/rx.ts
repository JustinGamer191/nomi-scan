// Prescription support: Rx label lookup and deterministic label cross-referencing.
// No LLM here. A flag only fires when one product's own FDA label text names the
// other product's ingredient (or a class it belongs to), and we quote that sentence.
import { normalizeIngredient } from "./checks";
import type { Flag, Product } from "./types";

type P = Product & { keys: string[] };

export type LabelSections = {
  brand: string;
  label_name: string;
  set_id?: string;
  rx: boolean;
  red: { section: string; text: string }[]; // boxed warning, contraindications, OTC "Do not use"
  yellow: { section: string; text: string }[]; // drug interactions, OTC "Ask a doctor or pharmacist"
  dosage?: string;
  boxed?: string;
  pediatric?: string;
  geriatric?: string;
  controlled?: string; // "Schedule II controlled drug substance" etc.
  routes: string[];
};

type FdaLabel = {
  set_id?: string;
  boxed_warning?: string[];
  contraindications?: string[];
  drug_interactions?: string[];
  warnings_and_cautions?: string[];
  warnings?: string[];
  do_not_use?: string[];
  ask_doctor_or_pharmacist?: string[];
  dosage_and_administration?: string[];
  pediatric_use?: string[];
  geriatric_use?: string[];
  use_in_specific_populations?: string[];
  controlled_substance?: string[];
  openfda?: {
    brand_name?: string[];
    generic_name?: string[];
    substance_name?: string[];
    product_type?: string[];
    route?: string[];
  };
};

// Class terms, so "NSAIDs" in a label matches ibuprofen in another product.
// Sources: drug-class names as used in FDA prescribing information (e.g. sertraline
// label "Drugs that Interfere with Hemostasis (Non-selective NSAIDs, Aspirin, Warfarin)";
// opioid boxed warning "benzodiazepines or other CNS depressants"; MAOI and SSRI sections).
export const CLASS_TERMS: { members: string[]; terms: string[]; source: string }[] = [
  {
    members: ["ibuprofen", "naproxen", "aspirin", "ketoprofen", "diclofenac", "meloxicam", "celecoxib"],
    terms: ["NSAIDs?", "nonsteroidal anti-inflammatory"],
    source: "NSAID class (21 CFR 201.326; Rx labeling 'Drugs that Interfere with Hemostasis')",
  },
  {
    members: ["phenelzine", "tranylcypromine", "isocarboxazid", "selegiline", "rasagiline", "linezolid"],
    terms: ["MAOIs?", "monoamine oxidase inhibitors?"],
    source: "MAOI class (Rx labeling contraindications / OTC 'prescription MAOI' warning)",
  },
  {
    members: ["sertraline", "fluoxetine", "paroxetine", "citalopram", "escitalopram", "fluvoxamine"],
    terms: ["SSRIs?", "selective serotonin reuptake inhibitors?"],
    source: "SSRI class (opioid labeling 'Serotonergic Drugs' interaction)",
  },
  {
    members: ["alprazolam", "lorazepam", "diazepam", "clonazepam", "temazepam", "chlordiazepoxide"],
    terms: ["benzodiazepines?"],
    source: "Benzodiazepine class (opioid boxed warning, 2016 FDA Drug Safety Communication)",
  },
  {
    members: ["hydrocodone", "oxycodone", "codeine", "morphine", "tramadol", "hydromorphone", "fentanyl", "tapentadol"],
    terms: ["opioids?", "opiates?"],
    source: "Opioid class (benzodiazepine boxed warning, 2016 FDA Drug Safety Communication)",
  },
  {
    members: ["warfarin", "apixaban", "rivaroxaban", "dabigatran", "edoxaban"],
    terms: ["anticoagulants?", "blood thinn(?:ing|ers?)"],
    source: "Anticoagulant class (NSAID/SSRI bleeding-risk labeling)",
  },
  {
    members: [
      "diphenhydramine", "doxylamine", "chlorpheniramine", "brompheniramine", "alprazolam", "lorazepam",
      "diazepam", "clonazepam", "hydrocodone", "oxycodone", "codeine", "morphine", "zolpidem",
    ],
    terms: ["CNS depressants?", "central nervous system \\(CNS\\) depressants?", "central nervous system depressants?"],
    source: "CNS depressant class (opioid boxed warning)",
  },
];

const cache = new Map<string, LabelSections | null>();

async function search(q: string, limit = 5): Promise<FdaLabel[]> {
  try {
    const res = await fetch(`https://api.fda.gov/drug/label.json?search=${encodeURIComponent(q)}&limit=${limit}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    return ((await res.json()) as { results?: FdaLabel[] }).results ?? [];
  } catch {
    return [];
  }
}

const join = (a?: string[]) => (a?.length ? a.join(" ").replace(/\s+/g, " ").trim() : "");

// Find the label for one product. Rx: same ingredient set, prescription labels first.
export async function productSections(p: P): Promise<LabelSections | null> {
  const want = [...new Set(p.keys)].sort().join(",");
  const cacheKey = `${p.rx ? "rx" : "otc"}|${want}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;
  const same = (l: FdaLabel) =>
    [...new Set((l.openfda?.substance_name ?? []).map(normalizeIngredient))].sort().join(",") === want;
  const ingQ = [...new Set(p.keys)].map((k) => `openfda.generic_name:"${k}"`).join(" AND ");
  const type = p.rx ? "HUMAN PRESCRIPTION DRUG" : "HUMAN OTC DRUG";
  const injectable = isInjectable(p);
  let label: FdaLabel | null = null;
  const queries = [`${ingQ} AND openfda.product_type:"${type}"`, ingQ];
  if (injectable) queries.unshift(`${ingQ} AND openfda.product_type:"${type}" AND openfda.route:"INTRAVENOUS"`);
  for (const q of queries) {
    const hits = await search(q, 10);
    label = hits.find(same) ?? (p.rx ? hits[0] : null) ?? null;
    if (label) break;
  }
  if (!label) {
    cache.set(cacheKey, null);
    return null;
  }
  const isRx = (label.openfda?.product_type ?? []).includes("HUMAN PRESCRIPTION DRUG");
  const out: LabelSections = {
    brand: p.brand,
    label_name: label.openfda?.brand_name?.[0] ?? label.openfda?.generic_name?.[0] ?? p.brand,
    set_id: label.set_id,
    rx: isRx,
    red: [
      { section: "boxed warning", text: join(label.boxed_warning) },
      { section: "contraindications", text: join(label.contraindications) },
      { section: "Do not use", text: join(label.do_not_use) },
    ].filter((x) => x.text),
    yellow: [
      { section: "drug interactions", text: join(label.drug_interactions) },
      { section: "Ask a doctor or pharmacist", text: join(label.ask_doctor_or_pharmacist) },
    ].filter((x) => x.text),
    dosage: join(label.dosage_and_administration).slice(0, 1500) || undefined,
    boxed: join(label.boxed_warning) || undefined,
    pediatric: join(label.pediatric_use) || undefined,
    geriatric: join(label.geriatric_use) || undefined,
    controlled: join(label.controlled_substance) || undefined,
    routes: label.openfda?.route ?? [],
  };
  cache.set(cacheKey, out);
  return out;
}

function termsFor(key: string): { re: RegExp; what: string }[] {
  const out = [{ re: new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"), what: key }];
  for (const c of CLASS_TERMS) {
    if (c.members.includes(key)) for (const t of c.terms) out.push({ re: new RegExp(`\\b${t}\\b`, "i"), what: t.replace(/[?\\()]/g, "") });
  }
  return out;
}

// The sentence that contains the match, trimmed around it.
function sentenceAround(text: string, idx: number): string {
  const startCut = Math.max(text.lastIndexOf(". ", idx), text.lastIndexOf("• ", idx));
  let start = startCut >= 0 ? startCut + 2 : 0;
  if (idx - start > 200) start = idx - 120;
  let end = text.indexOf(". ", idx);
  end = end < 0 ? text.length : end + 1;
  if (end - idx > 220) end = idx + 220;
  return (start > 0 && startCut < 0 ? "..." : "") + text.slice(start, end).trim();
}

export function isInjectable(p: Product) {
  const text = `${p.brand} ${p.active_ingredients.map((a) => a.strength).join(" ")} ${p.directions ?? ""}`;
  return /\binject|\bvial\b|\bampul|\bIV\b|\/\s*mL\b|\bintravenous|\bintramuscular/i.test(text);
}

const HIGH_ALERT = ["opioid", "benzodiazepine", "anticoagulant"];
export function highAlertClass(keys: string[]): string | null {
  for (const c of CLASS_TERMS) {
    const name = c.source.split(" ")[0].toLowerCase();
    if (HIGH_ALERT.includes(name) && keys.some((k) => c.members.includes(k))) return name;
  }
  return null;
}

export const CONTROLLED_LINE = "This is a controlled medication. Only take it as prescribed to you.";
export const PROVIDER_LINE = "This form is given by a healthcare provider; do not self-dose from label tables.";

function firstSentence(text: string, re?: RegExp): string {
  const t = text.replace(/^(\d+(\.\d+)?\s+)?(pediatric use|geriatric use)\s*/i, "");
  const sentences = t.split(/(?<=\.)\s+/);
  const hit = re ? sentences.find((x) => re.test(x)) : undefined;
  const q = (hit ?? sentences[0] ?? "").trim();
  return q.length > 300 ? q.slice(0, 297) + "..." : q;
}

// Single-product checks: a boxed warning, or a label's pediatric/geriatric section, is
// a reason not to show green even when nothing overlaps.
export function singleProductFlags(
  products: P[],
  sections: (LabelSections | null)[],
  age: { min: number; max: number; label: string },
): Flag[] {
  const flags: Flag[] = [];
  products.forEach((p, i) => {
    const sec = sections[i];
    if (!sec) return;
    const cls = highAlertClass(p.keys);
    const vulnerable = age.max <= 18 || age.min >= 65;
    const controlled = !!sec.controlled || cls === "opioid" || cls === "benzodiazepine";
    const injectable = isInjectable(p) && sec.routes.some((r) => /INTRAVENOUS|INTRAMUSCULAR|SUBCUTANEOUS|EPIDURAL/.test(r));
    const evidence: NonNullable<Flag["evidence"]> = [];
    if (sec.boxed) {
      // Skip the all-caps heading; quote the first real sentence.
      const body = sec.boxed.replace(/^WARNING:[^a-z]*?(?=[A-Z][a-z])/, "");
      evidence.push({ label: sec.label_name, section: "boxed warning", quote: firstSentence(body) });
    }
    const ageText = age.max <= 18 ? sec.pediatric : age.min >= 65 ? sec.geriatric : undefined;
    if (ageText) {
      evidence.push({
        label: sec.label_name,
        section: age.max <= 18 ? "pediatric use" : "geriatric use",
        quote: firstSentence(ageText, /not been established|not recommended|contraindicated|should not|under|children|elderly|older/i),
      });
    }
    if (!evidence.length) return;
    const severity: "red" | "yellow" = cls && vulnerable ? "red" : sec.boxed ? "yellow" : "yellow";
    const extra = [controlled ? CONTROLLED_LINE : "", injectable ? PROVIDER_LINE : ""].filter(Boolean).join(" ");
    flags.push({
      id: `boxed-${p.brand.toLowerCase().replace(/[^a-z0-9]/g, "")}`,
      kind: "boxed",
      severity,
      title: sec.boxed ? `Boxed warning: ${p.brand}` : `Label caution for ${age.label}: ${p.brand}`,
      ingredients: p.keys,
      products: [p.brand],
      source: `openFDA label "${sec.label_name}" (${evidence.map((e) => e.section).join(", ")})`,
      rx: !!(p.rx || sec.rx),
      evidence,
      explanation: `${evidence.map((e) => `The ${e.label} label (${e.section}) says: "${e.quote}"`).join(" ")}${
        cls && vulnerable ? ` This is a high-alert ${cls} medicine and the age profile is ${age.label}.` : ""
      }${extra ? " " + extra : ""}`,
      citations: evidence.map((e) => `openFDA label "${e.label}" (${e.section})`),
    });
  });
  return flags;
}

// Mark flags that involve a prescription product (stronger UI copy).
export function markRx(flags: Flag[], products: P[]) {
  const rxBrands = new Set(products.filter((p) => p.rx).map((p) => p.brand));
  for (const f of flags) if (f.products.some((b) => rxBrands.has(b))) f.rx = true;
}

export async function interactionFlags(products: P[]): Promise<{ flags: Flag[]; sections: (LabelSections | null)[] }> {
  const sections = await Promise.all(products.map((p) => productSections(p)));
  const flags: Flag[] = [];
  products.forEach((a, ai) => {
    const sec = sections[ai];
    if (!sec) return;
    products.forEach((b, bi) => {
      if (ai === bi) return;
      const evidence: NonNullable<Flag["evidence"]> = [];
      const ings = new Set<string>();
      let severity: "red" | "yellow" | null = null;
      for (const key of new Set(b.keys)) {
        if (a.keys.includes(key)) continue; // shared ingredient = the duplicate check's job
        for (const { re } of termsFor(key)) {
          // A's label naming its own class (e.g. an opioid label saying "opioids") isn't about B.
          for (const [level, list] of [["red", sec.red], ["yellow", sec.yellow]] as const) {
            for (const s of list) {
              const m = re.exec(s.text);
              if (!m) continue;
              const quote = sentenceAround(s.text, m.index);
              if (!evidence.some((e) => e.quote === quote)) evidence.push({ label: sec.label_name, section: s.section, quote });
              ings.add(key);
              if (level === "red") severity = "red";
              else severity ??= "yellow";
              break;
            }
          }
        }
      }
      if (!severity || !evidence.length) return;
      // Prefer the strongest section as the first quote.
      evidence.sort((x, y) => Number(["boxed warning", "contraindications", "Do not use"].includes(y.section)) - Number(["boxed warning", "contraindications", "Do not use"].includes(x.section)));
      const id = `rx-${[a.brand, b.brand].map((x) => x.toLowerCase().replace(/[^a-z0-9]/g, "")).join("-")}`;
      // One flag per pair: if B's label also names A, keep the stronger one.
      const twin = flags.find((f) => f.id === `rx-${[b.brand, a.brand].map((x) => x.toLowerCase().replace(/[^a-z0-9]/g, "")).join("-")}`);
      if (twin) {
        if (twin.severity === "yellow" && severity === "red") flags.splice(flags.indexOf(twin), 1);
        else {
          for (const e of evidence.slice(0, 1)) if (!twin.evidence!.some((x) => x.quote === e.quote)) twin.evidence!.push(e);
          return;
        }
      }
      flags.push({
        id,
        kind: "interaction",
        severity,
        title: `${a.brand} + ${b.brand}: ${severity === "red" ? "label warning" : "label lists an interaction"}`,
        ingredients: [...ings],
        products: [a.brand, b.brand],
        source: `openFDA label "${sec.label_name}" (${evidence[0].section})`,
        rx: !!(a.rx || b.rx || sec.rx),
        evidence: evidence.slice(0, 3),
      });
    });
  });
  return { flags, sections };
}
