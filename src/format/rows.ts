// Shared row model: maps each ProviderSnapshot to the STATE words,
// countdowns, and forecast sentences every surface renders. Presentation-only
// math lives here (countdowns, elapsed, rail cells); freshness, ranking, and
// pace rules stay in src/advisory and are never recomputed.
import type { ProviderSnapshot } from "../advisory/types.js";
import { rateLimitWaits } from "./rate-limit-wait.js";

export type StateWord = "On track" | "Behind pace" | "Ahead of pace" | "Cap risk" | "Watch" | "Measuring" | "Not reporting" | "Monthly exhausted" | "Quota exhausted";
export type RailCell = "used" | "tick" | "unused";
export type SortKey = "recommended" | "reset-asc" | "reset-desc" | "used-desc" | "used-asc";
export type CompactSuffix = "" | "!" | "~" | "?";

export interface Row {
  id: string;
  state: StateWord;
  countdown: string;
  forecast: string;
  elapsedPct: number | null;
  usedPct: number | null;
  railCells: RailCell[];
  /** Compact pace pair without units, e.g. "10.6 avg · 0.0 24h". Surfaces label %/day once. */
  pace: string;
  /**
   * Full short window the user has to wait out, with the date and time it
   * clears. Empty when the reset-window quota is the block, or no short
   * window is full. Never changes `state` or `forecast`.
   */
  wait: string;
}

export const RAIL_CELLS = 20;
export const SORT_KEYS: SortKey[] = ["recommended", "reset-asc", "reset-desc", "used-desc", "used-asc"];

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const MIN_MS = 60000;

