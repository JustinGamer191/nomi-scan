// Deterministic age-profile checks. No LLM involved here.
import { type AgeGroup, isUnder12 } from "./ages";
import { productLabel } from "./dosing";
import { labelCitation } from "./fda";
import type { Flag, LabelInfo, Product } from "./types";

type AgeRule = {
  id: string;
  members: string[];
  applies: (g: AgeGroup) => boolean;
  severity: "red" | "yellow";
  title: string;
  why: string;
  source: string;
  quote?: RegExp; // phrase to quote from the ingredient's openFDA label
};

const SEDATING = ["diphenhydramine", "doxylamine", "chlorpheniramine", "brompheniramine", "triprolidine", "pyrilamine"];

// Well-known age limits for OTC ingredients. Each rule cites where it comes from.
export const AGE_RULES: AgeRule[] = [
  {
    // Source: 21 CFR 201.314(h): required Reye's syndrome warning on OTC aspirin
    // and salicylate products: "Children and teenagers who have or are recovering
    // from chicken pox or flu-like symptoms should not use this product."
    id: "reye",
    members: ["aspirin", "bismuth subsalicylate", "magnesium salicylate", "choline salicylate"],
    applies: (g) => g.max <= 18,
    severity: "red",
    title: "Aspirin-type ingredient: not for children or teens",
    why: "Aspirin and other salicylates are linked to Reye's syndrome, a rare but serious illness, in children and teenagers recovering from chickenpox or flu-like symptoms.",
    source: "21 CFR 201.314(h) (OTC salicylate Reye's syndrome warning)",
    quote: /Reye'?s syndrome:?[^.]*\./i,
  },
  {
    // Source: FDA 2008 public health advisory (do not use OTC cough/cold medicines
    // under 2) and the 2008 voluntary relabeling to "do not use" under 4.
    id: "cough-cold-under-4",
    members: [...SEDATING, "dextromethorphan", "guaifenesin", "pseudoephedrine", "phenylephrine"],
    applies: (g) => g.max <= 4,
    severity: "red",
    title: "Cough and cold medicine: not for children under 4",
    why: "FDA advises against OTC cough and cold medicines for children under 2, and these products are labeled \"do not use\" for children under 4.",
    source: "FDA advisory on OTC cough and cold medicines for young children (2008); labels say do not use under 4",
  },
  {
    // Source: 21 CFR 201.326(a)(1) stomach bleeding warning: "The chance is higher
    // if you are age 60 or older".
    id: "nsaid-60",
    members: ["ibuprofen", "naproxen", "aspirin", "ketoprofen"],
    applies: (g) => g.min >= 60,
    severity: "yellow",
    title: "NSAID at 60 or older: higher stomach bleeding risk",
    why: "The FDA-required NSAID label lists being 60 or older as a reason the chance of stomach bleeding is higher.",
    source: "21 CFR 201.326 (OTC NSAID stomach bleeding warning)",
    quote: /The chance is higher if you[^.]{0,120}?60 or older/i,
  },
  {
    // Source: American Geriatrics Society Beers Criteria (2023): avoid
    // first-generation (sedating) antihistamines in older adults.
    id: "antihistamine-65",
    members: SEDATING,
    applies: (g) => g.min >= 65,
    severity: "yellow",
    title: "Sedating antihistamine at 65 or older",
    why: "The American Geriatrics Society Beers Criteria lists sedating antihistamines as medicines older adults should generally avoid, because they raise the risk of confusion and falls.",
    source: "AGS Beers Criteria (2023), first-generation antihistamines",
    quote: /(marked )?drowsiness[^.]*/i,
  },
];

function quoteFrom(l: LabelInfo, re: RegExp): string | null {
  const text = [l.warnings, l.do_not_use, l.ask_doctor].filter(Boolean).join(" ").replace(/\s+/g, " ");
  const m = re.exec(text);
  return m ? m[0].trim() : null;
}

