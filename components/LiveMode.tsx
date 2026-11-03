"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SeenProduct } from "@/lib/pipeline";
import type { Flag } from "@/lib/types";

type Status = "red" | "yellow" | "green";

type FrameResponse = {
  mock: boolean;
  products: SeenProduct[];
  flags: Flag[];
  status: Status;
  added: string[];
  hint: string | null;
  error?: string;
};

// Minimal Web Speech API typing (not in TS's DOM lib everywhere).
type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};
type RecognitionCtor = new () => Recognition;

const INTERVAL_MS = 2500;
const MAX_SIDE = 768;

const STATUS_STYLE: Record<Status, { label: string; cls: string; dot: string }> = {
  red: { label: "Do not combine without asking", cls: "bg-red-600 text-white", dot: "bg-white" },
  yellow: { label: "Use caution", cls: "bg-amber-400 text-amber-950", dot: "bg-amber-950" },
  green: { label: "No overlaps so far", cls: "bg-emerald-600 text-white", dot: "bg-white" },
};

// "Vicks NyQuil Cold & Flu" -> "NyQuil", "Tylenol Extra Strength" -> "Tylenol"
const short = (brand: string) => brand.replace(/^vicks\s+/i, "").split(" ")[0];

// Spoken warning built from the flag itself, capped at 20 words.
function warningText(f: Flag): string {
  const names = f.products.map(short).join(" and ");
  const text =
    f.kind === "duplicate"
      ? `Warning. ${names} both contain ${f.ingredients[0]}. Don't take them together. Ask a pharmacist.`
      : `Caution. ${names}: ${f.title.toLowerCase()}. Ask a pharmacist.`;
  const words = text.split(/\s+/);
  return words.length <= 20 ? text : words.slice(0, 19).join(" ") + ". Ask a pharmacist.";
}

