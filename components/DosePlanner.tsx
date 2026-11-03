"use client";

import { useEffect, useMemo, useState } from "react";
import type { DosingResult } from "@/lib/dosing";
import {
  blocksForToday,
  dosesLeft,
  nextSafe,
  parseIcs,
  planDoses,
  remainingMg,
  type Block,
  type DoseLog,
  type HHMMBlock,
} from "@/lib/schedule";

const H = 3600_000;
const LOG_KEY = "nomi-dose-log";

const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const dayTime = (t: number, now: number) => {
  const sameDay = new Date(t).toDateString() === new Date(now).toDateString();
  return sameDay ? time(t) : `tomorrow ${time(t)}`;
};
const localInput = (t: number) => {
  const d = new Date(t - new Date(t).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

export default function DosePlanner({ dosing, mock }: { dosing: DosingResult; mock: boolean }) {
  const rules = useMemo(() => dosing.rules.filter((r) => r.found && r.min_interval_h !== null), [dosing]);
  const [now, setNow] = useState(() => Date.now());
  const [logs, setLogs] = useState<DoseLog[]>([]);
  const [brand, setBrand] = useState(rules[0]?.brand ?? "");
  const [takenAt, setTakenAt] = useState(() => localInput(Date.now()));
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [schedText, setSchedText] = useState("");
  const [schedMsg, setSchedMsg] = useState<string | null>(null);
  const [sleep, setSleep] = useState(true);
  const [planFor, setPlanFor] = useState(rules[0]?.brand ?? "");

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LOG_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setLogs(JSON.parse(raw));
    } catch {}
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  function saveLogs(next: DoseLog[]) {
    setLogs(next);
    try {
      localStorage.setItem(LOG_KEY, JSON.stringify(next));
    } catch {}
  }

  const allBlocks = useMemo(() => {
    if (!sleep) return blocks;
    const d = new Date(now);
    const mk = (offset: number) => ({
      label: "Sleep",
      start: new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset, 23, 0).getTime(),
      end: new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset + 1, 7, 0).getTime(),
    });
    return [...blocks, mk(-1), mk(0)];
  }, [blocks, sleep, now]);

  if (rules.length === 0) {
    return (
      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Dose timer</h3>
        <p className="rounded-2xl border border-stone-200 bg-white p-4 text-sm text-stone-600">
          We could not find dosing directions on the FDA labels for these products. Follow the box, and ask a pharmacist.
        </p>
      </section>
    );
  }

  const caps = dosing.caps;
  const remaining = remainingMg(caps, logs, rules, now);
  const planRule = rules.find((r) => r.brand === planFor) ?? rules[0];
  const plan = planDoses(planRule, logs, rules, caps, allBlocks, now);
  const windowStart = now - 2 * H;
  const windowEnd = now + 24 * H;
  const pct = (t: number) => `${Math.min(100, Math.max(0, ((t - windowStart) / (windowEnd - windowStart)) * 100))}%`;

  async function onIcs(file: File | undefined) {
    if (!file) return;
    const text = await file.text();
    const found = parseIcs(text, now - 2 * H, now + 26 * H);
    setBlocks(found);
    setSchedMsg(found.length ? `Loaded ${found.length} event(s) from ${file.name}.` : "No timed events today in that file.");
  }

  async function onText() {
    if (!schedText.trim()) return;
    setSchedMsg("Reading your schedule...");
    try {
      const res = await fetch("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: schedText, mock }),
      });
      const data = (await res.json()) as { blocks?: HHMMBlock[]; by?: string; error?: string };
      if (!res.ok) throw new Error(data.error);
      const b = blocksForToday(data.blocks ?? [], now);
      setBlocks(b);
      setSchedMsg(b.length ? `Found ${b.length} busy block(s) (${data.by === "grok" ? "parsed by Grok" : "built-in parser"}).` : "Couldn't find any times. Try lines like 2:00-3:15pm CS 2110.");
    } catch (e) {
      setSchedMsg(e instanceof Error && e.message ? e.message : "Couldn't read that schedule.");
    }
  }

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Dose timer + plan</h3>

      {/* Per-med status */}
      <div className="grid gap-3 sm:grid-cols-2">
        {rules.map((r) => {
          const next = nextSafe(r, logs, rules, caps, now);
          const left = dosesLeft(r, logs, now);
          const ready = next !== null && next <= now + 5 * 60_000;
          return (
            <article key={r.brand} className="rounded-2xl border border-stone-200 bg-white p-4">
              <h4 className="font-semibold leading-snug">{r.brand}</h4>
              <p className="mt-1 text-xs text-stone-500">
                Label: {r.units_per_dose ?? "?"} {r.unit ?? "units"} every {r.min_interval_h}h
                {r.max_doses_24h !== null && `, max ${r.max_doses_24h} doses / 24h`}
              </p>
              <p className={`mt-3 text-lg font-semibold ${ready ? "text-emerald-700" : "text-stone-900"}`}>
                {next === null ? "Daily limit reached" : ready ? "OK to take now" : `Next safe dose: ${dayTime(next, now)}`}
              </p>
              {left !== null && <p className="text-sm text-stone-600">{left} dose(s) left in the last 24h window</p>}
              <details className="mt-2 text-xs text-stone-500">
                <summary className="cursor-pointer">Label directions ({r.parsed_by === "grok" ? "read by Grok, checked in code" : "parsed by rules"})</summary>
                <p className="mt-1">&ldquo;{r.directions}&rdquo; (openFDA label &ldquo;{r.label_name}&rdquo;)</p>
              </details>
            </article>
          );
        })}
      </div>

      {/* Ingredient allowance */}
      {Object.keys(remaining).length > 0 && (
        <div className="rounded-2xl border border-stone-200 bg-white p-4">
          {Object.entries(remaining).map(([k, v]) => {
            const left = Math.max(0, v.cap - v.used);
            return (
              <div key={k}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium capitalize">{k}</span>
                  <span className="text-sm text-stone-600">
                    <b className="text-stone-900">{left.toLocaleString()} mg</b> left of {v.cap.toLocaleString()} mg / 24h
                  </span>
                </div>
                <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-stone-100">
                  <div
                    className={`h-full rounded-full ${v.used / v.cap > 0.75 ? "bg-red-500" : "bg-stone-900"}`}
                    style={{ width: `${Math.min(100, (v.used / v.cap) * 100)}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-stone-500">Limit from {v.source}. Counts every product you logged.</p>
              </div>
            );
          })}
        </div>
      )}

      {/* Log a dose */}
      <div className="rounded-2xl border border-stone-200 bg-white p-4">
        <p className="font-medium">I took a dose</p>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <select value={brand} onChange={(e) => setBrand(e.target.value)} className="rounded-xl border border-stone-300 px-3 py-2.5">
            {rules.map((r) => (
              <option key={r.brand}>{r.brand}</option>
            ))}
          </select>
          <input
            type="datetime-local"
            value={takenAt}
            onChange={(e) => setTakenAt(e.target.value)}
            className="rounded-xl border border-stone-300 px-3 py-2.5"
          />
          <button
            onClick={() => {
              const at = new Date(takenAt).getTime();
              if (!Number.isFinite(at)) return;
              saveLogs([...logs, { id: `${at}-${Math.random().toString(36).slice(2, 7)}`, brand, at }]);
              setNow(Date.now());
            }}
            className="rounded-xl bg-stone-900 px-4 py-2.5 text-sm font-medium text-white"
          >
            Log dose
          </button>
        </div>
        {logs.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm text-stone-600">
            {[...logs]
              .sort((a, b) => b.at - a.at)
              .slice(0, 8)
              .map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-2">
                  <span>
                    {l.brand} at {dayTime(l.at, now).replace("tomorrow", "")}
                    {l.at < now - 24 * H && " (over 24h ago)"}
                  </span>
                  <button onClick={() => saveLogs(logs.filter((x) => x.id !== l.id))} className="text-xs text-stone-400 hover:text-red-600">
                    remove
                  </button>
                </li>
              ))}
          </ul>
        )}
      </div>

      {/* Schedule */}
      <div className="rounded-2xl border border-stone-200 bg-white p-4">
        <p className="font-medium">Your schedule today</p>
        <p className="text-sm text-stone-500">Upload a calendar (.ics) or paste it. We plan doses around it.</p>
        <div className="mt-3 flex flex-col gap-2">
          <label className="w-fit cursor-pointer rounded-xl border border-stone-300 px-4 py-2.5 text-sm text-stone-700 hover:bg-stone-100">
            Upload .ics
            <input type="file" accept=".ics,text/calendar" hidden onChange={(e) => onIcs(e.target.files?.[0])} />
          </label>
          <textarea
            value={schedText}
            onChange={(e) => setSchedText(e.target.value)}
            rows={3}
            placeholder={"9:30-10:45 CS 2110\n2:00-3:15pm MATH 2106\n5pm-6:30pm gym"}
            className="rounded-xl border border-stone-300 px-3 py-2 text-[15px] outline-none focus:border-stone-900"
          />
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={onText} className="rounded-xl border border-stone-300 px-4 py-2 text-sm text-stone-700 hover:bg-stone-100">
              Use this schedule
            </button>
            <label className="flex items-center gap-2 text-sm text-stone-600">
              <input type="checkbox" checked={sleep} onChange={(e) => setSleep(e.target.checked)} /> Avoid 11pm to 7am
            </label>
          </div>
          {schedMsg && <p className="text-xs text-stone-500">{schedMsg}</p>}
        </div>
      </div>

      {/* Plan + timeline */}
      <div className="rounded-2xl border border-stone-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium">Suggested times for</p>
          <select value={planRule.brand} onChange={(e) => setPlanFor(e.target.value)} className="rounded-lg border border-stone-300 px-2 py-1 text-sm">
            {rules.map((r) => (
              <option key={r.brand}>{r.brand}</option>
            ))}
          </select>
        </div>

        <div className="relative mt-8 h-12 rounded-lg bg-stone-100" aria-label="Next 24 hours timeline">
          {allBlocks
            .filter((b) => b.end > windowStart && b.start < windowEnd)
            .map((b, i) => (
              <div
                key={i}
                title={`${b.label} ${time(b.start)}-${time(b.end)}`}
                className={`absolute inset-y-0 overflow-hidden rounded-md px-1 text-[10px] leading-[3rem] ${
                  b.label === "Sleep" ? "bg-indigo-100 text-indigo-700" : "bg-stone-300 text-stone-700"
                }`}
                style={{ left: pct(b.start), width: `calc(${pct(b.end)} - ${pct(b.start)})` }}
              >
                {b.label}
              </div>
            ))}
          {logs
            .filter((l) => l.at > windowStart && l.at < windowEnd)
            .map((l) => (
              <div key={l.id} title={`${l.brand} taken ${time(l.at)}`} className="absolute -top-1 h-14 w-0.5 bg-stone-500" style={{ left: pct(l.at) }} />
            ))}
          {plan.map((p, i) => (
            <div key={i} className="absolute -top-6 -translate-x-1/2 text-center" style={{ left: pct(p.at) }}>
              <span className="block text-[10px] font-medium text-emerald-700">{time(p.at)}</span>
              <span className="mx-auto mt-0.5 block h-3 w-3 rounded-full border-2 border-white bg-emerald-600 shadow" />
            </div>
          ))}
          <div className="absolute -bottom-5 -translate-x-1/2 text-[10px] font-semibold text-red-600" style={{ left: pct(now) }}>
            now
          </div>
          <div className="absolute inset-y-0 w-0.5 bg-red-500" style={{ left: pct(now) }} />
        </div>
        <div className="mt-6 flex justify-between text-[10px] text-stone-400">
          <span>{time(windowStart)}</span>
          <span>{time(now + 11 * H)}</span>
          <span>{time(windowEnd)}</span>
        </div>

        {plan.length === 0 ? (
          <p className="mt-3 text-sm text-stone-600">No label-safe time left in the next 24 hours.</p>
        ) : (
          <ol className="mt-3 space-y-1.5 text-sm">
            {plan.map((p, i) => (
              <li key={i} className="flex gap-2">
                <span className="w-28 shrink-0 font-semibold text-emerald-700">{dayTime(p.at, now)}</span>
                <span className="text-stone-600">{p.note ? `Take ${p.note}` : "Earliest label-safe time"}</span>
              </li>
            ))}
          </ol>
        )}
        <p className="mt-3 text-xs text-stone-500">
          Times respect the label&apos;s minimum gap, the max per 24h, and shared ingredient limits across all your logged doses.
          Only take a dose if you still need it.
        </p>
      </div>

      <p className="rounded-xl bg-amber-50 px-4 py-3 text-center text-sm font-medium text-amber-900">
        Follow the label; ask a pharmacist.
      </p>
      {dosing.notes.length > 0 && (
        <ul className="space-y-1 text-xs text-stone-500">
          {dosing.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
