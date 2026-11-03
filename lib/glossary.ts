// Label terminology, units and abbreviations. Plain facts, no LLM, no imports
// (so it can be unit-tested directly).

type Term = { re: RegExp; answer: string };

const TERMS: Term[] = [
  { re: /\b(mcg|µg|ug|micrograms?|micro)\b/i, answer: "mcg means micrograms. 1 mcg is 1/1000 of a milligram (1,000 mcg = 1 mg), so 50 mcg = 0.05 mg." },
  { re: /\b(mg|milligrams?)\b/i, answer: "mg means milligrams. 1 mg is 1/1000 of a gram (1,000 mg = 1 g)." },
  { re: /\b(ml|milliliters?|millilitres?|cc)\b/i, answer: "mL means milliliters, a liquid volume. 1 mL equals 1 cc; 5 mL is about one teaspoon." },
  { re: /\bmg\s*\/\s*ml\b|\bmcg\s*\/\s*ml\b|\bper ml\b/i, answer: "A strength like 50 mcg/mL means each milliliter of liquid contains 50 micrograms of the drug." },
  { re: /\bq\s?(\d+)\s?h\b/i, answer: "q#h means 'every # hours', e.g. q6h = every 6 hours." },
  { re: /\bbid\b|\bb\.i\.d\.?/i, answer: "BID means twice a day." },
  { re: /\btid\b|\bt\.i\.d\.?/i, answer: "TID means three times a day." },
  { re: /\bqid\b|\bq\.i\.d\.?/i, answer: "QID means four times a day." },
  { re: /\bqd\b|\bq\.d\.?|\bonce daily\b/i, answer: "QD means once a day." },
  { re: /\bqhs\b|\bhs\b/i, answer: "QHS (or HS) means at bedtime." },
  { re: /\bprn\b|\bas needed\b/i, answer: "PRN means 'as needed': only when you have the symptom, never more often than the label allows." },
  { re: /\bpo\b|\bby mouth\b/i, answer: "PO means by mouth." },
  { re: /\b(iv|intravenous)\b/i, answer: "IV means intravenous: given into a vein, by a healthcare provider." },
  { re: /\b(im|intramuscular)\b/i, answer: "IM means intramuscular: injected into a muscle." },
  { re: /\bboxed warning\b|\bblack box\b/i, answer: "A boxed warning is the FDA's strongest label warning, for serious or life-threatening risks." },
  { re: /\b(apap)\b/i, answer: "APAP is an abbreviation for acetaminophen (Tylenol)." },
  { re: /\bnsaids?\b/i, answer: "NSAID means nonsteroidal anti-inflammatory drug, e.g. ibuprofen (Advil) and naproxen (Aleve)." },
  { re: /\bssris?\b/i, answer: "SSRI means selective serotonin reuptake inhibitor, an antidepressant class (e.g. sertraline)." },
  { re: /\bmaois?\b/i, answer: "MAOI means monoamine oxidase inhibitor, an older antidepressant class with many interactions." },
];

// Only answer when the question is actually about meaning/units, not just mentions "mg".
const MEANING = /\b(what('?s| is| are| does)|mean(s|ing)?|stand for|abbreviation|in micro|how many|convert|equal|same as|difference)\b/i;

export function glossaryAnswer(question: string): string | null {
  if (!MEANING.test(question)) return null;
  const hits = TERMS.filter((t) => t.re.test(question)).map((t) => t.answer);
  // "mcg/mL" also matches mg/mL patterns; keep the unique, most specific few.
  return hits.length ? [...new Set(hits)].slice(0, 3).join(" ") : null;
}

const DOSE_Q = /\b(how much|how many|dose|dosage|dosing|can i take|should i take|how often|max(imum)?|overdose|take more)\b/i;
export const isDoseQuestion = (q: string) => DOSE_Q.test(q);

export const RX_DOSE_REFUSAL =
  "Prescription dosing comes from your prescriber; follow the directions on your label or ask your pharmacist.";
