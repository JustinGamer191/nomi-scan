// On-device scan history (localStorage only; this is health data and never leaves the browser).
import type { ScanResult } from "./types";

export type HistoryEntry = {
  id: string;
  at: string; // ISO time of the scan
  mode: "upload" | "live";
  result: ScanResult;
  thumb?: string; // ~200px JPEG data URL, dropped when storage is tight
  recheckedAt?: string;
};

const KEY = "nomi-history-v1";
const MAX = 50;

// Keep only what reopening needs. Products are already whitelisted server-side
// (drug, strength, directions; no patient, prescriber, Rx number or pharmacy).
function slim(result: ScanResult): ScanResult {
  return {
    ...result,
    products: result.products.map((p) => ({
      brand: p.brand,
      active_ingredients: p.active_ingredients.map((a) => ({ name: a.name, strength: a.strength })),
      confidence: p.confidence,
      keys: p.keys,
      ...(p.images ? { images: p.images } : {}),
      ...(p.rx ? { rx: true, ...(p.directions ? { directions: p.directions } : {}) } : {}),
    })),
    labels: Object.fromEntries(
      Object.entries(result.labels).map(([k, l]) => [
        k,
        { ingredient: l.ingredient, found: l.found, label_name: l.label_name, set_id: l.set_id },
      ]),
    ),
  };
}

export function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function write(list: HistoryEntry[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

// Newest first, capped at 50. If storage is full: drop thumbnails, then oldest entries.
function persist(list: HistoryEntry[]): HistoryEntry[] {
  let next = list.slice(0, MAX);
  if (write(next)) return next;
  next = next.map(({ thumb: _t, ...rest }) => rest); // eslint-disable-line @typescript-eslint/no-unused-vars
  while (next.length && !write(next)) next = next.slice(0, -1);
  return next;
}

export function saveScan(mode: HistoryEntry["mode"], result: ScanResult, at: string, thumb?: string): HistoryEntry[] {
  if (!result.products.length) return loadHistory();
  const entry: HistoryEntry = {
    id: `${Date.parse(at) || Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    at,
    mode,
    result: slim(result),
    ...(thumb ? { thumb } : {}),
  };
  return persist([entry, ...loadHistory()]);
}

export function updateEntry(id: string, result: ScanResult): HistoryEntry[] {
  return persist(
    loadHistory().map((e) => (e.id === id ? { ...e, result: slim(result), recheckedAt: new Date().toISOString() } : e)),
  );
}

export function deleteEntry(id: string): HistoryEntry[] {
  return persist(loadHistory().filter((e) => e.id !== id));
}

export function clearHistory(): HistoryEntry[] {
  try {
    localStorage.removeItem(KEY);
  } catch {}
  return [];
}

// ~200px JPEG thumbnail from an image source (photo file or video frame).
export async function makeThumb(src: Blob | HTMLVideoElement, max = 200): Promise<string | undefined> {
  try {
    const img = src instanceof Blob ? await createImageBitmap(src) : src;
    const w = src instanceof Blob ? (img as ImageBitmap).width : (src as HTMLVideoElement).videoWidth;
    const h = src instanceof Blob ? (img as ImageBitmap).height : (src as HTMLVideoElement).videoHeight;
    if (!w || !h) return undefined;
    const scale = Math.min(1, max / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.round(w * scale);
    c.height = Math.round(h * scale);
    c.getContext("2d")!.drawImage(img as CanvasImageSource, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.6);
  } catch {
    return undefined;
  }
}
