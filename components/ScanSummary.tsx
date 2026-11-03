"use client";

import { useState } from "react";
import { buildScanSummary } from "@/lib/scanSummary";
import type { ScanResult } from "@/lib/types";

export default function ScanSummary({ result, scannedAt }: { result: ScanResult; scannedAt: string }) {
  const [message, setMessage] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const summary = buildScanSummary(result, scannedAt);

  async function copy() {
    try {
      await navigator.clipboard.writeText(summary);
      setMessage("Summary copied.");
    } catch {
      setShowPreview(true);
      setMessage("Clipboard unavailable. Select and copy the summary below, or download it.");
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([summary], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "nomi-scan-summary.txt";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage("Summary download requested.");
  }

  return (
    <section aria-labelledby="summary-title" className="rounded-2xl border border-stone-200 bg-white p-5">
      <h2 id="summary-title" className="font-semibold">Bring this scan to your pharmacist</h2>
      <p className="mt-1 text-sm text-stone-600">
        Share products, strengths, warnings, and label sources. The summary includes your selected age group;
        review it before sharing. Photos, chat, and dose logs are excluded.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button onClick={copy} className="rounded-xl bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700">Copy summary</button>
        <button onClick={download} className="rounded-xl border border-stone-300 px-4 py-2 text-sm hover:bg-stone-100">Download .txt</button>
        <button onClick={() => setShowPreview(!showPreview)} aria-expanded={showPreview} aria-controls="summary-preview" className="rounded-xl px-4 py-2 text-sm underline">{showPreview ? "Hide preview" : "Preview summary"}</button>
      </div>
      <p role="status" className="mt-2 text-sm text-stone-600">{message}</p>
      {showPreview && <textarea id="summary-preview" aria-label="Scan summary" readOnly value={summary} rows={14} onFocus={(event) => event.currentTarget.select()} className="mt-3 w-full rounded-xl border border-stone-300 p-3 text-sm" />}
    </section>
  );
}
