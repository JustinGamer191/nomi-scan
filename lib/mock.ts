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
  // Prescription demo: real openFDA labels drive every flag here.
  //  - Hydrocodone/APAP (Rx) + Tylenol: duplicate acetaminophen (red)
  //  - Sertraline (Rx) label, drug interactions: "Drugs that Interfere with Hemostasis
  //    (Non-selective NSAIDs, Aspirin, Warfarin, etc.)" -> Advil (ibuprofen) (yellow)
  //  - Hydrocodone/APAP label, drug interactions: "Serotonergic Drugs ... selective
  //    serotonin reuptake inhibitors (SSRIs)" -> sertraline (yellow)
  rx: [
    {
      brand: "Sertraline",
      active_ingredients: [{ name: "Sertraline Hydrochloride", strength: "50 mg" }],
      confidence: 0.95,
      rx: true,
      directions: "Take 1 tablet by mouth once daily",
    },
    {
      brand: "Hydrocodone/Acetaminophen",
      active_ingredients: [
        { name: "Hydrocodone Bitartrate", strength: "5 mg" },
        { name: "Acetaminophen", strength: "325 mg" },
      ],
      confidence: 0.93,
      rx: true,
      directions: "Take 1 tablet by mouth every 6 hours as needed for pain",
    },
    { brand: "Tylenol Extra Strength", active_ingredients: [{ name: "Acetaminophen", strength: "500 mg" }], confidence: 0.97 },
    { brand: "Advil", active_ingredients: [{ name: "Ibuprofen", strength: "200 mg" }], confidence: 0.96 },
  ],
  // Regression: one injectable opioid, nothing to overlap with. With a baby/child
  // profile this must be RED (boxed warning + pediatric use), never green.
  fentanyl: [
    {
      brand: "Fentanyl Citrate Injection",
      active_ingredients: [{ name: "Fentanyl Citrate", strength: "50 mcg/mL" }],
      confidence: 0.92,
      rx: true,
    },
  ],
  nolabel: [
    { brand: "Mystery Tonic", active_ingredients: [{ name: "Zorbaxitol", strength: "5 mg" }], confidence: 0.9 },
  ],
};
