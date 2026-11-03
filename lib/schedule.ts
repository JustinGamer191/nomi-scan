// Deterministic dose-timing math and schedule parsing. No LLM in here.
// Shared by the client (planner UI) and the /api/schedule route.

export type Block = { label: string; start: number; end: number }; // epoch ms
export type HHMMBlock = { label: string; start: string; end: string }; // "HH:MM" 24h
export type DoseLog = { id: string; brand: string; at: number };

export type RuleLite = {
  brand: string;
  min_interval_h: number | null;
  max_doses_24h: number | null;
  mg_per_dose: Record<string, number>;
};
export type Caps = Record<string, { mg: number; source: string }>;

const H = 3600_000;
const DAY = 24 * H;

// ---------- Text schedules ("9:30-10:45 CS 2110") ----------

function to24(h: number, m: number, mer?: string) {
  if (mer) {
    const pm = mer.toLowerCase().startsWith("p");
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  }
  return h * 60 + m;
}

const fmt = (mins: number) =>
  `${String(Math.floor(mins / 60) % 24).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

export function parseScheduleText(text: string): HHMMBlock[] {
  const out: HHMMBlock[] = [];
  const re =
    /(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*(?:-|–|—|to|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/i;
  for (const line of text.split(/\n|;/)) {
    const m = re.exec(line);
    if (!m) continue;
    const [h1, m1, mer1, h2, m2, mer2] = [Number(m[1]), Number(m[2] ?? 0), m[3], Number(m[4]), Number(m[5] ?? 0), m[6]];
    if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) continue;
    let s = to24(h1, m1, mer1);
    let e = to24(h2, m2, mer2);
    if (!mer1 && mer2) {
      // "2-3:15pm": apply the end's meridiem to the start when that keeps order.
      const alt = to24(h1, m1, mer2);
      if (alt < e) s = alt;
    }
    if (!mer1 && !mer2) {
      // No am/pm at all: assume 1-6 means afternoon (class/work schedules).
      if (h1 >= 1 && h1 <= 6) s += 12 * 60;
      if (h2 >= 1 && h2 <= 6) e += 12 * 60;
      if (e <= s && h2 < 12) e += 12 * 60;
    }
    if (e <= s) continue;
    const label = line.replace(m[0], "").replace(/^[\s:,.-]+|[\s:,.-]+$/g, "") || "Busy";
    out.push({ label: label.slice(0, 60), start: fmt(s), end: fmt(e) });
  }
  return out;
}

export function isHHMM(s: unknown): s is string {
  return typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

// Turn "HH:MM" blocks into real times today (local).
export function blocksForToday(list: HHMMBlock[], now = Date.now()): Block[] {
  const d = new Date(now);
  return list
    .filter((b) => isHHMM(b.start) && isHHMM(b.end))
    .map((b) => {
      const [sh, sm] = b.start.split(":").map(Number);
      const [eh, em] = b.end.split(":").map(Number);
      const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), sh, sm).getTime();
      let e = new Date(d.getFullYear(), d.getMonth(), d.getDate(), eh, em).getTime();
      if (e <= s) e += DAY;
      return { label: b.label, start: s, end: e };
    });
}

// ---------- .ics files ----------

function icsDate(v: string): { t: number; allDay: boolean } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v.trim());
  if (!m) return null;
  const [y, mo, d, hh, mi, ss, z] = [+m[1], +m[2] - 1, +m[3], m[4], m[5], m[6], m[7]];
  if (hh === undefined) return { t: new Date(y, mo, d).getTime(), allDay: true };
  const t = z
    ? Date.UTC(y, mo, d, +hh, +mi, +(ss ?? 0))
    : new Date(y, mo, d, +hh, +mi, +(ss ?? 0)).getTime(); // TZID treated as local
  return { t, allDay: false };
}

function durationMs(v: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(v.trim());
  if (!m) return H;
  return (+(m[1] ?? 0) * 24 + +(m[2] ?? 0)) * H + +(m[3] ?? 0) * 60_000;
}

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

// Busy blocks overlapping [from, to]. Expands simple DAILY/WEEKLY RRULEs.
export function parseIcs(text: string, from: number, to: number): Block[] {
  const lines = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
  const out: Block[] = [];
  let ev: Record<string, string> | null = null;
  const exdates: string[] = [];
  for (const raw of lines) {
    if (raw === "BEGIN:VEVENT") {
      ev = {};
      exdates.length = 0;
      continue;
    }
    if (raw === "END:VEVENT" && ev) {
      const start = ev.DTSTART ? icsDate(ev.DTSTART) : null;
      if (start && !start.allDay) {
        const endD = ev.DTEND ? icsDate(ev.DTEND) : null;
        const len = endD ? endD.t - start.t : ev.DURATION ? durationMs(ev.DURATION) : H;
        const label = (ev.SUMMARY ?? "Busy").replace(/\\,/g, ",").replace(/\\n/g, " ").slice(0, 60);
        const ex = new Set(exdates.flatMap((x) => x.split(",")).map((x) => x.slice(0, 8)));
        const push = (s: number) => {
          const key = new Date(s);
          const ymd = `${key.getFullYear()}${String(key.getMonth() + 1).padStart(2, "0")}${String(key.getDate()).padStart(2, "0")}`;
          if (!ex.has(ymd) && s < to && s + len > from) out.push({ label, start: s, end: s + len });
        };
        const rr = ev.RRULE
          ? Object.fromEntries(ev.RRULE.split(";").map((kv) => kv.split("=") as [string, string]))
          : null;
        if (!rr) push(start.t);
        else if (rr.FREQ === "DAILY" || rr.FREQ === "WEEKLY") {
          const until = rr.UNTIL ? icsDate(rr.UNTIL)?.t ?? Infinity : Infinity;
          const interval = Math.max(1, Number(rr.INTERVAL ?? 1));
          const first = new Date(start.t);
          const byday = rr.BYDAY ? rr.BYDAY.split(",").map((d) => d.slice(-2)) : [DAYS[first.getDay()]];
          for (let day = new Date(from - DAY); day.getTime() <= to; day = new Date(day.getTime() + DAY)) {
            const occ = new Date(day.getFullYear(), day.getMonth(), day.getDate(), first.getHours(), first.getMinutes()).getTime();
            if (occ < start.t || occ > until) continue;
            const daysSince = Math.round((occ - start.t) / DAY);
            if (rr.FREQ === "DAILY" && daysSince % interval !== 0) continue;
            if (rr.FREQ === "WEEKLY") {
              if (!byday.includes(DAYS[new Date(occ).getDay()])) continue;
              if (Math.floor(daysSince / 7) % interval !== 0) continue;
            }
            push(occ);
          }
        }
      }
      ev = null;
      continue;
    }
    if (!ev) continue;
    const idx = raw.indexOf(":");
    if (idx < 0) continue;
    const name = raw.slice(0, idx).split(";")[0].toUpperCase();
    const value = raw.slice(idx + 1);
    if (name === "EXDATE") exdates.push(value);
    else ev[name] = value;
  }
  return out.sort((a, b) => a.start - b.start);
}

// ---------- Dose math ----------

function mgUsed(key: string, logs: DoseLog[], rules: RuleLite[], from: number, to: number) {
  let mg = 0;
  for (const l of logs) {
    if (l.at <= from || l.at > to) continue;
    mg += rules.find((r) => r.brand === l.brand)?.mg_per_dose[key] ?? 0;
  }
  return mg;
}

// Would adding `weight` at time t keep every 24h window containing t at or under `cap`?
// Windows worth checking start at t-24h, at t, at each nearby event, and just after each.
function windowOk(t: number, events: { at: number; w: number }[], weight: number, cap: number): boolean {
  const near = events.filter((e) => Math.abs(e.at - t) < DAY);
  const starts = new Set<number>([t - DAY + 1, t]);
  for (const e of near) {
    if (e.at <= t) starts.add(e.at);
    else starts.add(e.at - DAY + 1);
  }
  for (const w of starts) {
    if (w > t || w + DAY <= t) continue;
    let sum = weight;
    for (const e of near) if (e.at >= w && e.at < w + DAY) sum += e.w;
    if (sum > cap) return false;
  }
  return true;
}

// Is a dose of `rule` at time t allowed by the label, given all logged doses?
export function allowedAt(t: number, rule: RuleLite, logs: DoseLog[], rules: RuleLite[], caps: Caps): boolean {
  const mine = logs.filter((l) => l.brand === rule.brand);
  if (rule.min_interval_h !== null && mine.some((l) => Math.abs(t - l.at) < rule.min_interval_h! * H)) return false;
  if (rule.max_doses_24h !== null && !windowOk(t, mine.map((l) => ({ at: l.at, w: 1 })), 1, rule.max_doses_24h)) {
    return false;
  }
  for (const [key, mg] of Object.entries(rule.mg_per_dose)) {
    const cap = caps[key]?.mg;
    if (!cap) continue;
    const events = logs.map((l) => ({ at: l.at, w: rules.find((r) => r.brand === l.brand)?.mg_per_dose[key] ?? 0 }));
    if (!windowOk(t, events.filter((e) => e.w > 0), mg, cap)) return false;
  }
  return true;
}

const STEP = 5 * 60_000;

function roundUp(t: number) {
  return Math.ceil(t / STEP) * STEP;
}

export function nextSafe(rule: RuleLite, logs: DoseLog[], rules: RuleLite[], caps: Caps, now: number): number | null {
  for (let t = roundUp(now); t < now + 2 * DAY; t += STEP) {
    if (allowedAt(t, rule, logs, rules, caps)) return t;
  }
  return null;
}

export function remainingMg(caps: Caps, logs: DoseLog[], rules: RuleLite[], now: number) {
  return Object.fromEntries(
    Object.entries(caps).map(([k, c]) => [k, { cap: c.mg, used: mgUsed(k, logs, rules, now - DAY, now), source: c.source }]),
  );
}

export function dosesLeft(rule: RuleLite, logs: DoseLog[], now: number): number | null {
  if (rule.max_doses_24h === null) return null;
  const n = logs.filter((l) => l.brand === rule.brand && l.at > now - DAY && l.at <= now).length;
  return Math.max(0, rule.max_doses_24h - n);
}

export type Suggestion = { at: number; note?: string };

// Greedy plan for the next `horizon` ms: earliest label-safe time, never inside a busy block.
export function planDoses(
  rule: RuleLite,
  logs: DoseLog[],
  rules: RuleLite[],
  caps: Caps,
  blocks: Block[],
  now: number,
  horizon = DAY,
): Suggestion[] {
  const planned: DoseLog[] = [];
  const out: Suggestion[] = [];
  let t = roundUp(now);
  const inBlock = (x: number) => blocks.find((b) => x >= b.start && x < b.end);
  while (t < now + horizon && out.length < 12) {
    const all = [...logs, ...planned];
    let earliest: number | null = null;
    for (let x = t; x < now + horizon; x += STEP) {
      if (allowedAt(x, rule, all, rules, caps)) {
        earliest = x;
        break;
      }
    }
    if (earliest === null) break;
    let at = earliest;
    let note: string | undefined;
    let b = inBlock(at);
    while (b) {
      note = `after ${b.label} (would land during it)`;
      at = roundUp(b.end);
      b = inBlock(at);
    }
    if (at >= now + horizon) break;
    if (!allowedAt(at, rule, all, rules, caps)) {
      t = at + STEP;
      continue;
    }
    const next = blocks.find((x) => x.start > at && x.start - at <= 60 * 60_000);
    if (!note && next) note = `before ${next.label}`;
    out.push({ at, note });
    planned.push({ id: `plan-${at}`, brand: rule.brand, at });
    t = at + STEP;
  }
  return out;
}
