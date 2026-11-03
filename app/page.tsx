"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AgePicker from "@/components/AgePicker";
import LiveMode from "@/components/LiveMode";
import ResultsPanel from "@/components/ResultsPanel";
import { ageGroup, DEFAULT_AGE, type AgeGroupId } from "@/lib/ages";
import type { ScanResult } from "@/lib/types";

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

export default function Home() {
  const [mode, setMode] = useState<"upload" | "live">("upload");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [scanError, setScanError] = useState<{ message: string; hints: string[] } | null>(null);
  const [drag, setDrag] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [scannedAt, setScannedAt] = useState("");
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
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setLoading(false);
    }
  }


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
            <ResultsPanel result={result} scannedAt={scannedAt} />
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
