import { ageGroup } from "./ages";
import type { ScanResult } from "./types";

const STATUS = {
  red: "Warning — ask a pharmacist before using these products together.",
  yellow: "Caution — check overlaps and uncertainties with a pharmacist.",
  green: "No overlaps found in the app's limited checks. This does not establish safety.",
};

/** A portable snapshot of the scan, without photos, chat, or dose logs. */
export function buildScanSummary(result: ScanResult, scannedAt: string): string {
  const lines = [
    "Nomi Scan — pharmacist discussion summary",
    `Scanned at: ${scannedAt}`,
    ...(result.mock ? ["DEMO ONLY — these are sample products, not a scan of your medicines."] : []),
    `Age group: ${ageGroup(result.age).label}`,
    `Result: ${result.status.toUpperCase()}. ${STATUS[result.status]}`,
    "Not medical advice. Ask a pharmacist. Verify the products and strengths against the packaging.",
    "",
    "PRODUCTS DETECTED",
  ];
  for (const product of result.products) {
    lines.push(`- ${product.brand} (recognition confidence: ${Math.round(product.confidence * 100)}%)`);
    for (const ingredient of product.active_ingredients) {
      lines.push(`  - ${ingredient.name}: ${ingredient.strength || "Strength not read"}`);
    }
  }
  lines.push("", "WARNINGS AND UNCERTAINTIES");
  if (!result.flags.length) lines.push("No flags returned. The app does not check every possible interaction.");
  for (const flag of result.flags) {
    lines.push(`- [${flag.severity.toUpperCase()}] ${flag.title}`, `  Products: ${flag.products.join(" + ")}`);
    if (flag.explanation) lines.push(`  ${flag.explanation}`);
    lines.push(`  Rule source: ${flag.source}`);
    for (const citation of flag.citations ?? []) lines.push(`  Citation: ${citation}`);
  }
  for (const hint of result.hints) lines.push(`- Photo issue: ${hint}`);
  for (const note of result.notes) lines.push(`- Note: ${note}`);
  lines.push("", "LABEL SOURCES (openFDA)");
  for (const [key, label] of Object.entries(result.labels)) {
    lines.push(`- ${key}: ${label.found ? label.label_name || "Label found" : "No label found — information is incomplete"}`);
    if (label.found && label.set_id) {
      lines.push(`  https://api.fda.gov/drug/label.json?search=${encodeURIComponent(`set_id:"${label.set_id}"`)}`);
    }
  }
  lines.push("", "QUESTIONS FOR YOUR PHARMACIST",
    "- Are these products appropriate for this age group and my other medicines or conditions?",
    "- Which ingredients overlap, and which product should I avoid or replace?",
    "- What directions on my exact packaging should I follow?",
    "", "This summary covers the scan only. Recall checks, chat answers, and dose logs are not included.");
  return lines.join("\n") + "\n";
}
