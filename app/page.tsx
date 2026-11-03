"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AgePicker from "@/components/AgePicker";
import AskNomi from "@/components/AskNomi";
import DosePlanner from "@/components/DosePlanner";
import LiveMode from "@/components/LiveMode";
import ScanSummary from "@/components/ScanSummary";
import { ageGroup, DEFAULT_AGE, isUnder12, type AgeGroupId } from "@/lib/ages";
import type { DosingResult } from "@/lib/dosing";
import type { RecallReport } from "@/lib/recalls";
import { singleProductHeadline } from "@/lib/statusText";
import type { Flag, LabelInfo, ScanResult } from "@/lib/types";

// Downscale big phone photos before upload (faster, cheaper, still readable).
async function shrink(file: File, max = 1800): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 3_000_000) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return await new Promise((res) => canvas.toBlob((b) => res(b ?? file), "image/jpeg", 0.88));
  } catch {
    return file;
  }
}

const MAX_PHOTOS = 6;
const AGE_KEY = "nomi-age";

type Photo = { id: string; file: File; url: string };

const STATUS = {
  red: {
    label: "Do not combine without asking",
    sub: "We found a serious overlap between these products.",
    ring: "bg-red-50 border-red-200 text-red-900",
    dot: "bg-red-500",
  },
  yellow: {
    label: "Use caution",
    sub: "Some overlap or uncertainty. Check with a pharmacist.",
    ring: "bg-amber-50 border-amber-200 text-amber-900",
    dot: "bg-amber-500",
  },
  green: {
    label: "No overlaps found",
    sub: "No duplicate ingredients or known OTC conflicts in our checks.",
    ring: "bg-emerald-50 border-emerald-200 text-emerald-900",
    dot: "bg-emerald-500",
  },
} as const;

