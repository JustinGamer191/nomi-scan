"use client";

import { useState } from "react";
import type { ScanResult } from "@/lib/types";

type Turn = { role: "user" | "assistant"; content: string };

const SUGGESTED = ["Can I drink alcohol with these?", "Will these make me drowsy?", "When should I stop and call a doctor?"];

export default function AskNomi({ result }: { result: ScanResult }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  async function ask(question: string) {
    const text = question.trim();
    if (!text || busy) return;
    setQ("");
    const history = turns;
    setTurns([...history, { role: "user", content: text }]);
    setBusy(true);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text, products: result.products, history, mock: result.mock }),
      });
      const data = await res.json();
      const answer = res.ok ? data.answer : data.error ?? "Something went wrong.";
      setTurns((t) => [...t, { role: "assistant", content: answer }]);
    } catch {
      setTurns((t) => [...t, { role: "assistant", content: "Network error. Try again." }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Ask Nomi</h3>
      <div className="rounded-2xl border border-stone-200 bg-white p-4">
        <p className="text-sm text-stone-500">
          Questions about the products you scanned. Answers come only from their FDA labels.
        </p>
        {turns.length > 0 && (
          <div className="mt-3 space-y-2" aria-live="polite">
            {turns.map((t, i) => (
              <div
                key={i}
                className={`max-w-[90%] rounded-2xl px-3 py-2 text-[15px] leading-relaxed ${
                  t.role === "user" ? "ml-auto bg-stone-900 text-white" : "bg-stone-100 text-stone-800"
                }`}
              >
                {t.content}
              </div>
            ))}
            {busy && <div className="w-fit rounded-2xl bg-stone-100 px-3 py-2 text-stone-500">Checking the labels...</div>}
          </div>
        )}
        {turns.length === 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {SUGGESTED.map((s) => (
              <button
                key={s}
                onClick={() => ask(s)}
                className="rounded-full border border-stone-300 px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-100"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            ask(q);
          }}
        >
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="e.g. Can I take these before driving?"
            className="min-w-0 flex-1 rounded-xl border border-stone-300 px-3 py-2.5 text-[15px] outline-none focus:border-stone-900"
            maxLength={500}
          />
          <button
            disabled={busy || !q.trim()}
            className="rounded-xl bg-stone-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40"
          >
            Ask
          </button>
        </form>
      </div>
    </section>
  );
}
