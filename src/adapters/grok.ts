import os from "node:os";
import { runPty, stripAnsi } from "./pty.js";
import { adapterSignal } from "../runtime/spawn.js";
import type { ParsedQuota } from "./types.js";

const FULL_MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};
const ABBR_MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function parseGrokReset(raw: string, now: Date): string | null {
  const m = raw.trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const monStr = m[1].toLowerCase();
  const day = parseInt(m[2], 10);
  const hours = parseInt(m[3], 10);
  const mins = parseInt(m[4], 10);
  let month = FULL_MONTHS[monStr];
  if (month === undefined) month = ABBR_MONTHS[monStr.slice(0, 3)];
  if (month === undefined || !Number.isFinite(day) || !Number.isFinite(hours) || !Number.isFinite(mins)) return null;
  if (day < 1 || day > 31 || hours < 0 || hours > 23 || mins < 0 || mins > 59) return null;
  let year = now.getFullYear();
  let dt = new Date(year, month, day, hours, mins, 0, 0);
  if (Number.isNaN(dt.getTime())) return null;
  if (dt.getTime() < now.getTime()) {
    dt = new Date(year + 1, month, day, hours, mins, 0, 0);
    if (Number.isNaN(dt.getTime())) return null;
  }
  return dt.toISOString();
}

function validPct(v: number): v is number {
  return Number.isFinite(v) && v >= 0 && v <= 100;
}

export function parseGrokTui(text: string, now = new Date()): ParsedQuota {
  const cleaned = stripAnsi(text);
  // The TUI writes "Weekly lim", repositions the cursor, then writes
  // "t (Tier)", so after ANSI stripping the header reads "Weekly limt".
  // The [i!l] class stays optional to keep tolerating past glitch variants.
  const headerRe = /Weekly\s+lim[i!l]?t\s*\(([^)]+)\)/gi;
  let plan = "unknown";
  let lastHeaderIdx = -1;
  for (const m of cleaned.matchAll(headerRe)) {
    if (m.index === undefined) continue;
    plan = m[1].trim();
    lastHeaderIdx = m.index;
  }
  if (lastHeaderIdx < 0) {
    const tier = cleaned.match(/\b(SuperGrok|Grok\s+Pro|Grok\s+Enterprise|Grok\s+Basic)\b/i);
    if (tier) plan = tier[1].trim();
  }
  let usedPct: number | null = null;
  // 1. Dialog header: first percent in a bounded window after the LAST
  // header (later renders supersede earlier ones). The bar percent sits on
  // the line below the header, so this must span newlines.
  if (lastHeaderIdx >= 0) {
    const after = cleaned.slice(lastHeaderIdx, lastHeaderIdx + 1200);
    const m = after.match(/(\d{1,3})%/);
    if (m) {
      const v = parseInt(m[1], 10);
      if (validPct(v)) usedPct = v;
    }
  }
  // 2. Legacy same-line form ("Weekly limit (Tier) 26%"), excluding the
  // startup status line "Weekly limit left: N%", which reports REMAINING
  // quota with inverted semantics. Last valid match wins.
  if (usedPct === null) {
    const lineRe = /Weekly\s+lim[i!l]?t[^\n%]*?(\d{1,3})%/gi;
    for (const m of cleaned.matchAll(lineRe)) {
      if (/left/i.test(m[0])) continue;
      const v = parseInt(m[1], 10);
      if (validPct(v)) usedPct = v;
    }
  }
  // 3. Bare progress-bar percent. Last valid match wins.
  if (usedPct === null) {
    const barRe = /[█░▓▒]+\s*(\d{1,3})%/g;
    for (const m of cleaned.matchAll(barRe)) {
      const v = parseInt(m[1], 10);
      if (validPct(v)) usedPct = v;
    }
  }
  // 4. Status-line remaining figure ("Weekly limit left: N%") converted to
  // used. Last valid match wins.
  if (usedPct === null) {
    const leftRe = /Weekly\s+lim[i!l]?t\s+left\s*:?\s*(\d{1,3})%/gi;
    for (const m of cleaned.matchAll(leftRe)) {
      const v = parseInt(m[1], 10);
      if (validPct(v)) usedPct = 100 - v;
    }
  }
  if (usedPct === null) throw new Error("grok: weekly percent not found in TUI output");
  let creditsUsd: number | undefined;
  const mCred = cleaned.match(/Credits:\s*\$([0-9]+(?:\.[0-9]+)?)/i);
  if (mCred) {
    const v = parseFloat(mCred[1]);
    if (Number.isFinite(v) && v >= 0) creditsUsd = v;
  }
  const resetRe = /Resets:\s*([A-Za-z]+\s+\d+,\s*\d+:\d+)/gi;
  let resetsRaw: string | null = null;
  for (const m of cleaned.matchAll(resetRe)) resetsRaw = m[1].trim();
  let resetsAt: string | null = null;
  let estimated = false;
  if (resetsRaw) {
    resetsAt = parseGrokReset(resetsRaw, now);
    if (!resetsAt) throw new Error(`grok: bad resets timestamp "${resetsRaw}"`);
  } else if (cleaned.match(/Resets:/i)) {
    throw new Error("grok: bad resets timestamp");
  } else {
    resetsAt = new Date(now.getTime() + 7 * 86400000).toISOString();
    estimated = true;
  }
  const periodStart = new Date(new Date(resetsAt).getTime() - 7 * 86400000).toISOString();
  return {
    provider: "grok",
    plan,
    usedPct,
    resetsAt,
    periodStart,
    source: "tui",
    fetchedAt: now.toISOString(),
    creditsUsd,
    resetsAtEstimated: estimated || undefined,
    raw: cleaned.slice(0, 4096),
  };
}

export const grokAdapter = {
  id: "grok",
  requiresAuth: "grok login (CLI owns credentials)",
  async poll(): Promise<ParsedQuota> {
    const transcript = await runPty({
      file: "grok",
      args: [],
      cwd: os.homedir(),
      cols: 140,
      rows: 50,
      settleDelayMs: 5000,
      input: "/usage\r",
      // Wait for the usage dialog (tier header or Resets line), not the
      // startup status line "Weekly limit left: N%", which matches /Weekly lim/
      // and would complete before the dialog renders.
      completionRegex: /Weekly\s+lim[i!l]?t\s*\(|Resets:|Credits:/i,
      timeoutMs: 14000,
      maxBytes: 256 * 1024,
      signal: adapterSignal("grok"),
      label: "grok",
    });
    return parseGrokTui(transcript);
  },
};
