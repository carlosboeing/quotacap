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

export function parseResetText(text: string, now: Date): string | null {
  // Last "resets" match wins: claude output lists the session reset first and
  // the weekly (period) reset last; manual pastes carry a single line.
  const matches = [...text.matchAll(/resets\s+([^\n(]+?)\s*(?:\(|$)/gm)];
  if (!matches.length) return null;
  const trimmed = matches[matches.length - 1][1].trim();
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
        return null;
      }
    } else {
      return null;
    }
    if (utc.getTime() < now.getTime()) return null;
  }
  return formatInTimeZone(utc, BRISBANE_TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
}