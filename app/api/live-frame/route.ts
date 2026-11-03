import { ageGroup } from "@/lib/ages";
import { BAD_KEY_HELP, BadKeyError, KEY_HELP, MODEL, hasKey, readBoxes } from "@/lib/grok";
import { MOCK_PRODUCTS, MOCK_SCENARIOS } from "@/lib/mock";
import { analyze, mergeSeen, type SeenProduct } from "@/lib/pipeline";
import type { Product } from "@/lib/types";

export const maxDuration = 30;

type Body = {
  image?: string; // data:image/jpeg;base64,...
  seen?: SeenProduct[];
  mock?: boolean;
  tick?: number; // frame counter, drives the MOCK timeline
  age?: string; // age profile id
  scenario?: string; // MOCK only: e.g. "rx" or "fentanyl" instead of the Tylenol + NyQuil timeline
};

const MAX_DATA_URL = 4 * 1024 * 1024;

// MOCK timeline (one frame every ~2.5s): nothing, then Tylenol, then NyQuil + Tylenol.
function mockFrame(tick: number): Product[] {
  const [tylenol, nyquil] = MOCK_PRODUCTS;
  if (tick <= 0) return [];
  if (tick === 1) return [tylenol];
  return [nyquil, tylenol];
}

function cleanSeen(raw: unknown): SeenProduct[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p) => p && typeof p.brand === "string" && Array.isArray(p.active_ingredients) && Array.isArray(p.keys))
    .slice(0, 5)
    .map((p) => ({
      brand: String(p.brand),
      active_ingredients: p.active_ingredients.map((a: { name: unknown; strength: unknown }) => ({
        name: String(a.name),
        strength: String(a.strength ?? ""),
      })),
      confidence: Number(p.confidence) || 0.5,
      keys: p.keys.map(String),
      seen: Number(p.seen) || 1,
      ...(p.rx === true ? { rx: true, ...(typeof p.directions === "string" ? { directions: p.directions.slice(0, 200) } : {}) } : {}),
    }));
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Body;
  const mock = !!body.mock || process.env.MOCK === "1";
  const seen = cleanSeen(body.seen);
  let detected: Product[] = [];
  let hint: string | null = null;

  if (mock) {
    const sc = body.scenario && body.scenario !== "1" ? MOCK_SCENARIOS[body.scenario] : undefined;
    detected = sc ? ((Number(body.tick) || 0) >= 1 ? sc : []) : mockFrame(Number(body.tick) || 0);
  } else {
    if (!hasKey()) return Response.json({ error: KEY_HELP }, { status: 500 });
    const img = body.image ?? "";
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(img) || img.length > MAX_DATA_URL) {
      return Response.json({ error: "Send one JPEG/PNG frame as a data URL (max ~3 MB)." }, { status: 400 });
    }
    try {
      const read = await readBoxes(img);
      detected = read.products;
      hint = read.unreadable;
    } catch (e) {
      if (e instanceof BadKeyError) return Response.json({ error: BAD_KEY_HELP }, { status: 401 });
      // A single bad frame is not fatal in Live mode: report and keep going.
      hint = "couldn't read that frame";
    }
  }

  const { products, added } = mergeSeen(seen, detected);
  const { labels, flags, status } = await analyze(products, ageGroup(body.age));
  return Response.json({
    mock,
    model: mock ? `${MODEL} (mock)` : MODEL,
    detected: detected.map((p) => p.brand),
    added,
    hint,
    products,
    labels,
    flags,
    status,
  });
}
