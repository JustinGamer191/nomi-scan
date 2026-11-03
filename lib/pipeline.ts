// Shared check pipeline for Live mode: merge sightings, fetch labels, run the
// deterministic checks, and attach label-grounded explanations.
import { ageFlags } from "./ageChecks";
import type { AgeGroup } from "./ages";
import { findFlags, normalizeIngredient, overallStatus } from "./checks";
import { getLabel } from "./fda";
import { interactionFlags, markRx, singleProductFlags } from "./rx";
import { templateExplanation } from "./grok";
import { sameProduct } from "./productMatch";
import type { Flag, LabelInfo, Product } from "./types";

export { brandKey, productId, sameProduct } from "./productMatch";

export type SeenProduct = Product & { keys: string[]; seen: number };

// Add new sightings to the running list.
export function mergeSeen(seen: SeenProduct[], incoming: Product[], max = 5) {
  const list = seen.map((p) => ({ ...p }));
  const added: string[] = [];
  for (const p of incoming) {
    const keys = p.active_ingredients.map((a) => normalizeIngredient(a.name)).filter(Boolean);
    const prev = list.find((q) => sameProduct(q, p));
    if (prev) {
      prev.seen += 1;
      if (p.confidence > prev.confidence) Object.assign(prev, { ...p, keys, seen: prev.seen });
    } else if (list.length < max) {
      list.push({ ...p, keys, seen: 1 });
      added.push(p.brand);
    }
  }
  return { products: list, added };
}

export async function analyze(products: SeenProduct[], age: AgeGroup) {
  const unique = [...new Set(products.flatMap((p) => p.keys))];
  const labelList = await Promise.all(unique.map((i) => getLabel(i)));
  const labels: Record<string, LabelInfo> = Object.fromEntries(labelList.map((l) => [l.ingredient, l]));
  const flags: Flag[] = findFlags(products);
  const xref = await interactionFlags(products);
  flags.push(...xref.flags);
  markRx(flags, products);
  // Live mode uses the deterministic, quote-the-label explanation: instant and grounded.
  for (const f of flags) Object.assign(f, templateExplanation(f, labels));
  // Single-product label warnings and age flags carry their own label-quoting explanation.
  flags.unshift(...singleProductFlags(products, xref.sections, age));
  markRx(flags, products);
  flags.push(...(await ageFlags(products, age, labels)).flags);
  const uncertain = products.some((p) => p.confidence < 0.6) || labelList.some((l) => !l.found);
  return {
    labels,
    flags,
    status: products.length ? overallStatus(flags, uncertain) : ("green" as const),
  };
}
