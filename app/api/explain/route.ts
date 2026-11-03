// Grok explanations for flags found in Live mode, grounded only in openFDA label text
// (re-fetched here) and the flag's own quoted evidence. Debounced and cached by the client.
import { getLabel } from "@/lib/fda";
import { explainFlags, hasKey, templateExplanation } from "@/lib/grok";
import type { Flag, LabelInfo } from "@/lib/types";

export const maxDuration = 60;

function cleanFlags(raw: unknown): Flag[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f) => f && typeof f.id === "string" && Array.isArray(f.ingredients) && Array.isArray(f.products))
    .slice(0, 10)
    .map((f) => ({
      id: String(f.id),
      kind: f.kind,
      severity: f.severity === "red" ? "red" : "yellow",
      title: String(f.title ?? "").slice(0, 200),
      ingredients: f.ingredients.map(String).slice(0, 6),
      products: f.products.map(String).slice(0, 5),
      source: String(f.source ?? "").slice(0, 200),
      rx: !!f.rx,
      evidence: Array.isArray(f.evidence)
        ? f.evidence.slice(0, 3).map((e: { label: unknown; section: unknown; quote: unknown }) => ({
            label: String(e.label).slice(0, 120),
            section: String(e.section).slice(0, 60),
            quote: String(e.quote).slice(0, 500),
          }))
        : undefined,
    }));
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { flags?: unknown; mock?: boolean };
  const flags = cleanFlags(body.flags);
  if (!flags.length) return Response.json({ explanations: {} });
  const keys = [...new Set(flags.flatMap((f) => f.ingredients))];
  const labels: Record<string, LabelInfo> = Object.fromEntries((await Promise.all(keys.map(getLabel))).map((l) => [l.ingredient, l]));
  const mock = !!body.mock || process.env.MOCK === "1";
  let out: Record<string, { explanation: string; citations: string[] }> = {};
  if (!mock && hasKey()) {
    try {
      out = await explainFlags(flags, labels);
    } catch {
      out = {};
    }
  }
  for (const f of flags) out[f.id] ??= templateExplanation(f, labels);
  return Response.json({ explanations: out, by: !mock && hasKey() ? "grok" : "template" });
}
