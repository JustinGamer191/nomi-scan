import { extractJson, hasKey, searchResponses } from "./grok";

export type RecallItem = {
  source: "openFDA" | "Grok web search";
  title: string;
  date?: string;
  detail?: string;
  url: string;
};

export type RecallReport = {
  brand: string;
  items: RecallItem[];
  grok: "ok" | "unavailable" | "mock" | "error";
  note?: string;
};

// Words that are too generic to identify a product in recall text.
const STOP = new Set([
  "extra", "strength", "maximum", "cold", "flu", "and", "&", "the", "severe", "day", "night",
  "children", "childrens", "children's", "kids", "pm", "relief", "pain", "caplets", "tablets",
  "liquid", "liquicaps", "gels", "cough", "sinus", "allergy", "multi", "symptom", "vicks", "rapid",
  "release", "plus", "max", "adult", "original",
]);

function tokens(brand: string): string[] {
  return brand
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .sort((a, b) => b.length - a.length);
}

function fdaDate(d?: string) {
  return d && d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : d;
}

// openFDA drug enforcement (recall) reports from the last 2 years. No key needed.
export async function fdaRecalls(brand: string): Promise<RecallItem[]> {
  const now = new Date();
  const from = new Date(now.getTime() - 730 * 864e5);
  const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const range = `report_date:[${ymd(from)} TO ${ymd(now)}]`;
  for (const t of tokens(brand).slice(0, 2)) {
    const search = `product_description:"${t}" AND ${range}`;
    const url = `https://api.fda.gov/drug/enforcement.json?search=${encodeURIComponent(search)}&sort=report_date:desc&limit=5`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue; // 404 = no recalls for this term
      const data = (await res.json()) as {
        results?: {
          recall_number: string;
          report_date: string;
          classification: string;
          status: string;
          recalling_firm: string;
          reason_for_recall: string;
          product_description: string;
        }[];
      };
      if (!data.results?.length) continue;
      return data.results.map((r) => ({
        source: "openFDA" as const,
        title: `${r.classification} recall (${r.status}) by ${r.recalling_firm}`,
        date: fdaDate(r.report_date),
        detail: `${r.reason_for_recall.slice(0, 200)} | Product: ${r.product_description.slice(0, 140)}`,
        url: `https://api.fda.gov/drug/enforcement.json?search=recall_number:"${r.recall_number}"`,
      }));
    } catch {
      continue;
    }
  }
  return [];
}

// Grok live web search for recent recalls / FDA safety alerts.
async function grokAlerts(brand: string, ingredients: string[]): Promise<{ items: RecallItem[] }> {
  const prompt = `Search the web for U.S. FDA recalls or FDA safety alerts from the last 24 months that
affect the OTC product "${brand}" (active ingredients: ${ingredients.join(", ")}).
Only report items you actually found in search results, each with its source URL.
Prefer fda.gov and the manufacturer's site. Do not guess. If nothing relevant is found, return an empty list.
Return ONLY raw JSON: {"alerts":[{"title": string, "date": "YYYY-MM-DD or empty", "summary": string, "url": string}]}`;
  const { text, urls } = await searchResponses(prompt);
  const parsed = extractJson(text) as { alerts?: { title?: string; date?: string; summary?: string; url?: string }[] };
  const items = (parsed.alerts ?? [])
    .filter((a) => a.title && a.url && /^https?:\/\//.test(a.url))
    // Keep only URLs Grok actually cited, when citations are available.
    .filter((a) => urls.length === 0 || urls.some((u) => u.startsWith(a.url!) || a.url!.startsWith(u)))
    .slice(0, 4)
    .map((a) => ({
      source: "Grok web search" as const,
      title: String(a.title),
      date: a.date || undefined,
      detail: a.summary ? String(a.summary).slice(0, 240) : undefined,
      url: String(a.url),
    }));
  return { items };
}

export async function recallReport(
  brand: string,
  ingredients: string[],
  mock: boolean,
): Promise<RecallReport> {
  const fdaP = fdaRecalls(brand);
  let grok: RecallReport["grok"] = "ok";
  let note: string | undefined;
  let grokItems: RecallItem[] = [];
  if (mock) {
    grok = "mock";
    note = "MOCK mode: Grok live search skipped. openFDA recall data is live.";
  } else if (!hasKey()) {
    grok = "unavailable";
    note = "Grok live search unavailable (no API key). Showing openFDA recall data only.";
  } else {
    try {
      grokItems = (await grokAlerts(brand, ingredients)).items;
    } catch {
      grok = "error";
      note = "Grok live search failed. Showing openFDA recall data only.";
    }
  }
  const items = [...(await fdaP), ...grokItems];
  return { brand, items, grok, note };
}
