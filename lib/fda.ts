import type { LabelInfo } from "./types";

const BASE = "https://api.fda.gov/drug/label.json";

type FdaLabel = {
  set_id?: string;
  warnings?: string[];
  boxed_warning?: string[];
  warnings_and_cautions?: string[];
  do_not_use?: string[];
  ask_doctor?: string[];
  stop_use?: string[];
  openfda?: { brand_name?: string[]; generic_name?: string[] };
};

const cache = new Map<string, LabelInfo>();

function clip(arr?: string[], max = 1200): string | undefined {
  if (!arr || arr.length === 0) return undefined;
  const s = arr.join(" ").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "..." : s;
}

async function query(search: string): Promise<FdaLabel | null> {
  const url = `${BASE}?search=${encodeURIComponent(search)}&limit=1`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (res.status === 404) return null; // openFDA returns 404 for "No matches found!"
  if (!res.ok) throw new Error(`openFDA ${res.status}`);
  const data = (await res.json()) as { results?: FdaLabel[] };
  return data.results?.[0] ?? null;
}

// Look up one label for an ingredient. Prefer single-ingredient products
// (exact generic name), then fall back to any label mentioning it.
export async function getLabel(ingredient: string): Promise<LabelInfo> {
  const cached = cache.get(ingredient);
  if (cached) return cached;

  let label: FdaLabel | null = null;
  try {
    const upper = ingredient.toUpperCase();
    const otc = ` AND openfda.product_type:"HUMAN OTC DRUG"`;
    label =
      (await query(`openfda.generic_name.exact:"${upper}"${otc}`)) ??
      (await query(`openfda.generic_name:"${ingredient}"${otc}`)) ??
      (await query(`openfda.generic_name.exact:"${upper}"`)) ??
      (await query(`openfda.generic_name:"${ingredient}"`)) ??
      (await query(`openfda.substance_name:"${ingredient}"`));
  } catch {
    label = null;
  }

  const info: LabelInfo = label
    ? {
        ingredient,
        found: true,
        label_name:
          label.openfda?.brand_name?.[0] ?? label.openfda?.generic_name?.[0] ?? ingredient,
        set_id: label.set_id,
        warnings: clip(label.warnings ?? label.boxed_warning ?? label.warnings_and_cautions),
        do_not_use: clip(label.do_not_use, 600),
        ask_doctor: clip(label.ask_doctor, 600),
        stop_use: clip(label.stop_use, 600),
      }
    : { ingredient, found: false };

  cache.set(ingredient, info);
  return info;
}

export function labelCitation(l: LabelInfo): string {
  return `openFDA label "${l.label_name}" (${l.ingredient}${l.set_id ? `, set_id ${l.set_id}` : ""})`;
}
