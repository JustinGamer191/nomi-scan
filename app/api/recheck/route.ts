// Re-run the openFDA lookups and deterministic checks on saved products (from history),
// with no vision call. Explanations are the label-quoting template; the client can
// upgrade them through /api/explain.
import { ageGroup } from "@/lib/ages";
import { MODEL } from "@/lib/grok";
import { analyze, type SeenProduct } from "@/lib/pipeline";
import type { ScanResult } from "@/lib/types";

export const maxDuration = 60;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { products?: SeenProduct[]; age?: string; mock?: boolean };
  const products: SeenProduct[] = (body.products ?? [])
    .filter((p) => p && typeof p.brand === "string" && Array.isArray(p.active_ingredients) && Array.isArray(p.keys))
    .slice(0, 5)
    .map((p) => ({
      brand: String(p.brand),
      active_ingredients: p.active_ingredients.map((a) => ({ name: String(a.name), strength: String(a.strength ?? "") })),
      confidence: Number(p.confidence) || 0.5,
      keys: p.keys.map(String),
      seen: 1,
      ...(p.rx === true ? { rx: true, ...(typeof p.directions === "string" ? { directions: p.directions.slice(0, 200) } : {}) } : {}),
    }));
  if (!products.length) return Response.json({ error: "Nothing to re-check." }, { status: 400 });
  const age = ageGroup(body.age);
  const { labels, flags, status } = await analyze(products, age);
  const result: ScanResult = {
    mock: !!body.mock,
    age: age.id,
    model: `${MODEL} (re-check, no vision)`,
    status,
    products,
    image_count: 0,
    hints: [],
    labels,
    flags,
    notes: ["Re-checked with the latest openFDA labels. Products come from the saved scan."],
  };
  return Response.json(result);
}
