import { findFlags, normalizeIngredient, overallStatus } from "@/lib/checks";
import { getLabel } from "@/lib/fda";
import {
  BAD_KEY_HELP,
  BadKeyError,
  KEY_HELP,
  MissingKeyError,
  MODEL,
  explainFlags,
  readBoxes,
  templateExplanation,
  type ImageRead,
} from "@/lib/grok";
import { MOCK_PRODUCTS, MOCK_SCENARIOS } from "@/lib/mock";
import type { LabelInfo, Product, ScanResult } from "@/lib/types";

export const maxDuration = 60;

const MAX_BYTES = 12 * 1024 * 1024;
const MAX_IMAGES = 6;
const MAX_PRODUCTS = 5;

type PerImage = ImageRead & { error?: string };

function brandKey(b: string) {
  return b.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Same product seen in several photos: same brand + same ingredient set -> keep one.
function mergeProducts(reads: PerImage[]) {
  const merged = new Map<string, Product & { keys: string[]; images: number[] }>();
  reads.forEach((r, i) => {
    for (const p of r.products) {
      const keys = p.active_ingredients.map((a) => normalizeIngredient(a.name)).filter(Boolean);
      const id = `${brandKey(p.brand)}|${[...new Set(keys)].sort().join(",")}`;
      const prev = merged.get(id);
      if (!prev) merged.set(id, { ...p, keys, images: [i + 1] });
      else {
        if (!prev.images.includes(i + 1)) prev.images.push(i + 1);
        if (p.confidence > prev.confidence) Object.assign(prev, { ...p, keys, images: prev.images });
      }
    }
  });
  return [...merged.values()];
}

function mockReads(scenario: string, imageCount: number): PerImage[] {
  const canned = MOCK_SCENARIOS[scenario] ?? MOCK_PRODUCTS;
  if (scenario !== "1" || imageCount < 2) return [{ products: canned, unreadable: null }];
  // Two+ photos: Tylenol in photo 1, NyQuil + Tylenol again in photo 2 (exercises dedupe),
  // any further photo comes back unreadable (exercises the per-image hint).
  const [tylenol, nyquil] = MOCK_PRODUCTS;
  return Array.from({ length: imageCount }, (_, i) =>
    i === 0
      ? { products: [tylenol], unreadable: null }
      : i === 1
        ? { products: [nyquil, { ...tylenol, confidence: 0.9 }], unreadable: null }
        : { products: [], unreadable: "labels too small to read" },
  );
}

// MOCK=1 env, or ?mock=1 (also ?mock=nsaids | green | nolabel) for demos without a key.
function mockScenario(req: Request): string | null {
  const q = new URL(req.url).searchParams.get("mock");
  if (q && MOCK_SCENARIOS[q]) return q;
  return process.env.MOCK === "1" ? "1" : null;
}

export async function POST(req: Request) {
  const scenario = mockScenario(req);
  const mock = scenario !== null;
  const notes: string[] = [];

  try {
    // 1. Read products from each photo (or canned output in mock mode).
    const form = await req.formData().catch(() => null);
    const files = [...(form?.getAll("image") ?? []), ...(form?.getAll("images") ?? [])].filter(
      (f): f is File => f instanceof File && f.size > 0,
    );
    if (files.length > MAX_IMAGES) {
      return Response.json({ error: `Up to ${MAX_IMAGES} photos per scan.` }, { status: 400 });
    }

    let reads: PerImage[];
    if (mock) {
      reads = mockReads(scenario!, files.length);
      notes.push(`MOCK mode (${scenario}): canned Grok output, live openFDA lookups.`);
    } else {
      if (!process.env.XAI_API_KEY) return Response.json({ error: KEY_HELP }, { status: 500 });
      if (!files.length) return Response.json({ error: "Upload at least one photo in the 'image' field." }, { status: 400 });
      for (const [i, f] of files.entries()) {
        if (f.size > MAX_BYTES) return Response.json({ error: `Image ${i + 1} is too large (max 12 MB).` }, { status: 413 });
        if (f.type && !f.type.startsWith("image/")) {
          return Response.json({ error: `Image ${i + 1} is not an image.` }, { status: 400 });
        }
      }
      // Parallel per-image calls: smaller prompts, per-image hints, one bad photo doesn't sink the rest.
      const settled = await Promise.allSettled(
        files.map(async (f) => {
          const b64 = Buffer.from(await f.arrayBuffer()).toString("base64");
          return readBoxes(`data:${f.type || "image/jpeg"};base64,${b64}`);
        }),
      );
      for (const r of settled) {
        if (r.status === "rejected" && (r.reason instanceof MissingKeyError || r.reason instanceof BadKeyError)) {
          throw r.reason;
        }
      }
      reads = settled.map((r) =>
        r.status === "fulfilled"
          ? r.value
          : { products: [], unreadable: null, error: r.reason instanceof Error ? r.reason.message : String(r.reason) },
      );
    }

    const n = reads.length;
    const label = (i: number) => (n > 1 ? `Image ${i + 1}` : "Your photo");
    const hints: string[] = [];
    reads.forEach((r, i) => {
      if (r.error) hints.push(`${label(i)}: Grok couldn't read it (${r.error.slice(0, 120)}). Try again.`);
      else if (r.unreadable) hints.push(`${label(i)}: ${r.unreadable}, try a closer photo.`);
      else if (r.products.length === 0 && n > 1) hints.push(`${label(i)}: no medication found.`);
    });

    let merged = mergeProducts(reads);
    if (merged.length === 0) {
      const detail = reads
        .map((r, i) =>
          `${label(i)}: ${r.error ? "could not be read" : r.unreadable ? `${r.unreadable}` : "no medication found"}`,
        )
        .join("; ");
      return Response.json(
        {
          error: `No medication boxes found. ${detail}. Retake with the front of each box filling the frame.`,
          hints,
        },
        { status: 422 },
      );
    }
    const totalSeen = reads.reduce((s, r) => s + r.products.length, 0);
    if (totalSeen > merged.length) notes.push(`Merged ${totalSeen - merged.length} duplicate sighting(s) across photos.`);
    if (merged.length > MAX_PRODUCTS) {
      notes.push(`Found ${merged.length} products; checking the first ${MAX_PRODUCTS}.`);
      merged = merged.slice(0, MAX_PRODUCTS);
    }
    const withKeys = merged;

    // 2. openFDA label for every unique ingredient, in parallel.
    const unique = [...new Set(withKeys.flatMap((p) => p.keys))];
    const labelList = await Promise.all(unique.map((i) => getLabel(i)));
    const labels: Record<string, LabelInfo> = Object.fromEntries(labelList.map((l) => [l.ingredient, l]));
    const missing = labelList.filter((l) => !l.found).map((l) => l.ingredient);
    if (missing.length) notes.push(`No openFDA label found for: ${missing.join(", ")}.`);

    // 3. Deterministic checks.
    const flags = findFlags(withKeys);

    // 4. Plain-English explanations grounded in label text.
    let explained: Record<string, { explanation: string; citations: string[] }> = {};
    if (flags.length) {
      if (mock) {
        explained = Object.fromEntries(flags.map((f) => [f.id, templateExplanation(f, labels)]));
      } else {
        try {
          explained = await explainFlags(flags, labels);
        } catch (e) {
          if (e instanceof BadKeyError) throw e;
          notes.push("Grok explanation failed; showing label text directly.");
        }
      }
    }
    for (const f of flags) {
      const e = explained[f.id] ?? templateExplanation(f, labels);
      f.explanation = e.explanation;
      f.citations = e.citations;
    }

    const lowConfidence = withKeys.some((p) => p.confidence < 0.6);
    if (lowConfidence) notes.push("Some boxes were read with low confidence. Double-check the ingredients.");
    const uncertain = lowConfidence || missing.length > 0 || hints.length > 0;

    const result: ScanResult = {
      mock,
      model: mock ? `${MODEL} (mock)` : MODEL,
      status: overallStatus(flags, uncertain),
      products: withKeys,
      image_count: n,
      hints,
      labels,
      flags,
      notes,
    };
    return Response.json(result);
  } catch (e) {
    if (e instanceof MissingKeyError) return Response.json({ error: KEY_HELP }, { status: 500 });
    if (e instanceof BadKeyError) return Response.json({ error: BAD_KEY_HELP }, { status: 401 });
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: `Scan failed: ${msg}` }, { status: 500 });
  }
}
