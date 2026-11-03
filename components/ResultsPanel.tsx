"use client";

// Shared results UI for Upload and Live mode: status banner, flag cards, med cards with
// recall badges, pharmacist summary, Ask Nomi and the dose planner. Recalls and dosing
// are fetched here, debounced and cached per product so Live mode doesn't spam the APIs.
import { useEffect, useMemo, useRef, useState } from "react";
import AskNomi from "@/components/AskNomi";
import DosePlanner from "@/components/DosePlanner";
import ScanSummary from "@/components/ScanSummary";
import { ageGroup, isUnder12 } from "@/lib/ages";
import type { DosingResult } from "@/lib/dosing";
import type { RecallReport } from "@/lib/recalls";
import { singleProductHeadline } from "@/lib/statusText";
import type { Flag, LabelInfo, ScanResult } from "@/lib/types";

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


type P = ScanResult["products"][number];
const pid = (p: P) => `${p.brand.toLowerCase()}|${[...p.keys].sort().join(",")}|${p.rx ? "rx" : ""}|${p.directions ?? ""}`;

// Module-level caches survive re-renders and new Live frames.
const recallCache = new Map<string, RecallReport>();
const dosingCache = new Map<string, DosingResult>();
const explainCache = new Map<string, { explanation: string; citations: string[] }>();

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) =>
    r.json(),
  );

export default function ResultsPanel({
  result,
  scannedAt,
  debounceMs = 0,
  explain = false,
  fetchExtras = true,
}: {
  result: ScanResult;
  scannedAt: string;
  debounceMs?: number; // Live mode: wait for the seen list to settle
  explain?: boolean; // Live mode: upgrade template explanations with a debounced Grok call
  fetchExtras?: boolean; // History: false = show the saved result without any new calls
}) {
  const [recalls, setRecalls] = useState<Record<string, RecallReport>>({});
  const [recallsLoading, setRecallsLoading] = useState(false);
  const [dosing, setDosing] = useState<DosingResult | null>(null);
  const [dosingLoading, setDosingLoading] = useState(false);
  const [explained, setExplained] = useState<Record<string, { explanation: string; citations: string[] }>>({});
  const timerOn = !isUnder12(ageGroup(result.age));
  const productKey = result.products.map(pid).sort().join("||");
  const flagKey = result.flags.map((f) => f.id).sort().join("|");
  const latest = useRef(result);
  useEffect(() => {
    latest.current = result;
  }, [result]);

  // Recalls + dosing, debounced, cached per product (recalls) / product set (dosing).
  useEffect(() => {
    if (!fetchExtras) return;
    const t = setTimeout(() => {
      const r = latest.current;
      const products = r.products;
      const missing = products.filter((p) => !recallCache.has(`${r.mock}|${p.brand}`));
      const apply = () =>
        setRecalls(
          Object.fromEntries(
            products.map((p) => [p.brand, recallCache.get(`${r.mock}|${p.brand}`)]).filter(([, v]) => v) as [string, RecallReport][],
          ),
        );
      apply();
      if (missing.length) {
        setRecallsLoading(true);
        post("/api/recalls", { products: missing, mock: r.mock })
          .then((d: { reports?: RecallReport[] }) => {
            for (const rep of d.reports ?? []) recallCache.set(`${r.mock}|${rep.brand}`, rep);
            apply();
          })
          .catch(() => {})
          .finally(() => setRecallsLoading(false));
      }
      if (!timerOn) return setDosing(null);
      const dk = `${r.mock}|${products.map(pid).sort().join("||")}`;
      const cached = dosingCache.get(dk);
      if (cached) return setDosing(cached);
      setDosingLoading(true);
      post("/api/dosing", { products, mock: r.mock })
        .then((d: DosingResult) => {
          if (d.rules) {
            dosingCache.set(dk, d);
            setDosing(d);
          }
        })
        .catch(() => {})
        .finally(() => setDosingLoading(false));
    }, debounceMs);
    return () => clearTimeout(t);
  }, [productKey, timerOn, debounceMs, fetchExtras]);

  // Live mode: Grok explanations for new flags, debounced and cached per flag.
  useEffect(() => {
    if (!explain) return;
    const t = setTimeout(() => {
      const r = latest.current;
      const key = (f: Flag) => `${r.age}|${f.id}|${f.products.join("+")}`;
      const todo = r.flags.filter((f) => f.kind !== "age" && f.kind !== "boxed" && !explainCache.has(key(f)));
      const apply = () =>
        setExplained(Object.fromEntries(r.flags.filter((f) => explainCache.has(key(f))).map((f) => [f.id, explainCache.get(key(f))!])));
      apply();
      if (!todo.length) return;
      post("/api/explain", { flags: todo, products: r.products, mock: r.mock })
        .then((d: { explanations?: Record<string, { explanation: string; citations: string[] }> }) => {
          for (const f of todo) if (d.explanations?.[f.id]) explainCache.set(key(f), d.explanations[f.id]);
          apply();
        })
        .catch(() => {});
    }, Math.max(debounceMs, 0));
    return () => clearTimeout(t);
  }, [flagKey, explain, debounceMs]);

  const shown = useMemo(
    () => ({
      ...result,
      flags: result.flags.map((f) => (explained[f.id] ? { ...f, ...explained[f.id] } : f)),
    }),
    [result, explained],
  );
  const flaggedKeys = new Set(shown.flags.filter((f) => f.kind !== "boxed").flatMap((f) => f.ingredients));

  return (
    <>
      <Results result={shown} flaggedKeys={flaggedKeys} recalls={recallsLoading && !Object.keys(recalls).length ? "loading" : recalls} />
      <ScanSummary key={scannedAt} result={shown} scannedAt={scannedAt} />
      <AskNomi key={`${result.age}|${result.products.map((p) => p.brand).join("|")}`} result={result} />
      {dosingLoading && !dosing && <p className="text-sm text-stone-500">Reading dosing directions from FDA labels...</p>}
      {dosing && <DosePlanner key={productKey} dosing={dosing} mock={result.mock} />}
    </>
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
