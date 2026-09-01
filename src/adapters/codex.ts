import os from "node:os";
import { runPty, stripAnsi } from "./pty.js";
import type { Quota } from "./types.js";

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function parseWeeklyReset(raw: string, now: Date): string | null {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})\s+on\s+(\d{1,2})\s+([A-Za-z]{3,9})$/);
  if (!m) return null;
  const hours = parseInt(m[1], 10);
  const mins = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  const monStr = m[4].slice(0, 3).toLowerCase();
  const month = MONTHS[monStr];
  if (month === undefined || !Number.isFinite(hours) || !Number.isFinite(mins) || !Number.isFinite(day)) return null;
  if (hours < 0 || hours > 23 || mins < 0 || mins > 59 || day < 1 || day > 31) return null;
  let year = now.getFullYear();
  let dt = new Date(year, month, day, hours, mins, 0, 0);
  if (Number.isNaN(dt.getTime())) return null;
  if (dt.getTime() < now.getTime()) {
    dt = new Date(year + 1, month, day, hours, mins, 0, 0);
    if (Number.isNaN(dt.getTime())) return null;
  }
  if (dt.getTime() < now.getTime()) return null;
  return dt.toISOString();
}

function parseFiveReset(raw: string, now: Date): string | null {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hours = parseInt(m[1], 10);
  const mins = parseInt(m[2], 10);
  if (hours < 0 || hours > 23 || mins < 0 || mins > 59) return null;
  let dt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, mins, 0, 0);
  if (dt.getTime() < now.getTime()) {
    dt = new Date(dt.getTime() + 86400000);
  }
  return dt.toISOString();
}

export function parseCodexTui(text: string, now = new Date()): Quota {
  const cleaned = stripAnsi(text);
  let weeklyLeft: number | null = null;
  let fiveLeft: number | null = null;
  let weeklyRaw: string | null = null;
  let fiveRaw: string | null = null;
  const weeklyRe = /Weekly limit:\s*(\d+)%\s*left\s*\(resets\s+([^)]+)\)/i;
  const fiveRe = /5h limit:\s*(\d+)%\s*left\s*\(resets\s+([^)]+)\)/i;
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
  const periodStart = new Date(new Date(weeklyIso).getTime() - 7 * 86400000).toISOString();
  return {
    provider: "codex",
    plan: "unknown",
    usedPct,
    sessionPct,
    resetsAt: weeklyIso,
    periodStart,
    source: "tui",
    fetchedAt: now.toISOString(),
    resetsAtEstimated: estimated || undefined,
    raw: cleaned.slice(0, 4096),
  } as unknown as Quota;
}

export const codexAdapter = {
  id: "codex",
  requiresAuth: "codex login (CLI owns credentials)",
  async poll(): Promise<Quota> {
    const transcript = await runPty({
      file: "codex",
      args: ["--no-alt-screen"],
      cwd: os.homedir(),
      cols: 140,
      rows: 50,
      settleDelayMs: 2000,
      input: "/status\r",
      completionRegex: /\d+%\s*left/i,
      abortOn: /Do you trust|Trust.*folder|trust the files in this folder/i,
      timeoutMs: 12000,
      maxBytes: 256 * 1024,
    });
    return parseCodexTui(transcript);
  },
};
