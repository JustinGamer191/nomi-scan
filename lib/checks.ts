// Deterministic safety checks. No LLM involved here.
import type { Flag, Product } from "./types";

// Salt / form suffixes stripped so "Naproxen Sodium" and "naproxen" match.
const SALT_WORDS = [
  "hydrochloride",
  "hcl",
  "hydrobromide",
  "hbr",
  "succinate",
  "maleate",
  "citrate",
  "sodium",
  "potassium",
  "sulfate",
  "tannate",
  "bitartrate",
  "monohydrate",
  "usp",
];

const ALIASES: Record<string, string> = {
  paracetamol: "acetaminophen",
  apap: "acetaminophen",
  "acetylsalicylic acid": "aspirin",
  asa: "aspirin",
};

export function normalizeIngredient(name: string): string {
  let n = name
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = n.split(" ").filter((w) => w && !SALT_WORDS.includes(w));
  n = words.join(" ");
  return ALIASES[n] ?? n;
}

type ClassRule = {
  id: string;
  members: string[];
  severity: "red" | "yellow";
  title: string;
  source: string;
};

// Well-known OTC combinations to avoid. Each rule cites where it comes from.
export const CLASS_RULES: ClassRule[] = [
  {
    // Source: FDA OTC NSAID labeling, 21 CFR 201.326(a)(1): stomach bleeding warning
    // "chance is higher if you ... take other drugs containing prescription or
    // nonprescription NSAIDs [aspirin, ibuprofen, naproxen, or others]".
    id: "nsaids",
    members: ["ibuprofen", "naproxen", "aspirin", "ketoprofen"],
    severity: "red",
    title: "More than one NSAID pain reliever",
    source: "21 CFR 201.326 (OTC NSAID stomach bleeding warning)",
  },
  {
    // Source: FDA OTC antihistamine monograph, 21 CFR 341.72, and diphenhydramine
    // labels: "do not use with any other product containing diphenhydramine";
    // sedating antihistamines add drowsiness ("marked drowsiness may occur").
    id: "sedating-antihistamines",
    members: [
      "diphenhydramine",
      "doxylamine",
      "chlorpheniramine",
      "brompheniramine",
      "triprolidine",
      "pyrilamine",
    ],
    severity: "yellow",
    title: "More than one sedating antihistamine",
    source: "21 CFR 341.72 (OTC antihistamine drowsiness warnings)",
  },
  {
    // Source: FDA OTC nasal decongestant monograph, 21 CFR 341.80; both are
    // sympathomimetic decongestants with the same heart/blood pressure warnings.
    id: "decongestants",
    members: ["pseudoephedrine", "phenylephrine"],
    severity: "yellow",
    title: "More than one oral decongestant",
    source: "21 CFR 341.80 (OTC nasal decongestant warnings)",
  },
];

export function findFlags(products: (Product & { keys: string[] })[]): Flag[] {
  const flags: Flag[] = [];

  // 1. Same active ingredient in two or more different products.
  const byIngredient = new Map<string, string[]>();
  for (const p of products) {
    for (const k of new Set(p.keys)) {
      byIngredient.set(k, [...(byIngredient.get(k) ?? []), p.brand]);
    }
  }
  for (const [ing, brands] of byIngredient) {
    if (brands.length > 1) {
      flags.push({
        id: `dup-${ing}`,
        kind: "duplicate",
        severity: "red",
        title: `Duplicate ingredient: ${ing}`,
        ingredients: [ing],
        products: brands,
        source: "Same active ingredient found on multiple labels",
      });
    }
  }

  // 2. Different ingredients from the same risky class, across products.
  for (const rule of CLASS_RULES) {
    const hits: { ing: string; brand: string }[] = [];
    for (const p of products) {
      for (const k of new Set(p.keys)) {
        if (rule.members.includes(k)) hits.push({ ing: k, brand: p.brand });
      }
    }
    const distinctIngs = [...new Set(hits.map((h) => h.ing))];
    const distinctBrands = [...new Set(hits.map((h) => h.brand))];
    if (distinctIngs.length > 1 && distinctBrands.length > 1) {
      flags.push({
        id: `class-${rule.id}`,
        kind: "class",
        severity: rule.severity,
        title: rule.title,
        ingredients: distinctIngs,
        products: distinctBrands,
        source: rule.source,
      });
    }
  }

  return flags;
}

export function overallStatus(flags: Flag[], uncertain: boolean): "red" | "yellow" | "green" {
  if (flags.some((f) => f.severity === "red")) return "red";
  if (flags.length > 0 || uncertain) return "yellow";
  return "green";
}
