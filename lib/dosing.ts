import { normalizeIngredient } from "./checks";
import { chat, extractJson, hasKey } from "./grok";
import type { Product } from "./types";

export type DoseRule = {
  brand: string;
  found: boolean;
  label_name?: string;
  set_id?: string;
  directions?: string; // adult directions snippet the numbers came from
  min_interval_h: number | null;
  units_per_dose: number | null;
  unit: string | null;
  max_units_24h: number | null;
  max_doses_24h: number | null;
  mg_per_dose: Record<string, number>; // ingredient key -> mg in one dose
  parsed_by: "grok" | "rules" | "none";
};

export type DosingResult = {
  rules: DoseRule[];
  caps: Record<string, { mg: number; source: string }>; // ingredient key -> max mg / 24h
  notes: string[];
};

type FdaLabel = {
  set_id?: string;
  dosage_and_administration?: string[];
  warnings?: string[];
  openfda?: { brand_name?: string[]; generic_name?: string[]; substance_name?: string[] };
};

const STOP = new Set(["extra", "strength", "maximum", "cold", "flu", "vicks", "and", "severe", "the", "relief", "pain"]);

async function search(q: string, limit = 1): Promise<FdaLabel[]> {
  const url = `https://api.fda.gov/drug/label.json?search=${encodeURIComponent(q)}&limit=${limit}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    return ((await res.json()) as { results?: FdaLabel[] }).results ?? [];
  } catch {
    return [];
  }
}

const labelCache = new Map<string, FdaLabel | null>();

// Find a label for this exact product: brand word match AND the same set of
// active ingredients. Fall back to a single-ingredient OTC label.
export async function productLabel(p: Product & { keys: string[] }): Promise<FdaLabel | null> {
  const cacheKey = `${p.brand}|${[...p.keys].sort().join(",")}`;
  if (labelCache.has(cacheKey)) return labelCache.get(cacheKey)!;
  const want = [...new Set(p.keys)].sort().join(",");
  const sameIngredients = (l: FdaLabel) =>
    [...new Set((l.openfda?.substance_name ?? []).map(normalizeIngredient))].sort().join(",") === want;
  const otc = ` AND openfda.product_type:"HUMAN OTC DRUG"`;
  let found: FdaLabel | null = null;
  const words = p.brand
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
  for (const w of words) {
    const hits = await search(`openfda.brand_name:"${w}"${otc} AND _exists_:dosage_and_administration`, 25);
    found = hits.find(sameIngredients) ?? null;
    if (found) break;
  }
  if (!found && p.keys.length === 1) {
    const hits = await search(
      `openfda.generic_name.exact:"${p.keys[0].toUpperCase()}"${otc} AND _exists_:dosage_and_administration`,
      5,
    );
    found = hits[0] ?? null;
  }
  labelCache.set(cacheKey, found);
  return found;
}

// Keep the adult part of the directions (that's what we schedule for).
function adultDirections(text: string): string {
  const t = text.replace(/\s+/g, " ").replace(/^Directions\s*/i, "");
  const start = t.search(/adults?( and| &)? (children )?(12|twelve)/i);
  let s = start >= 0 ? t.slice(start) : t;
  const end = s.search(/children (under|4 to|6 to|2 to)|children \d+ to under/i);
  if (end > 0) s = s.slice(0, end);
  // Max-per-24h phrases sometimes come before the adult line.
  const pre = start > 0 ? t.slice(0, start).match(/do not (exceed|take more than)[^.]*?24[- ]?(hours?|hrs?|hour period)/i) : null;
  return (pre ? pre[0] + " " : "") + s.trim();
}

const UNIT = "(tablets?|caplets?|gelcaps?|liquicaps?|liquid ?caps?|softgels?|capsules?|geltabs?|ml|mL|teaspoons?|tablespoons?|doses?)";

export function parseDirections(text: string) {
  const units = new RegExp(`take (\\d+) ${UNIT}`, "i").exec(text) ?? new RegExp(`(\\d+) ${UNIT} (?:with water )?every`, "i").exec(text);
  const interval = /every (\d+)(?:\s*(?:to|-)\s*\d+)?\s*(?:hours?|hrs?)/i.exec(text);
  const maxUnits = new RegExp(
    `(?:do not take more than|do not exceed|not more than)\\s+(\\d+)\\s+${UNIT}\\s+(?:in|per|within)\\s+(?:a\\s+|any\\s+)?24[- ]?(?:hours?|hrs?|hour period)`,
    "i",
  ).exec(text);
  const unitsPer = units ? Number(units[1]) : null;
  const unit = units ? units[2].toLowerCase() : null;
  let maxU = maxUnits ? Number(maxUnits[1]) : null;
  let maxDoses: number | null = null;
  if (maxUnits && /^doses?$/i.test(maxUnits[2])) {
    maxDoses = maxU;
    maxU = unitsPer && maxDoses ? unitsPer * maxDoses : null;
  } else if (maxU && unitsPer) {
    maxDoses = Math.floor(maxU / unitsPer);
  }
  return {
    min_interval_h: interval ? Number(interval[1]) : null,
    units_per_dose: unitsPer,
    unit,
    max_units_24h: maxU,
    max_doses_24h: maxDoses,
  };
}

type Parsed = ReturnType<typeof parseDirections>;

// Grok reads the directions; code checks every number against the source text.
async function grokParse(text: string): Promise<Parsed | null> {
  const out = await chat([
    {
      role: "system",
      content: `Extract ADULT dosing limits from OTC label directions. Use only numbers present in the text.
Return ONLY raw JSON: {"min_interval_h": number|null, "units_per_dose": number|null, "unit": string|null, "max_units_24h": number|null, "max_doses_24h": number|null}
min_interval_h is the SHORTEST allowed gap in hours (for "every 8 to 12 hours" use 8). null when the text does not say.`,
    },
    { role: "user", content: text },
  ]);
  const j = extractJson(out) as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number) => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
  };
  const inText = (n: number | null) => n === null || new RegExp(`\\b${n}\\b`).test(text);
  const r: Parsed = {
    min_interval_h: num(j.min_interval_h, 1, 24),
    units_per_dose: num(j.units_per_dose, 0.25, 40),
    unit: typeof j.unit === "string" ? j.unit.toLowerCase() : null,
    max_units_24h: num(j.max_units_24h, 1, 200),
    max_doses_24h: num(j.max_doses_24h, 1, 24),
  };
  // Validate: every number must literally appear in the label text, except
  // max_doses_24h which may be derived (max_units / units_per_dose).
  if (![r.min_interval_h, r.units_per_dose, r.max_units_24h].every(inText)) return null;
  if (r.max_doses_24h !== null && !inText(r.max_doses_24h)) {
    if (!(r.max_units_24h && r.units_per_dose && r.max_doses_24h === Math.floor(r.max_units_24h / r.units_per_dose))) return null;
  }
  if (r.max_doses_24h === null && r.max_units_24h && r.units_per_dose) {
    r.max_doses_24h = Math.floor(r.max_units_24h / r.units_per_dose);
  }
  return r;
}

function mgOf(strength: string): number | null {
  const m = /([\d.]+)\s*mg/i.exec(strength);
  return m ? Number(m[1]) : null;
}

// Ingredient-wide daily caps stated in label warnings, e.g. acetaminophen 4,000 mg.
function capsFrom(warnings: string, labelName: string, into: DosingResult["caps"]) {
  const re = /more than ([\d,]+)\s*mg of ([a-z ]+?) in 24 hours/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(warnings))) {
    const key = normalizeIngredient(m[2]);
    const mg = Number(m[1].replace(/,/g, ""));
    if (mg > 0 && (!into[key] || mg < into[key].mg)) into[key] = { mg, source: `openFDA label "${labelName}" warnings` };
  }
}

export async function dosingFor(products: (Product & { keys: string[] })[], mock: boolean): Promise<DosingResult> {
  const notes: string[] = [];
  const caps: DosingResult["caps"] = {};
  const useGrok = !mock && hasKey();
  if (!useGrok) notes.push(mock ? "MOCK mode: directions parsed by built-in rules, not Grok." : "No API key: directions parsed by built-in rules.");

  const rules = await Promise.all(
    products.map(async (p): Promise<DoseRule> => {
      const label = await productLabel(p);
      const empty: DoseRule = {
        brand: p.brand,
        found: false,
        min_interval_h: null,
        units_per_dose: null,
        unit: null,
        max_units_24h: null,
        max_doses_24h: null,
        mg_per_dose: {},
        parsed_by: "none",
      };
      const raw = label?.dosage_and_administration?.join(" ");
      if (!label || !raw) return empty;
      const labelName = label.openfda?.brand_name?.[0] ?? p.brand;
      if (label.warnings) capsFrom(label.warnings.join(" "), labelName, caps);
      const directions = adultDirections(raw).slice(0, 700);
      let parsed: Parsed | null = null;
      let by: DoseRule["parsed_by"] = "rules";
      if (useGrok) {
        try {
          parsed = await grokParse(directions);
          if (parsed) by = "grok";
        } catch {
          parsed = null;
        }
      }
      if (!parsed) parsed = parseDirections(directions);
      const mg_per_dose: Record<string, number> = {};
      p.active_ingredients.forEach((a, i) => {
        const mg = mgOf(a.strength);
        const per = parsed!.units_per_dose ?? 1;
        if (mg && /tablet|caplet|gelcap|liquicap|softgel|capsule|geltab|liquid ?cap/i.test(parsed!.unit ?? "tablet")) {
          mg_per_dose[p.keys[i]] = mg * per;
        }
      });
      return {
        ...empty,
        found: true,
        label_name: labelName,
        set_id: label.set_id,
        directions,
        ...parsed,
        mg_per_dose,
        parsed_by: by,
      };
    }),
  );

  // Ingredient-level caps can also come from the plain ingredient label.
  const keys = [...new Set(products.flatMap((p) => p.keys))];
  await Promise.all(
    keys.map(async (k) => {
      if (caps[k]) return;
      const [l] = await search(`openfda.generic_name.exact:"${k.toUpperCase()}" AND openfda.product_type:"HUMAN OTC DRUG"`);
      if (l?.warnings) capsFrom(l.warnings.join(" "), l.openfda?.brand_name?.[0] ?? k, caps);
    }),
  );

  for (const r of rules) if (!r.found) notes.push(`No dosing directions found for ${r.brand}. Follow the box.`);
  return { rules, caps, notes };
}
