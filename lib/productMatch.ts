// Decide when two sightings are the same product.
import { normalizeIngredient } from "./checks";
import type { Product } from "./types";

// Dosage-form and packaging words the model adds inconsistently ("Equate Ibuprofen"
// vs "Equate Ibuprofen Tablets"). Stripped before comparing brands.
const FORM_WORDS =
  /\b(tablets?|caplets?|capsules?|softgels?|liquid ?gels?|gelcaps?|gels?|pills?|coated|film|oral|liquid|suspension|syrup|chewables?|count|ct|pack|bottle|otc)\b/g;

export const brandKey = (b: string) =>
  b.toLowerCase().replace(FORM_WORDS, " ").replace(/[^a-z0-9]/g, "");

// Ingredient + strength signature, so "ibuprofen 200 mg" and "ibuprofen 400 mg" stay separate.
function signature(p: Product) {
  return p.active_ingredients
    .map((a) => `${normalizeIngredient(a.name)}:${(a.strength || "").toLowerCase().replace(/\s+/g, "")}`)
    .sort()
    .join(",");
}

export function productId(p: Product) {
  return `${brandKey(p.brand)}|${signature(p)}`;
}

// Same product when the ingredient+strength signature matches and one brand name
// contains the other after stripping form words.
export function sameProduct(a: Product, b: Product) {
  if (signature(a) !== signature(b)) return false;
  const ka = brandKey(a.brand);
  const kb = brandKey(b.brand);
  return ka === kb || (ka.length > 0 && kb.length > 0 && (ka.includes(kb) || kb.includes(ka)));
}