// "children under 12 years: do not use", "children 4 to under 12 yrs ask a doctor"
const LIMIT_RE =
  /children (?:(\d+) (?:(?:years?|yrs?\.?) )?to )?under (\d+) (?:years?|yrs?\.?)(?: of age)?\s*:?\s*(do not use|ask a doctor)/gi;

export function labelAgeLimit(directions: string, g: AgeGroup) {
  const text = directions.replace(/\s+/g, " ");
  let best: { action: "do not use" | "ask a doctor"; phrase: string } | null = null;
  for (const m of text.matchAll(LIMIT_RE)) {
    const from = m[1] ? Number(m[1]) : 0;
    const under = Number(m[2]);
    if (g.min < from || g.max > under) continue; // the whole age group must fall in the range
    const action = m[3].toLowerCase() as "do not use" | "ask a doctor";
    if (!best || (action === "do not use" && best.action !== "do not use")) best = { action, phrase: m[0] };
  }
  return best;
}

export async function ageFlags(
  products: (Product & { keys: string[] })[],
  g: AgeGroup,
  labels: Record<string, LabelInfo>,
): Promise<{ flags: Flag[]; notes: string[] }> {
  const flags: Flag[] = [];
  const notes: string[] = [];

  // 1. Ingredient rules for this age group.
  for (const rule of AGE_RULES) {
    if (!rule.applies(g)) continue;
    const hits = products.flatMap((p) => [...new Set(p.keys)].filter((k) => rule.members.includes(k)).map((k) => ({ k, brand: p.brand })));
    if (!hits.length) continue;
    const ingredients = [...new Set(hits.map((h) => h.k))];
    const brands = [...new Set(hits.map((h) => h.brand))];
    const found = ingredients.map((i) => labels[i]).filter((l): l is LabelInfo => !!l?.found);
    const quotes = rule.quote
      ? found.map((l) => {
          const q = quoteFrom(l, rule.quote!);
          return q ? `The ${l.label_name} label says: "${q}"` : "";
        })
      : [];
    flags.push({
      id: `age-${rule.id}`,
      kind: "age",
      severity: rule.severity,
      title: rule.title,
      ingredients,
      products: brands,
      source: rule.source,
      explanation: `${brands.join(" and ")} contain${brands.length > 1 ? "" : "s"} ${ingredients.join(" and ")}. ${rule.why} ${quotes.filter(Boolean).join(" ")}`.trim(),
      citations: found.map(labelCitation),
    });
  }

  // 2. Kids: the product's own label directions ("children under 12 years: do not use").
  if (isUnder12(g)) {
    const covered = new Set(flags.filter((f) => f.severity === "red").flatMap((f) => f.products));
    const limits = await Promise.all(
      products.map(async (p) => {
        if (covered.has(p.brand)) return null;
        const label = await productLabel(p).catch(() => null);
        const raw = label?.dosage_and_administration?.join(" ");
        const hit = raw ? labelAgeLimit(raw, g) : null;
        if (!label || !hit) return null;
        const name = label.openfda?.brand_name?.[0] ?? p.brand;
        const dnu = hit.action === "do not use";
        const flag: Flag = {
          id: `age-label-${p.brand.toLowerCase().replace(/[^a-z0-9]/g, "")}`,
          kind: "age",
          severity: dnu ? "red" : "yellow",
          title: dnu ? `${p.brand}: label says do not use at this age` : `${p.brand}: label says ask a doctor at this age`,
          ingredients: [...new Set(p.keys)],
          products: [p.brand],
          source: "Product label directions (openFDA)",
          explanation: `The ${name} directions say: "${hit.phrase}". ${dnu ? "Look for a children's version made for this age, or ask a pharmacist." : "Check with a doctor or pharmacist before giving it."}`,
          citations: [`openFDA label "${name}" directions${label.set_id ? ` (set_id ${label.set_id})` : ""}`],
        };
        return flag;
      }),
    );
    flags.push(...limits.filter((f): f is Flag => !!f));
    notes.push(
      `Profile: ${g.label}. Kids' doses go by age or weight on the box's dosing chart, so the adult dose timer is off. Ask a pharmacist if the box has no row for this age.`,
    );
  }

  return { flags, notes };
}
