import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse, isValid } from "date-fns";
import { fromZonedTime, formatInTimeZone } from "date-fns-tz";
import type { Quota } from "./types.js";
const exec = promisify(execFile);
const BRISBANE_TZ = "Australia/Brisbane";
const RESET_FORMATS = [
  "MMM d 'at' h:mma yyyy",
  "MMM d 'at' ha yyyy",
  "MMM d 'at' h:mm a yyyy",
  "MMM d 'at' h a yyyy",
];

function tryParseWithYear(raw: string, year: number): Date | null {
  const withYear = `${raw.trim()} ${year}`;
  const normalized = withYear.replace(/([ap]m)\b/gi, (m) => m.toUpperCase());
  for (const fmt of RESET_FORMATS) {
    const d = parse(normalized, fmt, new Date());
    if (isValid(d)) {
      return fromZonedTime(d, BRISBANE_TZ);
    }
  }
  return null;
}

function parseBrisbaneReset(resetsRaw: string, now: Date): string | null {
  const trimmed = resetsRaw.trim();
  if (!trimmed) return null;
  const yearStr = formatInTimeZone(now, BRISBANE_TZ, "yyyy");
  const year = parseInt(yearStr, 10);
  let utc = tryParseWithYear(trimmed, year);
  if (!utc) return null;
  if (utc.getTime() < now.getTime()) {
    const utcNext = tryParseWithYear(trimmed, year + 1);
    if (utcNext) {
      const diff = utcNext.getTime() - now.getTime();
      if (diff >= 0 && diff < 8 * 86400000) {
        utc = utcNext;
      } else {
        // stale / out-of-range (e.g. monthly-plan string) — fallback to now+7d
        return null;
      }
    } else {
      return null;
    }
    // if utc was past and no valid next-year within window, treat as stale
    if (utc.getTime() < now.getTime()) return null;
  }
  return formatInTimeZone(utc, BRISBANE_TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

export function parseClaudeUsage(result: string, now = new Date()): Quota {
  const sessionMatch = result.match(/Current session:\s+(\d+)% used[^·]*·\s*resets\s+([^\n(]+?)\s*\(/);
  const weeklyMatch = result.match(/Current week \(all models\):\s+(\d+)% used[^·]*·\s*resets\s+([^\n(]+?)\s*\(/);
  const usedPct = weeklyMatch ? parseInt(weeklyMatch[1],10) : 0;
  const sessionPct = sessionMatch ? parseInt(sessionMatch[1],10) : undefined;
  const resetsRaw = weeklyMatch?.[2].trim() ?? "";
  let resetsAt = parseBrisbaneReset(resetsRaw, now);
  if (!resetsAt) resetsAt = new Date(now.getTime()+7*86400000).toISOString();
  return {
    provider: "claude", plan: "max", usedPct, sessionPct,
    resetsAt, periodStart: new Date(now.getTime() - 7*86400000).toISOString(),
    raw: result, source: "cli", fetchedAt: now.toISOString()
  };
}
export const claudeAdapter = {
  id: "claude",
  requiresAuth: "keychain:Claude Code-credentials",
  async poll(): Promise<Quota> {
    const { stdout } = await exec("claude", ["-p","/usage","--output-format","json"], { timeout: 8000 });
    const parsed = JSON.parse(stdout);
    const result: string = parsed.result ?? stdout;
    return parseClaudeUsage(result);
  }
};
