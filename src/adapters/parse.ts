import { parse, isValid } from "date-fns";
import { fromZonedTime, formatInTimeZone } from "date-fns-tz";

// Shared reset-date parsing for adapter raw text. Claude and manual pastes
// both carry "resets Aug 29 at 11am" style strings; this resolves them to an
// ISO instant in Brisbane time with a same-format next-year rollover.

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

function parseAbsoluteReset(raw: string, now: Date): Date | null {
  const yearStr = formatInTimeZone(now, BRISBANE_TZ, "yyyy");
  const year = parseInt(yearStr, 10);
  let utc = tryParseWithYear(raw, year);
  if (!utc) return null;
  if (utc.getTime() < now.getTime()) {
    const utcNext = tryParseWithYear(raw, year + 1);
    if (utcNext) {
      const diff = utcNext.getTime() - now.getTime();
      if (diff >= 0 && diff < 8 * 86400000) {
        utc = utcNext;
      } else {
        return null;
      }
    } else {
      return null;
    }
    if (utc.getTime() < now.getTime()) return null;
  }
  return utc;
}

function parseRelativeDuration(raw: string, now: Date): Date | null {
  const m = raw.match(/^in\s+(.+)$/);
  if (!m) return null;
  const inner = m[1].trim();
  const d = inner.match(/(\d+)d/)?.[1];
  const h = inner.match(/(\d+)h/)?.[1];
  const min = inner.match(/(\d+)m/)?.[1];
  if (!d && !h && !min) return null;
  const ms = (parseInt(d ?? "0", 10) * 86400 + parseInt(h ?? "0", 10) * 3600 + parseInt(min ?? "0", 10) * 60) * 1000;
  return new Date(now.getTime() + ms);
}

export function parseResetText(text: string, now: Date): string | null {
  // Farthest future reset wins. Claude output lists the session reset before
  // the weekly one; kimi lists the weekly window before its 5h rolling one —
  // the period reset is always the farthest, so one rule serves both.
  const matches = [...text.matchAll(/resets\s+([^\n(]+?)\s*(?:\(|$)/gm)];
  let best: Date | null = null;
  for (const m of matches) {
    const raw = m[1].trim();
    if (!raw) continue;
    const candidates = [parseAbsoluteReset(raw, now), parseRelativeDuration(raw, now)];
    for (const c of candidates) {
      if (c && (!best || c.getTime() > best.getTime())) best = c;
    }
  }
  if (!best) return null;
  return formatInTimeZone(best, BRISBANE_TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
}