export default function LiveMode() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const inFlight = useRef(false);
  const tick = useRef(0);
  const seenRef = useRef<SeenProduct[]>([]);
  const spoken = useRef(new Set<string>());
  const recRef = useRef<Recognition | null>(null);

  const [running, setRunning] = useState<null | "camera" | "demo">(null);
  const [paused, setPaused] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [products, setProducts] = useState<SeenProduct[]>([]);
  const [flags, setFlags] = useState<Flag[]>([]);
  const [status, setStatus] = useState<Status>("green");
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [listening, setListening] = useState(false);
  const [caption, setCaption] = useState<{ q: string; a: string } | null>(null);
  const [typed, setTyped] = useState("");
  const [asking, setAsking] = useState(false);
  const [srSupported, setSrSupported] = useState(true); // any voice input available
  const [voiceOut, setVoiceOut] = useState<"grok" | "browser">("grok");
  const [micMode, setMicMode] = useState<"grok" | "browser" | "none">("grok");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const speechGen = useRef(0);
  const speechChain = useRef<Promise<void>>(Promise.resolve());
  const recorderRef = useRef<MediaRecorder | null>(null);
  const mutedRef = useRef(muted);
  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  useEffect(() => {
    const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
    const hasSR = !!(w.SpeechRecognition || w.webkitSpeechRecognition);
    const hasRec = typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMicMode(hasRec ? "grok" : hasSR ? "browser" : "none");
    setSrSupported(hasRec || hasSR);
  }, []);

  const browserSpeak = useCallback(
    (text: string) =>
      new Promise<void>((resolve) => {
        if (!("speechSynthesis" in window)) return resolve();
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 1.05;
        u.onend = () => resolve();
        u.onerror = () => resolve();
        window.speechSynthesis.speak(u);
      }),
    [],
  );

  // Grok voice via our /api/voice/tts proxy (key stays on the server).
  // Falls back to the browser's speechSynthesis if the call or playback fails.
  const grokSpeak = useCallback(
    async (text: string, gen: number) => {
      try {
        const res = await fetch("/api/voice/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) throw new Error(`tts ${res.status}`);
        const url = URL.createObjectURL(await res.blob());
        if (gen !== speechGen.current || mutedRef.current) return URL.revokeObjectURL(url);
        const audio = new Audio(url);
        audioRef.current = audio;
        await new Promise<void>((resolve, reject) => {
          audio.onended = () => resolve();
          audio.onpause = () => resolve();
          audio.onerror = () => reject(new Error("playback"));
          audio.play().catch(reject);
        });
        URL.revokeObjectURL(url);
        setVoiceOut("grok");
      } catch {
        if (gen !== speechGen.current || mutedRef.current) return;
        setVoiceOut("browser");
        await browserSpeak(text);
      }
    },
    [browserSpeak],
  );

  // Queue utterances so a warning and an answer never talk over each other.
  const speak = useCallback(
    (text: string) => {
      if (mutedRef.current || typeof window === "undefined") return;
      const gen = speechGen.current;
      speechChain.current = speechChain.current.then(() => (gen === speechGen.current ? grokSpeak(text, gen) : undefined));
    },
    [grokSpeak],
  );

  const stopSpeech = useCallback(() => {
    speechGen.current += 1;
    speechChain.current = Promise.resolve();
    audioRef.current?.pause();
    audioRef.current = null;
    window.speechSynthesis?.cancel();
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  // Attach the stream once the <video> element has mounted.
  useEffect(() => {
    const v = videoRef.current;
    if (running === "camera" && v && streamRef.current && v.srcObject !== streamRef.current) {
      v.srcObject = streamRef.current;
      v.play().catch(() => {});
    }
  }, [running]);

  function grabFrame(): string | null {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return null;
    const scale = Math.min(1, MAX_SIDE / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(v.videoWidth * scale);
    c.height = Math.round(v.videoHeight * scale);
    c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.8);
  }

  const sendFrame = useCallback(async () => {
    if (inFlight.current) return;
    const demo = running === "demo";
    const image = demo ? undefined : grabFrame();
    if (!demo && !image) return;
    inFlight.current = true;
    setScanning(true);
    try {
      const res = await fetch("/api/live-frame", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image, seen: seenRef.current, mock: demo, tick: tick.current }),
      });
      const data = (await res.json()) as FrameResponse;
      tick.current += 1;
      if (!res.ok) {
        setError(data.error ?? `Live scan failed (${res.status})`);
        return;
      }
      setError(null);
      seenRef.current = data.products;
      setProducts(data.products);
      setFlags(data.flags);
      setStatus(data.status);
      setHint(data.hint);
      for (const f of data.flags) {
        if (!spoken.current.has(f.id)) {
          spoken.current.add(f.id);
          speak(warningText(f));
        }
      }
    } catch {
      setError("Network error. Retrying...");
    } finally {
      inFlight.current = false;
      setScanning(false);
    }
  }, [running, speak]);

  // Frame loop: every ~2.5s, only when nothing is in flight.
  useEffect(() => {
    if (!running || paused) return;
    const first = setTimeout(sendFrame, 300);
    const id = setInterval(sendFrame, INTERVAL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [running, paused, sendFrame]);

  function reset() {
    seenRef.current = [];
    spoken.current = new Set();
    tick.current = 0;
    setProducts([]);
    setFlags([]);
    setStatus("green");
    setHint(null);
    setCaption(null);
  }

  async function startCamera() {
    setError(null);
    reset();
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Camera needs localhost or HTTPS. Use the demo, or open this page over https.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      setRunning("camera");
      setPaused(false);
    } catch (e) {
      setError(
        e instanceof Error && e.name === "NotAllowedError"
          ? "Camera permission was denied. Allow it in the browser, or use the demo."
          : "Couldn't open the camera. Use the demo instead.",
      );
    }
  }

  function startDemo() {
    stopCamera();
    reset();
    setError(null);
    setRunning("demo");
    setPaused(false);
  }

  function stopAll() {
    stopCamera();
    setRunning(null);
    setPaused(false);
    stopSpeech();
    recorderRef.current?.stop();
  }

  async function ask(question: string) {
    const q = question.trim();
    if (!q) return;
    if (!seenRef.current.length) {
      const a = "Show me a medication first, then ask about it.";
      setCaption({ q, a });
      speak(a);
      return;
    }
    setAsking(true);
    setCaption({ q, a: "Checking the labels..." });
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, products: seenRef.current, mock: running === "demo" }),
      });
      const data = await res.json();
      const a = res.ok ? String(data.answer) : data.error ?? "Something went wrong.";
      setCaption({ q, a });
      speak(a);
    } catch {
      setCaption({ q, a: "Network error. Try again." });
    } finally {
      setAsking(false);
    }
  }

  // Grok speech-to-text: record a short clip, send it to /api/voice/stt.
  async function startGrokMic() {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Microphone permission was denied. Type your question instead.");
      setMicMode("none");
      setSrSupported(false);
      return;
    }
    const rec = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      recorderRef.current = null;
      setListening(false);
      const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
      if (blob.size < 1000) return;
      setCaption({ q: "...", a: "Transcribing with Grok..." });
      try {
        const fd = new FormData();
        fd.append("audio", blob, rec.mimeType.includes("mp4") ? "question.mp4" : "question.webm");
        const res = await fetch("/api/voice/stt", { method: "POST", body: fd });
        const data = (await res.json()) as { text?: string; error?: string };
        if (!res.ok) throw new Error(data.error);
        if (data.text) ask(data.text);
        else setCaption({ q: "(didn't catch that)", a: "Try again, a little closer to the mic." });
      } catch {
        // Fall back to the browser recognizer for the next question.
        const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
        const fallback = !!(w.SpeechRecognition || w.webkitSpeechRecognition);
        setMicMode(fallback ? "browser" : "none");
        setSrSupported(fallback);
        setCaption({ q: "(transcription failed)", a: fallback ? "Switched to browser speech. Tap Ask Nomi again." : "Type your question below." });
      }
    };
    recorderRef.current = rec;
    setListening(true);
    rec.start();
    // Safety stop after 12s.
    setTimeout(() => rec.state === "recording" && rec.stop(), 12000);
  }

  function toggleMic() {
    if (listening) {
      if (recorderRef.current) recorderRef.current.stop();
      else recRef.current?.stop();
      return;
    }
    stopSpeech();
    if (micMode === "grok") {
      startGrokMic();
      return;
    }
    const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) {
      setSrSupported(false);
      return;
    }
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    let finalText = "";
    rec.onresult = (e) => {
      const text = Array.from(e.results)
        .map((r) => r[0].transcript)
        .join(" ");
      finalText = text;
      setCaption({ q: text, a: "" });
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed") setError("Microphone permission was denied. Type your question instead.");
      setSrSupported(e.error !== "not-allowed");
    };
    rec.onend = () => {
      setListening(false);
      recRef.current = null;
      if (finalText.trim()) ask(finalText);
    };
    recRef.current = rec;
    setListening(true);
    rec.start();
  }

  const s = STATUS_STYLE[status];

  return (
    <div className="space-y-4">
      {/* Camera / demo stage */}
      <div className="relative overflow-hidden rounded-2xl bg-stone-900">
        {running === "camera" ? (
          <video ref={videoRef} playsInline muted autoPlay className="aspect-[3/4] w-full object-cover sm:aspect-video" />
        ) : (
          <div className="grid aspect-[3/4] w-full place-items-center p-6 text-center text-stone-300 sm:aspect-video">
            {running === "demo" ? (
              <div>
                <p className="text-lg font-medium text-white">Demo camera</p>
                <p className="mt-1 text-sm">Simulating Tylenol, then NyQuil, coming into view...</p>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-lg font-medium text-white">Point your camera at your meds</p>
                <p className="text-sm">Nomi watches, reads each box, and warns you out loud.</p>
                <div className="flex flex-wrap justify-center gap-2">
                  <button onClick={startCamera} className="rounded-xl bg-white px-5 py-3 font-medium text-stone-900">
                    Start camera
                  </button>
                  <button onClick={startDemo} className="rounded-xl border border-stone-500 px-4 py-3 text-sm text-white">
                    Demo without camera
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {running && (
          <>
            <div className={`absolute inset-x-3 top-3 flex items-center gap-2 rounded-xl px-3 py-2 shadow ${s.cls}`}>
              <span className={`h-2.5 w-2.5 rounded-full ${s.dot}`} />
              <span className="text-sm font-semibold">{s.label}</span>
              <span className="ml-auto flex items-center gap-1.5 text-xs opacity-90">
                {paused ? (
                  "Paused"
                ) : (
                  <>
                    <span className={`h-2 w-2 rounded-full bg-current ${scanning ? "animate-ping" : "animate-pulse"}`} />
                    Scanning...
                  </>
                )}
              </span>
            </div>
            <div className="absolute right-3 top-14 flex gap-1.5 text-[11px] font-medium">
              <span className={`rounded-full px-2 py-0.5 ${voiceOut === "grok" ? "bg-black/70 text-white" : "bg-white/80 text-stone-800"}`}>
                Voice: {voiceOut === "grok" ? "Grok" : "browser"}
              </span>
              {micMode !== "none" && (
                <span className={`rounded-full px-2 py-0.5 ${micMode === "grok" ? "bg-black/70 text-white" : "bg-white/80 text-stone-800"}`}>
                  Mic: {micMode === "grok" ? "Grok" : "browser"}
                </span>
              )}
            </div>
            {caption && (
              <div className="absolute inset-x-3 bottom-20 rounded-xl bg-black/70 px-3 py-2 text-sm text-white" aria-live="polite">
                <p className="text-white/70">&ldquo;{caption.q}&rdquo;</p>
                {caption.a && <p className="mt-1">{caption.a}</p>}
              </div>
            )}
            <div className="absolute inset-x-3 bottom-3 flex items-center gap-2">
              <button
                onClick={() => setPaused((p) => !p)}
                className="rounded-full bg-white/90 px-4 py-2.5 text-sm font-medium text-stone-900"
              >
                {paused ? "Resume" : "Pause"}
              </button>
              <button
                onClick={() => {
                  setMuted((m) => !m);
                  stopSpeech();
                }}
                aria-pressed={muted}
                className="rounded-full bg-white/90 px-4 py-2.5 text-sm font-medium text-stone-900"
              >
                {muted ? "Unmute" : "Mute"}
              </button>
              {srSupported && (
                <button
                  onClick={toggleMic}
                  disabled={asking}
                  aria-pressed={listening}
                  className={`ml-auto rounded-full px-4 py-2.5 text-sm font-semibold ${
                    listening ? "animate-pulse bg-red-600 text-white" : "bg-white text-stone-900"
                  }`}
                >
                  {listening ? "Listening... tap to send" : "Ask Nomi"}
                </button>
              )}
              <button onClick={stopAll} className={`rounded-full bg-black/60 px-4 py-2.5 text-sm text-white ${srSupported ? "" : "ml-auto"}`}>
                End
              </button>
            </div>
          </>
        )}
      </div>

      {error && (
        <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}
      {hint && running && <p className="text-sm text-amber-800">Last frame: {hint}. Move closer to the label.</p>}

      {running && !srSupported && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            ask(typed);
            setTyped("");
          }}
        >
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Voice not supported here. Type a question for Nomi"
            className="min-w-0 flex-1 rounded-xl border border-stone-300 px-3 py-2.5 text-[15px]"
            maxLength={500}
          />
          <button disabled={asking || !typed.trim()} className="rounded-xl bg-stone-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40">
            Ask
          </button>
        </form>
      )}

      {/* Flags */}
      {flags.length > 0 && (
        <section className="space-y-2">
          {flags.map((f) => (
            <article key={f.id} className={`rounded-2xl border bg-white p-4 ${f.severity === "red" ? "border-red-300" : "border-amber-300"}`}>
              <div className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${f.severity === "red" ? "bg-red-500" : "bg-amber-500"}`} />
                <h4 className="font-semibold">{f.title}</h4>
              </div>
              <p className="mt-1 text-xs text-stone-500">In: {f.products.join(" + ")}</p>
              {f.explanation && <p className="mt-2 text-[15px] leading-relaxed text-stone-800">{f.explanation}</p>}
              {f.citations?.map((c, i) => (
                <p key={i} className="mt-1 text-xs text-stone-500">
                  Source: {c}
                </p>
              ))}
            </article>
          ))}
        </section>
      )}

      {/* Seen so far */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Seen so far ({products.length})</h3>
        {products.length === 0 ? (
          <p className="text-sm text-stone-500">{running ? "Hold each box up to the camera, front label facing it." : "Nothing yet."}</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {products.map((p) => (
              <li key={p.brand + p.keys.join()} className="rounded-xl border border-stone-200 bg-white p-3">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium">{p.brand}</span>
                  <span className="shrink-0 text-xs text-stone-400">seen {p.seen}x</span>
                </div>
                <p className="mt-1 text-sm text-stone-600">
                  {p.active_ingredients.map((a) => `${a.name} ${a.strength}`.trim()).join(", ")}
                </p>
              </li>
            ))}
          </ul>
        )}
        {products.length > 0 && (
          <button onClick={reset} className="text-sm text-stone-500 hover:text-red-600">
            Clear list
          </button>
        )}
      </section>
    </div>
  );
}
