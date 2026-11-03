"use client";

import { useEffect, useState } from "react";
import ResultsPanel from "@/components/ResultsPanel";
import { ageGroup } from "@/lib/ages";
import { clearHistory, deleteEntry, loadHistory, updateEntry, type HistoryEntry } from "@/lib/history";
import type { ScanResult } from "@/lib/types";

const DOT = { red: "bg-red-500", yellow: "bg-amber-500", green: "bg-emerald-500" } as const;
const RX = "ml-1.5 inline-block rounded bg-indigo-600 px-1 py-px align-middle text-[9px] font-bold uppercase text-white";

const when = (iso: string) =>
  new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default function HistoryView() {
  const [list, setList] = useState<HistoryEntry[]>([]);
  const [open, setOpen] = useState<HistoryEntry | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [rechecked, setRechecked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setList(loadHistory());
  }, []);

  async function recheck(e: HistoryEntry) {
    setRechecking(true);
    setError(null);
    try {
      const res = await fetch("/api/recheck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ products: e.result.products, age: e.result.age, mock: e.result.mock }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Re-check failed");
      const fresh = data as ScanResult;
      setList(updateEntry(e.id, fresh));
      setOpen({ ...e, result: fresh, recheckedAt: new Date().toISOString() });
      setRechecked(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Re-check failed");
    } finally {
      setRechecking(false);
    }
  }

  if (open) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => { setOpen(null); setRechecked(false); }} className="rounded-xl border border-stone-300 px-3 py-2 text-sm text-stone-700 hover:bg-stone-100">
            ← History
          </button>
          <span className="text-sm text-stone-500">
            {open.mode === "live" ? "Live session" : "Upload scan"} · {when(open.at)}
            {open.recheckedAt && ` · re-checked ${when(open.recheckedAt)}`}
          </span>
          <button
            onClick={() => recheck(open)}
            disabled={rechecking}
            className="ml-auto rounded-xl bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {rechecking ? "Re-checking..." : "Re-check with latest FDA labels"}
          </button>
        </div>
        {error && <p className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}
        <ResultsPanel
          key={`${open.id}|${open.recheckedAt ?? ""}`}
          result={open.result}
          scannedAt={open.at}
          fetchExtras={rechecked}
          explain={rechecked}
        />
      </div>
    );
  }

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-xl font-semibold">History</h2>
        {list.length > 0 && (
          <button
            onClick={() => {
              if (confirm("Delete all saved scans on this device?")) setList(clearHistory());
            }}
            className="text-sm text-stone-500 hover:text-red-600"
          >
            Clear history
          </button>
        )}
      </div>
      <p className="text-sm text-stone-500">Saved only on this device. Last 50 scans. Personal info from prescription labels is never stored.</p>
      {list.length === 0 ? (
        <p className="rounded-2xl border border-stone-200 bg-white p-4 text-sm text-stone-600">
          No scans yet. Finished Upload scans and ended Live sessions show up here.
        </p>
      ) : (
        <ul className="space-y-2">
          {list.map((e) => (
            <li key={e.id} className="flex items-center gap-3 rounded-2xl border border-stone-200 bg-white p-3">
              <button onClick={() => setOpen(e)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                {e.thumb ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={e.thumb} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" />
                ) : (
                  <span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-stone-100 text-[10px] text-stone-400">
                    {e.mode === "live" ? "Live" : "Scan"}
                  </span>
                )}
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-xs text-stone-500">
                    <span className={`h-2.5 w-2.5 rounded-full ${DOT[e.result.status]}`} />
                    {when(e.at)} · {e.mode === "live" ? "Live" : "Upload"} · {ageGroup(e.result.age).short}
                    {e.result.mock && " · demo"}
                  </span>
                  <span className="mt-0.5 block truncate text-[15px] font-medium">
                    {e.result.products.map((p, i) => (
                      <span key={i}>
                        {i > 0 && ", "}
                        {p.brand}
                        {p.rx && <span className={RX}>Rx</span>}
                      </span>
                    ))}
                  </span>
                  {e.result.flags.length > 0 && (
                    <span className="block truncate text-xs text-stone-500">{e.result.flags.map((f) => f.title).join(" · ")}</span>
                  )}
                </span>
              </button>
              <button
                onClick={() => setList(deleteEntry(e.id))}
                aria-label="Delete this scan"
                className="shrink-0 rounded-lg px-2 py-1 text-xs text-stone-400 hover:text-red-600"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
