import os from "node:os";
import { runPty, stripAnsi } from "./pty.js";
import { adapterSignal } from "../runtime/spawn.js";
import type { ParsedQuota } from "./types.js";

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// Codex 0.157 prints "9:14 AM on 30 Sep" and "9:43 PM". Older panels print
// "23:04 on 19 Sep" and "19:38". 12 AM is 00:00 and 12 PM is 12:00.
function clockHours(hours: number, mins: number, ampm: string | undefined): number | null {
  if (!Number.isFinite(hours) || !Number.isFinite(mins) || mins < 0 || mins > 59) return null;
  if (!ampm) return hours >= 0 && hours <= 23 ? hours : null;
  if (hours < 1 || hours > 12) return null;
  const pm = ampm.toLowerCase() === "pm";
  if (hours === 12) return pm ? 12 : 0;
  return pm ? hours + 12 : hours;
}

function parseWeeklyReset(raw: string, now: Date): string | null {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})(?:\s*([AaPp][Mm]))?\s+on\s+(\d{1,2})\s+([A-Za-z]{3,9})$/);
  if (!m) return null;
  const hours = clockHours(parseInt(m[1], 10), parseInt(m[2], 10), m[3]);
  const day = parseInt(m[4], 10);
  const month = MONTHS[m[5].slice(0, 3).toLowerCase()];
  if (hours === null || month === undefined || !Number.isFinite(day) || day < 1 || day > 31) return null;
  let year = now.getFullYear();
  let dt = new Date(year, month, day, hours, parseInt(m[2], 10), 0, 0);
  if (Number.isNaN(dt.getTime())) return null;
  if (dt.getTime() < now.getTime()) {
    dt = new Date(year + 1, month, day, hours, parseInt(m[2], 10), 0, 0);
    if (Number.isNaN(dt.getTime())) return null;
  }
  if (dt.getTime() < now.getTime()) return null;
  return dt.toISOString();
}

function parseFiveReset(raw: string, now: Date): string | null {
  // The 5h reset is bare ("19:38" or "9:43 PM") when it falls today and
  // date-qualified ("02:43 on 15 Sep", weekly shape) otherwise; accept both.
  const qualified = parseWeeklyReset(raw, now);
  if (qualified) return qualified;
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})(?:\s*([AaPp][Mm]))?$/);
  if (!m) return null;
  const hours = clockHours(parseInt(m[1], 10), parseInt(m[2], 10), m[3]);
  if (hours === null) return null;
  let dt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, parseInt(m[2], 10), 0, 0);
  if (dt.getTime() < now.getTime()) {
    dt = new Date(dt.getTime() + 86400000);
  }
  return dt.toISOString();
}

export function parseCodexTui(text: string, now = new Date()): ParsedQuota {
  const cleaned = stripAnsi(text);
  if (/refresh token was already used|please log out and sign in again|access token could not be refreshed/i.test(cleaned)) {
    throw new Error("codex: your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.");
  }
  if (/Limits:\s*refresh requested/i.test(cleaned)) {
    throw new Error("codex: limits refresh requested, run /status again shortly");
  }
  let weeklyLeft: number | null = null;
  let fiveLeft: number | null = null;
  let weeklyRaw: string | null = null;
  let fiveRaw: string | null = null;
  const weeklyRe = /Weekly limit:\s*(?:\[[^\]]*\]\s*)?(\d+)%\s*left\s*\(resets\s+([^)]+)\)/i;
  const fiveRe = /5h limit:\s*(?:\[[^\]]*\]\s*)?(\d+)%\s*left\s*\(resets\s+([^)]+)\)/i;
  const w = cleaned.match(weeklyRe);
  const f = cleaned.match(fiveRe);
  if (w) {
    weeklyLeft = parseInt(w[1], 10);
    weeklyRaw = w[2].trim();
  }
  if (f) {
    fiveLeft = parseInt(f[1], 10);
    fiveRaw = f[2].trim();
  }
  if (weeklyLeft === null) {
    const m = cleaned.match(/weekly[^\d%]*(\d+)%\s*left/i);
    if (m) weeklyLeft = parseInt(m[1], 10);
  }
  if (fiveLeft === null) {
    const m = cleaned.match(/5h[^\d%]*(\d+)%\s*left/i);
    if (m) fiveLeft = parseInt(m[1], 10);
  }
  if (weeklyLeft === null) throw new Error("codex: weekly limit not found in TUI output");
  if (fiveLeft === null) throw new Error("codex: 5h limit not found in TUI output");
  if (!Number.isFinite(weeklyLeft) || weeklyLeft < 0 || weeklyLeft > 100) throw new Error("codex: bad weekly pct");
  if (!Number.isFinite(fiveLeft) || fiveLeft < 0 || fiveLeft > 100) throw new Error("codex: bad 5h pct");
  let weeklyIso: string | null = null;
  let fiveIso: string | null = null;
  let estimated = false;
  if (weeklyRaw) {
    weeklyIso = parseWeeklyReset(weeklyRaw, now);
    if (!weeklyIso) throw new Error(`codex: bad weekly reset "${weeklyRaw}"`);
  }
  if (fiveRaw) {
    fiveIso = parseFiveReset(fiveRaw, now);
    if (!fiveIso) throw new Error(`codex: bad 5h reset "${fiveRaw}"`);
  }
  if (!weeklyIso) {
    weeklyIso = new Date(now.getTime() + 7 * 86400000).toISOString();
    estimated = true;
  }
  if (!fiveIso) fiveIso = new Date(now.getTime() + 5 * 3600000).toISOString();
  const usedPct = 100 - weeklyLeft;
  const sessionPct = 100 - fiveLeft;
  // The /status panel carries "Account: <email> (<plan>)" above the limits.
  // Vendor casing preserved (grok/muse precedent); unknown when absent.
  let plan = "unknown";
  const account = cleaned.match(/Account:\s*\S+\s*\(([^)]+)\)/i);
  if (account && account[1].trim()) plan = account[1].trim();
  const periodStart = new Date(new Date(weeklyIso).getTime() - 7 * 86400000).toISOString();
  return {
    provider: "codex",
    plan,
    weeklyPct: usedPct,
    fiveHourPct: sessionPct,
    resetsAt: weeklyIso,
    periodStart,
    source: "tui",
    fetchedAt: now.toISOString(),
    resetsAtEstimated: estimated || undefined,
    raw: cleaned.slice(0, 4096),
  };
}

export const codexAdapter = {
  id: "codex",
  requiresAuth: "codex login (CLI owns credentials)",
  async poll(): Promise<ParsedQuota> {
    const transcript = await runPty({
      file: "codex",
      args: ["--no-alt-screen"],
      cwd: os.homedir(),
      cols: 140,
      rows: 50,
      settleDelayMs: 2000,
      // Two-phase submit: the slash-command autocomplete swallows a
      // same-burst Enter, so the command never runs.
      input: "/status",
      submitInput: "\r",
      submitAfterMs: 1500,
      // Complete on the /status panel only. The startup statusline footer
      // ("· 5h N% left · weekly N% left") carries no reset timestamps and
      // would otherwise win the race, forcing a drifting now+7d estimate.
      completionRegex:
        /Weekly limit:|Limits:\s*refresh requested|refresh token was already used|log out and sign in again/i,
      abortOn: /Do you trust|Trust.*folder|trust the files in this folder/i,
      timeoutMs: 12000,
      maxBytes: 256 * 1024,
      signal: adapterSignal("codex"),
      label: "codex",
    });
    return parseCodexTui(transcript);
  },
};
