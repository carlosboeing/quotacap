// A full short window the user has to wait out. Presentation only:
// pace, forecast, and which provider to use next stay on the reset window.

export type RateLimitWindow = "five-hour" | "weekly";

export interface RateLimitWait {
  window: RateLimitWindow;
  label: "5h limit" | "Weekly limit";
  /** Reported finish instant. Null when the provider did not report one. */
  resetsAt: string | null;
  /** Local date and 24-hour time, e.g. "Thu Oct 23 18:59". */
  until: string | null;
  text: string;
}

export interface RateLimitSource {
  exclusionReason?: string | null;
  quota?: {
    weeklyPct?: number | null;
    resetsAt?: string | null;
    fiveHourPct?: number | null;
    /** One-release alias for fiveHourPct. */
    sessionPct?: number | null;
    fiveHourResetsAt?: string | null;
    monthlyPct?: number | null;
    monthlyResetsAt?: string | null;
    monthlyStatus?: "ok" | "exhausted" | null;
    monthlyKind?: "included" | null;
  } | null;
}

function part(when: Date, options: Intl.DateTimeFormatOptions, type: Intl.DateTimeFormatPartTypes): string {
  return new Intl.DateTimeFormat("en-US", options).formatToParts(when).find((p) => p.type === type)?.value ?? "";
}

/** Weekday, calendar date, and 24-hour clock in the locked English copy. */
export function limitStamp(iso: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const when = new Date(ms);
  const weekday = part(when, { weekday: "short" }, "weekday");
  const month = part(when, { month: "short" }, "month");
  const day = part(when, { day: "numeric" }, "day");
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(when);
  const hour = time.find((p) => p.type === "hour")?.value ?? "";
  const minute = time.find((p) => p.type === "minute")?.value ?? "";
  if (!weekday || !month || !day || !hour || !minute) return null;
  return `${weekday} ${month} ${day} ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

function instant(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** True when the window has not been reported as already finished. */
function stillOpen(iso: string | null | undefined, nowMs: number): boolean {
  const ms = instant(iso);
  return ms === null || ms > nowMs;
}

function includedMonth(q: NonNullable<RateLimitSource["quota"]>): boolean {
  return q.monthlyKind === "included" && typeof q.monthlyPct === "number" && !!q.monthlyResetsAt;
}

function monthExhausted(q: NonNullable<RateLimitSource["quota"]>): boolean {
  return q.monthlyStatus === "exhausted" || (typeof q.monthlyPct === "number" && q.monthlyPct >= 100);
}

function waitFor(
  window: RateLimitWindow,
  label: RateLimitWait["label"],
  iso: string | null | undefined,
): RateLimitWait {
  const resetsAt = instant(iso) === null ? null : iso ?? null;
  const until = resetsAt ? limitStamp(resetsAt) : null;
  return {
    window,
    label,
    resetsAt,
    until,
    text: until ? `${label} until ${until}` : `${label} reached`,
  };
}

/**
 * Short windows that are full while the reset-window quota still has room.
 * A 5h window on any plan, and the week on a plan whose quota resets monthly.
 * A full week on a weekly plan is the quota itself, so it stays with the
 * quota badge. An exhausted included month already blocks the provider.
 */
export function rateLimitWaits(source: RateLimitSource, now: Date): RateLimitWait[] {
  if (source.exclusionReason) return [];
  const q = source.quota;
  if (!q) return [];
  const nowMs = now.getTime();
  const monthly = includedMonth(q);
  if (monthly && monthExhausted(q)) return [];
  const weekFull = typeof q.weeklyPct === "number" && q.weeklyPct >= 100;
  if (!monthly && weekFull) return [];

  const waits: RateLimitWait[] = [];
  const five = q.fiveHourPct ?? q.sessionPct;
  if (typeof five === "number" && five >= 100 && stillOpen(q.fiveHourResetsAt, nowMs)) {
    waits.push(waitFor("five-hour", "5h limit", q.fiveHourResetsAt));
  }
  if (monthly && weekFull && stillOpen(q.resetsAt, nowMs)) {
    waits.push(waitFor("weekly", "Weekly limit", q.resetsAt));
  }
  waits.sort((a, b) => {
    const am = instant(a.resetsAt);
    const bm = instant(b.resetsAt);
    if (am === null && bm === null) return 0;
    if (am === null) return 1;
    if (bm === null) return -1;
    return am - bm;
  });
  return waits;
}

/** One sentence per provider that has a short window to wait out. Snapshot order. */
export function rateLimitWaitLines(
  providers: Array<RateLimitSource & { displayName: string }>,
  now: Date,
): string[] {
  const lines: string[] = [];
  for (const provider of providers) {
    const waits = rateLimitWaits(provider, now);
    if (waits.length === 0) continue;
    lines.push(`${provider.displayName}: ${waits.map((w) => w.text).join(" · ")}`);
  }
  return lines;
}