export default function Home() {
  const [mode, setMode] = useState<"upload" | "live">("upload");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [scanError, setScanError] = useState<{ message: string; hints: string[] } | null>(null);
  const [drag, setDrag] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [scannedAt, setScannedAt] = useState("");
  const [recalls, setRecalls] = useState<Record<string, RecallReport> | "loading" | null>(null);
  const [dosing, setDosing] = useState<DosingResult | "loading" | null>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const camRef = useRef<HTMLInputElement>(null);
  const [age, setAge] = useState<AgeGroupId>(DEFAULT_AGE);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(AGE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved) setAge(ageGroup(saved).id);
    } catch {}
  }, []);

  // A new profile changes the checks, so rerun the last scan with it.
  function changeAge(id: AgeGroupId) {
    setAge(id);
    try {
      localStorage.setItem(AGE_KEY, id);
    } catch {}
    if (result && !loading) scan(result.mock, id);
  }

  // Add one or more photos (file picker, drop, or one camera shot at a time).
  const addFiles = useCallback((list: FileList | File[] | null | undefined) => {
    const incoming = [...(list ?? [])];
    if (!incoming.length) return;
    const images = incoming.filter((f) => !f.type || f.type.startsWith("image/"));
    setError(images.length < incoming.length ? "Skipped files that are not images." : null);
    setResult(null);
    setScanError(null);
    setPhotos((prev) => {
      const room = MAX_PHOTOS - prev.length;
      if (images.length > room) setError(`Up to ${MAX_PHOTOS} photos per scan. Extra photos were skipped.`);
      const added = images.slice(0, Math.max(0, room)).map((file) => ({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        url: URL.createObjectURL(file),
      }));
      return [...prev, ...added];
    });
  }, []);

  function removePhoto(id: string) {
    setPhotos((prev) => {
      const gone = prev.find((p) => p.id === id);
      if (gone) URL.revokeObjectURL(gone.url);
      return prev.filter((p) => p.id !== id);
    });
    setResult(null);
    setScanError(null);
  }

  async function scan(mock = false, forAge: AgeGroupId = age) {
    setLoading(true);
    setError(null);
    setScanError(null);
    setResult(null);
    setRecalls(null);
    setDosing(null);
    try {
      const body = new FormData();
      body.append("age", forAge);
      if (!mock) {
        const blobs = await Promise.all(photos.map((p) => shrink(p.file)));
        blobs.forEach((b, i) => body.append("image", b, `photo-${i + 1}.jpg`));
      }
      const res = await fetch(`/api/scan${mock ? "?mock=1" : ""}`, { method: "POST", body });
      const data = await res.json().catch(() => ({ error: `Scan failed (${res.status})` }));
      if (!res.ok) {
        setScanError({ message: data.error ?? `Scan failed (${res.status})`, hints: data.hints ?? [] });
        return;
      }
      const scanned = data as ScanResult;
      setScannedAt(new Date().toISOString());
      setResult(scanned);
      loadExtras(scanned);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setLoading(false);
    }
  }

  // Follow-up calls after the scan: live recall check and label dosing rules.
  function loadExtras(scanned: ScanResult) {
    const body = JSON.stringify({ products: scanned.products, mock: scanned.mock });
    const opts = { method: "POST", headers: { "Content-Type": "application/json" }, body };
    setRecalls("loading");
    // The dose timer schedules adult directions; kids follow the box's dosing chart.
    const timer = !isUnder12(ageGroup(scanned.age));
    setDosing(timer ? "loading" : null);
    fetch("/api/recalls", opts)
      .then((r) => r.json())
      .then((d: { reports?: RecallReport[] }) =>
        setRecalls(Object.fromEntries((d.reports ?? []).map((r) => [r.brand, r]))),
      )
      .catch(() => setRecalls({}));
    if (timer)
      fetch("/api/dosing", opts)
      .then((r) => r.json())
      .then((d: DosingResult) => setDosing(d.rules ? d : null))
      .catch(() => setDosing(null));
  }

  const flaggedKeys = new Set(result?.flags.flatMap((f) => f.ingredients) ?? []);

  return (
    <div className="min-h-dvh bg-stone-50 pb-24 text-stone-900">
      <header className="mx-auto max-w-3xl px-4 pt-8 sm:pt-12">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-stone-900 text-sm font-bold text-white">N</span>
          <span className="text-lg font-semibold tracking-tight">Nomi Scan</span>
          <span className="ml-auto rounded-full border border-stone-200 bg-white px-2.5 py-0.5 text-xs text-stone-500">
            Grok vision + openFDA
          </span>
        </div>
        <div role="tablist" aria-label="Mode" className="mt-6 inline-flex rounded-xl border border-stone-200 bg-white p-1">
          {(["upload", "live"] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={`rounded-lg px-4 py-1.5 text-sm font-medium ${
                mode === m ? "bg-stone-900 text-white" : "text-stone-600 hover:text-stone-900"
              }`}
            >
              {m === "upload" ? "Upload" : "Live"}
            </button>
          ))}
        </div>
        <h1 className="mt-5 text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
          Snap your meds. Catch the overlap.
        </h1>
        <p className="mt-2 max-w-xl text-stone-600">
          Photos of up to 5 medicines, OTC boxes or prescription bottles, in one shot or one per photo. We read the
          ingredients, pull the FDA labels, and flag doubled-up or interacting medicines.
        </p>
        <AgePicker value={age} onChange={changeAge} />
      </header>

      <main className="mx-auto mt-6 max-w-3xl space-y-6 px-4">
        {mode === "live" ? (
          <LiveMode age={age} />
        ) : (
          <>
        <section
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            addFiles(e.dataTransfer.files);
          }}
          className={`rounded-2xl border-2 border-dashed bg-white p-4 transition sm:p-6 ${
            drag ? "border-stone-900 bg-stone-100" : "border-stone-300"
          }`}
        >
          {photos.length > 0 ? (
            <div className="space-y-4">
              <ul className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                {photos.map((p, i) => (
                  <li key={p.id} className="relative aspect-square overflow-hidden rounded-xl bg-stone-100">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.url} alt={`Photo ${i + 1}`} className="h-full w-full object-cover" />
                    <span className="absolute left-1 top-1 rounded-md bg-black/60 px-1.5 text-[11px] font-medium text-white">
                      {i + 1}
                    </span>
                    <button
                      onClick={() => removePhoto(p.id)}
                      aria-label={`Remove photo ${i + 1}`}
                      className="absolute right-1 top-1 grid h-7 w-7 place-items-center rounded-full bg-black/60 text-white hover:bg-red-600"
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" strokeWidth="2" aria-hidden>
                        <path d="M2 2l8 8M10 2l-8 8" />
                      </svg>
                    </button>
                  </li>
                ))}
                {photos.length < MAX_PHOTOS && (
                  <li>
                    <button
                      onClick={() => pickRef.current?.click()}
                      className="grid aspect-square w-full place-items-center rounded-xl border-2 border-dashed border-stone-300 text-sm text-stone-500 hover:border-stone-900 hover:text-stone-900"
                    >
                      + Add more
                    </button>
                  </li>
                )}
              </ul>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => scan(false)}
                  disabled={loading}
                  className="rounded-xl bg-stone-900 px-5 py-3 font-medium text-white hover:bg-stone-700 disabled:opacity-50"
                >
                  {loading ? "Scanning..." : `Scan ${photos.length} photo${photos.length > 1 ? "s" : ""}`}
                </button>
                <span className="text-sm text-stone-500">
                  {photos.length}/{MAX_PHOTOS} photos
                </span>
              </div>
            </div>
          ) : (
            <button
              onClick={() => pickRef.current?.click()}
              className="flex w-full flex-col items-center justify-center gap-3 rounded-xl py-12 text-center sm:py-16"
            >
              <svg
                width="44"
                height="44"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="text-stone-400"
                aria-hidden
              >
                <rect x="3" y="5" width="18" height="15" rx="3" />
                <circle cx="12" cy="12.5" r="3.5" />
                <path d="M8 5l1.5-2h5L16 5" />
              </svg>
              <span className="text-lg font-medium">Drop photos here or tap to upload</span>
              <span className="text-sm text-stone-500">Up to {MAX_PHOTOS} photos. Fronts of the boxes visible, good light.</span>
            </button>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-stone-100 pt-4">
            <button
              onClick={() => camRef.current?.click()}
              disabled={photos.length >= MAX_PHOTOS}
              className="rounded-xl border border-stone-300 px-4 py-2.5 text-sm font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-40 sm:hidden"
            >
              {photos.length ? "Take another photo" : "Take photo"}
            </button>
            <button
              onClick={() => scan(true)}
              disabled={loading}
              className="rounded-xl border border-stone-300 px-4 py-2.5 text-sm text-stone-700 hover:bg-stone-100 disabled:opacity-50"
            >
              Try demo (Tylenol + NyQuil)
            </button>
            {photos.length > 0 && (
              <button
                onClick={() => {
                  photos.forEach((p) => URL.revokeObjectURL(p.url));
                  setPhotos([]);
                  setResult(null);
                  setScanError(null);
                }}
                className="ml-auto text-sm text-stone-500 hover:text-red-600"
              >
                Clear all
              </button>
            )}
          </div>
          <input
            ref={pickRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <input
            ref={camRef}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </section>

        {loading && (
          <div className="flex items-center gap-3 rounded-2xl border border-stone-200 bg-white p-4 text-stone-600">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-stone-300 border-t-stone-900" />
            Reading boxes with Grok and checking FDA labels...
          </div>
        )}

        {error && (
          <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-red-800">
            {error}
          </div>
        )}

        {scanError && (
          <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-red-800">
            <p>{scanError.message}</p>
            {scanError.hints.length > 0 && (
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm">
                {scanError.hints.map((h, i) => (
                  <li key={i}>{h}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {result && result.hints?.length > 0 && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <p className="font-medium">Some photos need a retake</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {result.hints.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ul>
          </div>
        )}

        {result && (
          <>
            <Results result={result} flaggedKeys={flaggedKeys} recalls={recalls} />
            <ScanSummary key={scannedAt} result={result} scannedAt={scannedAt} />
            <AskNomi key={`${result.age}|${result.products.map((p) => p.brand).join("|")}`} result={result} />
            {dosing === "loading" && <p className="text-sm text-stone-500">Reading dosing directions from FDA labels...</p>}
            {dosing && dosing !== "loading" && <DosePlanner dosing={dosing} mock={result.mock} />}
          </>
        )}
          </>
        )}
      </main>

      <footer className="fixed inset-x-0 bottom-0 z-10 border-t border-stone-200 bg-white/95 backdrop-blur">
        <p className="mx-auto max-w-3xl px-4 py-3 text-center text-sm font-medium text-stone-800">
          Not medical advice. Ask a pharmacist.
        </p>
      </footer>
    </div>
  );
}

function RecallBadge({ report }: { report: RecallReport | "loading" | undefined }) {
  if (report === "loading") return <p className="mt-3 text-xs text-stone-400">Checking recalls...</p>;
  if (!report) return null;
  const n = report.items.length;
  return (
    <div className="mt-3">
      {n === 0 ? (
        <span className="inline-flex rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200">
          No recent recalls found
        </span>
      ) : (
        <details>
          <summary className="inline-flex cursor-pointer list-none rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-900 ring-1 ring-amber-300">
            {n} recall notice{n > 1 ? "s" : ""} mention this brand
          </summary>
          <ul className="mt-2 space-y-2">
            {report.items.map((it, i) => (
              <li key={i} className="rounded-lg bg-amber-50 p-2 text-xs text-amber-950">
                <p className="font-medium">
                  {it.title}
                  {it.date && <span className="font-normal text-amber-800"> · {it.date}</span>}
                </p>
                {it.detail && <p className="mt-0.5 text-amber-900/80">{it.detail}</p>}
                <a href={it.url} target="_blank" rel="noreferrer" className="mt-0.5 inline-block break-all text-amber-900 underline">
                  Source ({it.source})
                </a>
              </li>
            ))}
            <li className="text-[11px] text-stone-500">Check the lot number on your box against the notice.</li>
          </ul>
        </details>
      )}
      {report.note && <p className="mt-1 text-[11px] text-stone-400">{report.note}</p>}
    </div>
  );
}

function Results({
  result,
  flaggedKeys,
  recalls,
}: {
  result: ScanResult;
  flaggedKeys: Set<string>;
  recalls: Record<string, RecallReport> | "loading" | null;
}) {
  const s = STATUS[result.status];
  const profile = ageGroup(result.age);
  const single = singleProductHeadline(result.flags);
  const ageOnlyRed =
    !single &&
    result.status === "red" && !result.flags.some((f) => f.severity === "red" && f.kind !== "age");
  return (
    <div className="space-y-6">
      <section className={`rounded-2xl border p-5 ${s.ring}`} data-status={result.status}>
        <div className="flex items-center gap-3">
          <span className={`h-4 w-4 shrink-0 rounded-full ${s.dot}`} />
          <h2 className="text-xl font-semibold">{single ? single.title : ageOnlyRed ? "Not for this age without asking" : s.label}</h2>
          <span className="ml-auto text-xs uppercase tracking-wide opacity-70">{result.status}</span>
        </div>
        <p className="mt-1 pl-7 text-sm opacity-80">
          {single ? single.sub : ageOnlyRed ? "A label warning applies to this age group." : s.sub} Checked for: {profile.label}.
        </p>
      </section>

      {result.flags.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-stone-500">What we found</h3>
          {result.flags.map((f) => (
            <FlagCard key={f.id} flag={f} />
          ))}
        </section>
      )}

      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
          Your meds ({result.products.length})
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {result.products.map((p, i) => (
            <article key={i} className="rounded-2xl border border-stone-200 bg-white p-4">
              <div className="flex items-start justify-between gap-2">
                <h4 className="font-semibold leading-snug">
                  {p.brand}
                  {p.rx && <span className="ml-2 inline-block rounded-md bg-indigo-600 px-1.5 py-0.5 align-middle text-[10px] font-bold uppercase tracking-wide text-white">Rx</span>}
                </h4>
                <span className="shrink-0 rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-500">
                  {Math.round(p.confidence * 100)}% sure
                </span>
              </div>
              {p.rx && p.directions && <p className="mt-1 text-xs text-stone-600">Bottle: {p.directions}</p>}
              {result.image_count > 1 && p.images && p.images.length > 0 && (
                <p className="mt-0.5 text-xs text-stone-400">
                  Seen in photo{p.images.length > 1 ? "s" : ""} {p.images.join(", ")}
                </p>
              )}
              <ul className="mt-3 space-y-2">
                {p.active_ingredients.map((a, j) => {
                  const key = p.keys[j];
                  const label: LabelInfo | undefined = result.labels[key];
                  const hot = flaggedKeys.has(key);
                  return (
                    <li
                      key={j}
                      className={`rounded-lg px-3 py-2 text-sm ${
                        hot ? "bg-red-50 text-red-900 ring-1 ring-red-200" : "bg-stone-50"
                      }`}
                    >
                      <div className="flex justify-between gap-2">
                        <span className="font-medium">{a.name}</span>
                        <span className="text-stone-500">{a.strength}</span>
                      </div>
                      <div className="mt-0.5 text-xs text-stone-500">
                        {label?.found ? `FDA label: ${label.label_name}` : "No label found"}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {recalls && <RecallBadge report={recalls === "loading" ? "loading" : recalls[p.brand]} />}
            </article>
          ))}
        </div>
      </section>

      {result.notes.length > 0 && (
        <ul className="space-y-1 text-xs text-stone-500">
          {result.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      <p className="text-xs text-stone-400">Model: {result.model}. Labels from api.fda.gov.</p>
    </div>
  );
}

function FlagCard({ flag }: { flag: Flag }) {
  const red = flag.severity === "red";
  return (
    <article className={`rounded-2xl border bg-white p-4 ${red ? "border-red-200" : "border-amber-200"}`}>
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${red ? "bg-red-500" : "bg-amber-500"}`} />
        <h4 className="font-semibold">{flag.title}</h4>
        {flag.kind === "age" && (
          <span className="ml-auto shrink-0 rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-600">Age check</span>
        )}
      </div>
      <p className="mt-1 text-xs text-stone-500">In: {flag.products.join(" + ")}</p>
      {flag.rx && (
        <p className="mt-3 rounded-lg bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-950">
          Talk to your pharmacist or prescriber before combining. Do not stop a prescription on your own.
        </p>
      )}
      {flag.explanation && <p className="mt-3 text-[15px] leading-relaxed text-stone-800">{flag.explanation}</p>}
      <div className="mt-3 space-y-1 text-xs text-stone-500">
        {flag.citations?.map((c, i) => (
          <p key={i}>Source: {c}</p>
        ))}
        <p>Rule: {flag.source}</p>
      </div>
    </article>
  );
}
