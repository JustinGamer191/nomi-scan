// Shared check pipeline for Live mode: merge sightings, fetch labels, run the
// deterministic checks, and attach label-grounded explanations.
import { ageFlags } from "./ageChecks";
import type { AgeGroup } from "./ages";
import { findFlags, normalizeIngredient, overallStatus } from "./checks";
import { getLabel } from "./fda";
import { templateExplanation } from "./grok";
import type { Flag, LabelInfo, Product } from "./types";

export type SeenProduct = Product & { keys: string[]; seen: number };

const brandKey = (b: string) => b.toLowerCase().replace(/[^a-z0-9]/g, "");

export function productId(p: Product) {
  const keys = p.active_ingredients.map((a) => normalizeIngredient(a.name)).filter(Boolean);
  return `${brandKey(p.brand)}|${[...new Set(keys)].sort().join(",")}`;
}

// Add new sightings to the running list. Same brand + same ingredients = same product.
export function mergeSeen(seen: SeenProduct[], incoming: Product[], max = 5) {
  const map = new Map(seen.map((p) => [productId(p), { ...p }]));
  const added: string[] = [];
  for (const p of incoming) {
    const id = productId(p);
    const keys = p.active_ingredients.map((a) => normalizeIngredient(a.name)).filter(Boolean);
    const prev = map.get(id);
    if (prev) {
      prev.seen += 1;
      if (p.confidence > prev.confidence) Object.assign(prev, { ...p, keys, seen: prev.seen });
    } else if (map.size < max) {
      map.set(id, { ...p, keys, seen: 1 });
      added.push(p.brand);
    }
  }
  return { products: [...map.values()], added };
}

export async function analyze(products: SeenProduct[], age: AgeGroup) {
  const unique = [...new Set(products.flatMap((p) => p.keys))];
  const labelList = await Promise.all(unique.map((i) => getLabel(i)));
  const labels: Record<string, LabelInfo> = Object.fromEntries(labelList.map((l) => [l.ingredient, l]));
  const flags: Flag[] = findFlags(products);
  // Live mode uses the deterministic, quote-the-label explanation: instant and grounded.
  for (const f of flags) Object.assign(f, templateExplanation(f, labels));
  // Age flags come with their own label-quoting explanation.
  flags.push(...(await ageFlags(products, age, labels)).flags);
  const uncertain = products.some((p) => p.confidence < 0.6) || labelList.some((l) => !l.found);
  return {
    labels,
    flags,
    status: products.length ? overallStatus(flags, uncertain) : ("green" as const),
  };
}
