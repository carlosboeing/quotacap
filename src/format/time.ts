// One duration and one clock vocabulary for every human surface: the
// dashboard imports these, the CLI rows and the engine reason use them, so
// one instant never reads "5d 23h" in one place and "6d 0h" or "6.0d" in
// another. Pinned to en-US with a 24-hour clock: the sentences they feed
// are English, so a non-English machine must not print localized parts.

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const MIN_MS = 60000;

/**
 * Floored duration: "6d 23h" from one day up, "5h 12m" from one hour up,
 * else "45m". Sub-minute spans read "1m" so a live window never prints 0m.
 */
export function durationText(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const totalMinutes = Math.floor(ms / MIN_MS);
  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
  if (days >= 1) return `${days}d ${hours}h`;
  if (hours >= 1) return `${hours}h ${totalMinutes % 60}m`;
  return `${Math.max(1, totalMinutes)}m`;
}

/** Duration from fractional days, for engine fields such as daysLeft. */
export function durationFromDays(days: number): string {
  return durationText(days * DAY_MS);
}

function weekday(when: Date): string {
  return when.toLocaleDateString("en-US", { weekday: "short" });
}

function clock24(when: Date): string {
  return when.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

/**
 * Wall-clock instant: "Sat 14:46" within 7 days of `nowMs`, where the
 * weekday is unambiguous, else "Sun 22 Nov 23:05". Without `nowMs` the
 * dated form is used. Null when unparseable.
 */
export function clockText(iso: string | null | undefined, nowMs?: number): string | null {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return null;
  const when = new Date(ms);
  if (nowMs !== undefined && Number.isFinite(nowMs) && Math.abs(ms - nowMs) < 7 * DAY_MS) {
    return `${weekday(when)} ${clock24(when)}`;
  }
  return `${weekday(when)} ${dateText(iso)} ${clock24(when)}`;
}

/** Calendar date without the weekday or clock, e.g. "22 Nov". Empty when unparseable. */
export function dateText(iso: string | null | undefined): string {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return "";
  const when = new Date(ms);
  return `${when.getDate()} ${when.toLocaleDateString("en-US", { month: "short" })}`;
}

/** Weekday plus calendar date, e.g. "Sun 22 Nov". */
export function dayText(iso: string | null | undefined): string {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return "Invalid Date";
  return `${weekday(new Date(ms))} ${dateText(iso)}`;
}

/** The one waste sentence: "16% unused at reset (Fri 13:14)". */
export function unusedAtReset(wastePct: number, resetsAt: string | null | undefined, nowMs?: number): string {
  const clock = clockText(resetsAt, nowMs);
  return `${Math.round(wastePct)}% unused at reset${clock ? ` (${clock})` : ""}`;
}