function msOf(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Quota-window resolution, mirroring the dashboard helpers: the advisory
 * binding window rations the account, so standalone resets, usage,
 * elapsed, and pace read it. Weekly-bound rows fall back to the weekly
 * fields unchanged; rate-limit windows never drive these figures.
 */
export function isMonthlyBound(ps: ProviderSnapshot): boolean {
  return (
    ps.advisory?.bindingWindow === "monthly" &&
    ps.quota?.monthlyKind === "included" &&
    typeof ps.quota?.monthlyPct === "number" &&
    !!ps.quota?.monthlyResetsAt
  );
}

/** Reset instant of the quota window, or null without a quota reading. */
export function bindingResetsAt(ps: ProviderSnapshot): string | null {
  if (!ps.quota) return null;
  if (isMonthlyBound(ps)) return ps.quota.monthlyResetsAt ?? null;
  return ps.quota.resetsAt ?? null;
}

/** Used percent of the quota window. Null without a quota reading. */
export function bindingUsedPct(ps: ProviderSnapshot): number | null {
  if (!ps.quota) return null;
  if (isMonthlyBound(ps)) {
    const m = ps.quota.monthlyPct;
    return typeof m === "number" && Number.isFinite(m) ? Math.round(m) : null;
  }
  const u = weeklyPctOf(ps.quota);
  return typeof u === "number" && Number.isFinite(u) ? Math.round(u) : null;
}

/** Start of the monthly window: one calendar month before its reported reset. */
function monthlyStartMs(resetMs: number): number {
  const start = new Date(resetMs);
  start.setMonth(start.getMonth() - 1);
  return start.getTime();
}

/**
 * Binding leftover for a raw quota without an advisory (model catalogs):
 * the same scarcer-headroom rule the engine applies, so the catalog
 * leftover and reset name the quota window, not always the week.
 */
export function bindingLeftover(
  quota: {
    weeklyPct?: number;
    resetsAt?: string;
    monthlyKind?: string;
    monthlyPct?: number;
    monthlyResetsAt?: string;
    monthlyStatus?: string;
  } | null | undefined,
  now: Date,
): { leftoverPct: number | null; resetsAt: string | null } {
  if (!quota || typeof quota.weeklyPct !== "number") {
    return { leftoverPct: null, resetsAt: quota?.resetsAt ?? null };
  }
  const weeklyRemaining = 100 - quota.weeklyPct;
  const weeklyDays = Math.max(0.1, (new Date(quota.resetsAt ?? "").getTime() - now.getTime()) / DAY_MS);
  if (
    quota.monthlyKind === "included" &&
    typeof quota.monthlyPct === "number" &&
    quota.monthlyResetsAt
  ) {
    const monthlyRemaining =
      quota.monthlyStatus === "exhausted" ? 0 : Math.max(0, 100 - quota.monthlyPct);
    const monthlyDays = Math.max(
      0.1,
      (new Date(quota.monthlyResetsAt).getTime() - now.getTime()) / DAY_MS,
    );
    if (monthlyRemaining / monthlyDays < weeklyRemaining / weeklyDays || monthlyRemaining === 0) {
      return {
        leftoverPct: Math.round(monthlyRemaining * 10) / 10,
        resetsAt: quota.monthlyResetsAt,
      };
    }
  }
  return {
    leftoverPct: Math.round(weeklyRemaining * 10) / 10,
    resetsAt: quota.resetsAt ?? null,
  };
}

/** Window-average pace of the quota window; monthly divides monthly used by elapsed monthly days. */
export function bindingAvgPace(ps: ProviderSnapshot, now: Date): number | null {
  if (!isMonthlyBound(ps)) return ps.advisory?.avgPace ?? null;
  const used = ps.quota?.monthlyPct;
  const resetMs = msOf(ps.quota?.monthlyResetsAt);
  if (typeof used !== "number" || !Number.isFinite(used) || resetMs === null) return null;
  const elapsedDays = (now.getTime() - monthlyStartMs(resetMs)) / DAY_MS;
  if (elapsedDays < 0.25) return null;
  const pace = used / elapsedDays;
  return Number.isFinite(pace) ? Math.max(0, pace) : null;
}

// The CLI talks HTTP to a daemon that may predate the rename, which sent only
// `usedPct`. Read both for one release; drop the fallback with the aliases.
export function weeklyPctOf(q: { weeklyPct?: number; usedPct?: number } | null | undefined): number | undefined {
  return q?.weeklyPct ?? q?.usedPct;
}

// Compact duration: 7d / 12h / 45m. Countdown convention floors; sub-minute
// spans read 1m so a live window never prints 0m.
export function fmtDuration(ms: number): string {
  if (ms >= 48 * HOUR_MS) return `${Math.floor(ms / DAY_MS)}d`;
  if (ms >= 90 * MIN_MS) return `${Math.floor(ms / HOUR_MS)}h`;
  return `${Math.max(1, Math.floor(ms / MIN_MS))}m`;
}

// Short weekday plus calendar date of an ISO instant in the locked English
// copy, e.g. "Tue Sep 15". Pinned to en-US: the sentence it feeds
// ("unused until Tue Sep 15") is English, so a non-English machine must not
// print localized parts inside it. A bare weekday scans as this coming week,
// which misreads a monthly reset sitting weeks out.
export function dayOf(iso: string | undefined): string {
  const when = new Date(iso ?? "");
  return `${when.toLocaleDateString("en-US", { weekday: "short" })} ${when.toLocaleDateString("en-US", { day: "numeric", month: "short" })}`;
}

export function countdownText(ps: ProviderSnapshot, now: Date): string {
  const resetsMs = msOf(bindingResetsAt(ps));
  let text: string;
  if (resetsMs === null) text = "—";
  else if (resetsMs <= now.getTime()) text = "passed";
  else text = fmtDuration(resetsMs - now.getTime());
  if (!isMonthlyBound(ps) && ps.quota?.resetsAtEstimated) text += " (est.)";
  return text;
}

export function elapsedPct(ps: ProviderSnapshot, now: Date): number | null {
  const resetsMs = msOf(bindingResetsAt(ps));
  const startMs = isMonthlyBound(ps)
    ? resetsMs === null
      ? null
      : monthlyStartMs(resetsMs)
    : msOf(ps.quota?.periodStart);
  if (startMs === null || resetsMs === null || resetsMs <= startMs) return null;
  const pct = ((now.getTime() - startMs) / (resetsMs - startMs)) * 100;
  return Math.round(Math.min(100, Math.max(0, pct)));
}

export function usedPctOf(ps: ProviderSnapshot): number | null {
  return bindingUsedPct(ps);
}

export function railCells(ps: ProviderSnapshot, now: Date): RailCell[] {
  const cells: RailCell[] = new Array<RailCell>(RAIL_CELLS).fill("unused");
  const u = bindingUsedPct(ps);
  const is100Exhausted = typeof u === "number" && u >= 100 && !ps.resetPassed;
  if (ps.exclusionReason !== null && !is100Exhausted) return cells;
  const used =
    typeof u === "number" && Number.isFinite(u)
      ? Math.min(RAIL_CELLS, Math.max(0, Math.round((u / 100) * RAIL_CELLS)))
      : 0;
  for (let i = 0; i < used; i++) cells[i] = "used";
  const elapsed = elapsedPct(ps, now);
  if (elapsed !== null) {
    const tick = Math.min(RAIL_CELLS - 1, Math.max(0, Math.round((elapsed / 100) * (RAIL_CELLS - 1))));
    cells[tick] = "tick";
  }
  return cells;
}

// Shared STATE vocabulary (locked badge mapping): any exclusion reads
// Not reporting; at-risk status beats urgency, then watch, then unknown;
// on-track rows ahead of cumulative elapsed time revive Ahead of pace,
// except a finish inside the horizon tube, which stays On track;
// urgency maps to the remaining pace words.
export function stateWord(ps: ProviderSnapshot): StateWord {
  if (ps.exclusionReason !== null) return "Not reporting";
  const adv = ps.advisory;
  if (!adv) return "Not reporting";
  // A blocked month outranks every weekly verdict: weekly leftover cannot be
  // spent until the month resets.
  if (adv.bindingWindow === "monthly" && adv.bindingRemaining === 0) return "Monthly exhausted";
  const u = bindingUsedPct(ps);
  const isExhausted =
    (typeof adv.bindingRemaining === "number" && adv.bindingRemaining <= 0) ||
    (typeof adv.remaining === "number" && adv.remaining <= 0) ||
    (typeof u === "number" && u >= 100);
  if (isExhausted) return "Quota exhausted";
  if (adv.status === "at risk") return "Cap risk";
  if (adv.status === "watch") return "Watch";
  if (adv.status === "unknown") return "Measuring";
  if (adv.status === "on track" && adv.closeToReset === true) return "On track";
  if (adv.aheadOfElapsed === true) return "Ahead of pace";
  switch (adv.urgency) {
    case "burn now":
    case "use soon":
    case "save":
      return "Behind pace";
    case "slow down":
      return "Ahead of pace";
    default:
      return "On track";
  }
}

function staleAgeMs(ps: ProviderSnapshot, now: Date): number | null {
  if (ps.ageMs !== null) return ps.ageMs;
  const fetchedMs = msOf(ps.quota?.fetchedAt);
  if (fetchedMs === null) return null;
  return Math.max(0, now.getTime() - fetchedMs);
}

// Engine sentences for reporting rows, specific exclusion notes otherwise.
// Unknown pace never prints a numeric rate or predicted-waste phrasing.
export function forecastText(ps: ProviderSnapshot, now: Date): string {
  switch (ps.exclusionReason) {
    case "not-reporting":
      return "no readings yet";
    case "invalid":
      return "invalid reading";
    case "reset-passed":
      return "reset passed — awaiting fresh window";
    case "provider-failed": {
      if (ps.lastAttempt?.summary) return ps.lastAttempt.summary;
      const category = ps.lastAttempt?.failureCategory;
      return category ? `provider failed (${category})` : "provider failed";
    }
    case "stale": {
      const age = staleAgeMs(ps, now);
      return age === null ? "stale" : `stale ${fmtDuration(age)} ago`;
    }
    case null:
      break;
  }
  const adv = ps.advisory;
  if (!adv) return "no readings yet";
  let text: string;
  if (adv.bindingWindow === "monthly" && adv.bindingRemaining <= 0) {
    text = `unused until ${dayOf(ps.quota?.monthlyResetsAt)}`;
  } else if (adv.bindingWindow === "monthly") {
    text = `${Math.round(adv.bindingRemaining)}% of month left`;
  } else if (adv.remaining <= 0) {
    text = "Exhausted";
  } else if (adv.paceSource === "unknown" || adv.burnRate === null) {
    text = `Measuring pace; ${Math.round(adv.remaining)}% remains with ${adv.daysLeft.toFixed(1)}d until reset`;
  } else if (adv.status === "watch") {
    text =
      adv.daysToExhaust !== null && Number.isFinite(adv.daysToExhaust)
        ? `Exhausts in ${adv.daysToExhaust.toFixed(1)}d — watch`
        : "Near the cap — watch";
  } else if (adv.wastePct !== null && adv.wastePct > 0) {
    text = `${Math.round(adv.wastePct)}% waste in ${adv.daysLeft.toFixed(1)}d`;
  } else {
    text = "Exhausts before reset";
  }
  // Engine estimate vocabulary, mirroring the snapshot reason transform.
  // A monthly quota forecast never carries the weekly estimate flag.
  if (!isMonthlyBound(ps) && ps.quota?.resetsAtEstimated) {
    if (text.includes("waste in")) text = text.replace("waste in", "estimated waste in");
    else if (text.includes("until reset")) text = text.replace("until reset", "until estimated reset");
    else if (!text.includes("estimated")) text = `${text} (estimated)`;
  }
  return text;
}

// Compact legend: none = On track; ! = Cap risk; ~ = Watch or Behind/Ahead
// pace or estimated reset; ? = unknown pace or any excluded row.
export function compactSuffix(ps: ProviderSnapshot): CompactSuffix {
  if (ps.exclusionReason !== null) return "?";
  const adv = ps.advisory;
  if (!adv || adv.paceSource === "unknown") return "?";
  if (adv.status === "at risk") return "!";
  if (adv.status === "watch") return "~";
  if (adv.urgency !== "on track" || (!isMonthlyBound(ps) && ps.quota?.resetsAtEstimated)) return "~";
  return "";
}

export function assertValidSortKey(key: string): asserts key is SortKey {
  if (!(SORT_KEYS as string[]).includes(key)) {
    throw new Error(`invalid-argument: unknown sort key "${key}" (expected ${SORT_KEYS.join("|")})`);
  }
}

function wasteOf(p: ProviderSnapshot): number | null {
  const w = p.advisory?.wastePct;
  return typeof w === "number" && Number.isFinite(w) ? w : null;
}

function finiteUsed(p: ProviderSnapshot): number | null {
  return bindingUsedPct(p);
}

export function sortProviders(
  providers: ProviderSnapshot[],
  key: string,
  use: string,
): ProviderSnapshot[] {
  assertValidSortKey(key);
  const indexed = providers.map((p, i) => ({ p, i }));
  switch (key) {
    case "recommended": {
      const score = (p: ProviderSnapshot): number => {
        if (p.id === use && use !== "none") return 0;
        if (p.exclusionReason !== null) return 2;
        if (p.advisory?.bindingWindow === "monthly" && p.advisory.bindingRemaining === 0) return 2;
        return 1;
      };
      indexed.sort((a, b) => {
        const sa = score(a.p);
        const sb = score(b.p);
        if (sa !== sb) return sa - sb;
        if (sa === 1) {
          const wa = wasteOf(a.p);
          const wb = wasteOf(b.p);
          if (wa !== null && wb !== null && wa !== wb) return wb - wa;
          if (wa === null !== (wb === null)) return wa === null ? 1 : -1;
        }
        return a.i - b.i;
      });
      return indexed.map((e) => e.p);
    }
    case "reset-asc":
    case "reset-desc": {
      const dir = key === "reset-asc" ? 1 : -1;
      indexed.sort((a, b) => {
        const ra = msOf(bindingResetsAt(a.p));
        const rb = msOf(bindingResetsAt(b.p));
        if (ra === null && rb === null) return a.i - b.i;
        if (ra === null) return 1;
        if (rb === null) return -1;
        if (ra !== rb) return (ra - rb) * dir;
        return a.i - b.i;
      });
      return indexed.map((e) => e.p);
    }
    case "used-desc":
    case "used-asc": {
      const dir = key === "used-desc" ? -1 : 1;
      indexed.sort((a, b) => {
        const va = finiteUsed(a.p);
        const vb = finiteUsed(b.p);
        if (va === null && vb === null) return a.i - b.i;
        if (va === null) return 1;
        if (vb === null) return -1;
        if (va !== vb) return (va - vb) * dir;
        return a.i - b.i;
      });
      return indexed.map((e) => e.p);
    }
  }
}

// Compact pace pair: quota-window average first, 24h rate alongside. A pair
// that renders identically at display precision collapses to one figure.
// The 24h rate is weekly-only: a monthly-bound row shows its monthly
// average alone.
export function paceText(ps: ProviderSnapshot, now: Date = new Date()): string {
  const adv = ps.advisory;
  if (!adv) return "—";
  const avg = bindingAvgPace(ps, now);
  // The 24h figure is the measured recentRate, never the blended forecast
  // input; an older daemon omits the field and burnRate was the raw rate then.
  const recent = isMonthlyBound(ps)
    ? null
    : adv.recentRate !== undefined
      ? adv.recentRate
      : adv.paceSource === "recent"
        ? adv.burnRate
        : null;
  if (avg !== null && recent !== null && avg.toFixed(1) !== recent.toFixed(1)) {
    return `${avg.toFixed(1)} avg · ${recent.toFixed(1)} 24h`;
  }
  if (avg !== null) return `${avg.toFixed(1)} avg`;
  if (recent !== null) return `${recent.toFixed(1)} 24h`;
  return "—";
}

export function buildRow(ps: ProviderSnapshot, now: Date): Row {
  return {
    id: ps.id,
    state: stateWord(ps),
    countdown: countdownText(ps, now),
    forecast: forecastText(ps, now),
    elapsedPct: elapsedPct(ps, now),
    usedPct: usedPctOf(ps),
    railCells: railCells(ps, now),
    pace: paceText(ps, now),
    wait: rateLimitWaits(ps, now).map((w) => w.text).join(" · "),
  };
}
