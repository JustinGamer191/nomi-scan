import type { Product } from "./types";

// Canned Grok vision output for MOCK=1: one photo of Tylenol + NyQuil.
export const MOCK_PRODUCTS: Product[] = [
  {
    brand: "Tylenol Extra Strength",
    active_ingredients: [{ name: "Acetaminophen", strength: "500 mg" }],
    confidence: 0.97,
  },
  {
    brand: "Vicks NyQuil Cold & Flu",
    active_ingredients: [
      { name: "Acetaminophen", strength: "325 mg" },
      { name: "Dextromethorphan HBr", strength: "15 mg" },
      { name: "Doxylamine Succinate", strength: "6.25 mg" },
    ],
    confidence: 0.94,
  },
];

// Extra canned scenarios for testing/demo: /api/scan?mock=<name>
export const MOCK_SCENARIOS: Record<string, Product[]> = {
  "1": MOCK_PRODUCTS,
  nsaids: [
    { brand: "Advil", active_ingredients: [{ name: "Ibuprofen", strength: "200 mg" }], confidence: 0.96 },
    { brand: "Aleve", active_ingredients: [{ name: "Naproxen Sodium", strength: "220 mg" }], confidence: 0.95 },
  ],
  green: [
    { brand: "Tylenol Extra Strength", active_ingredients: [{ name: "Acetaminophen", strength: "500 mg" }], confidence: 0.97 },
    { brand: "Claritin", active_ingredients: [{ name: "Loratadine", strength: "10 mg" }], confidence: 0.95 },
  ],
  nolabel: [
    { brand: "Mystery Tonic", active_ingredients: [{ name: "Zorbaxitol", strength: "5 mg" }], confidence: 0.9 },
  ],
};
