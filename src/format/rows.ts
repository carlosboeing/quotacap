// Shared row model: maps each ProviderSnapshot to the STATE words,
// countdowns, and forecast sentences every surface renders. Presentation-only
// math lives here (countdowns, elapsed, rail cells); freshness, ranking, and
// pace rules stay in src/advisory and are never recomputed.
import type { ProviderSnapshot } from "../advisory/types.js";

export type StateWord = "On track" | "Behind pace" | "Ahead of pace" | "Cap risk" | "Not reporting";
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

// Compact duration: 7d / 12h / 45m. Countdown convention floors; sub-minute
// spans read 1m so a live window never prints 0m.
export function fmtDuration(ms: number): string {
  if (ms >= 48 * HOUR_MS) return `${Math.floor(ms / DAY_MS)}d`;
  if (ms >= 90 * MIN_MS) return `${Math.floor(ms / HOUR_MS)}h`;
  return `${Math.max(1, Math.floor(ms / MIN_MS))}m`;
}

export function countdownText(ps: ProviderSnapshot, now: Date): string {
  const resetsMs = msOf(ps.quota?.resetsAt);
  let text: string;
  if (resetsMs === null) text = "—";
  else if (resetsMs <= now.getTime()) text = "passed";
  else text = fmtDuration(resetsMs - now.getTime());
  if (ps.quota?.resetsAtEstimated) text += " (est.)";
  return text;
}

export function elapsedPct(ps: ProviderSnapshot, now: Date): number | null {
  const startMs = msOf(ps.quota?.periodStart);
  const resetsMs = msOf(ps.quota?.resetsAt);
  if (startMs === null || resetsMs === null || resetsMs <= startMs) return null;
  const pct = ((now.getTime() - startMs) / (resetsMs - startMs)) * 100;
  return Math.round(Math.min(100, Math.max(0, pct)));
}

export function usedPctOf(ps: ProviderSnapshot): number | null {
  const u = ps.quota?.usedPct;
  return typeof u === "number" && Number.isFinite(u) ? Math.round(u) : null;
}

export function railCells(ps: ProviderSnapshot, now: Date): RailCell[] {
  const cells: RailCell[] = new Array<RailCell>(RAIL_CELLS).fill("unused");
  if (ps.exclusionReason !== null) return cells;
  const u = ps.quota?.usedPct;
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
// Not reporting; at-risk status beats urgency; urgency maps to pace words.
export function stateWord(ps: ProviderSnapshot): StateWord {
  if (ps.exclusionReason !== null) return "Not reporting";
  const adv = ps.advisory;
  if (!adv) return "Not reporting";
  if (adv.status === "at risk") return "Cap risk";
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
  if (adv.paceSource === "unknown" || adv.burnRate === null) {
    text = `Measuring pace; ${Math.round(adv.remaining)}% remains with ${adv.daysLeft.toFixed(1)}d until reset`;
  } else if (adv.wastePct !== null && adv.wastePct > 0) {
    text = `${Math.round(adv.wastePct)}% waste in ${adv.daysLeft.toFixed(1)}d`;
  } else {
    text = "Exhausts before reset";
  }
  // Engine estimate vocabulary, mirroring the snapshot reason transform.
  if (ps.quota?.resetsAtEstimated) {
    if (text.includes("waste in")) text = text.replace("waste in", "estimated waste in");
    else if (text.includes("until reset")) text = text.replace("until reset", "until estimated reset");
    else if (!text.includes("estimated")) text = `${text} (estimated)`;
  }
  return text;
}

// Compact legend: none = On track; ! = Cap risk; ~ = Behind/Ahead pace or
// estimated reset; ? = unknown pace or any excluded row.
export function compactSuffix(ps: ProviderSnapshot): CompactSuffix {
  if (ps.exclusionReason !== null) return "?";
  const adv = ps.advisory;
  if (!adv || adv.paceSource === "unknown") return "?";
  if (adv.status === "at risk") return "!";
  if (adv.urgency !== "on track" || ps.quota?.resetsAtEstimated) return "~";
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
  const u = p.quota?.usedPct;
  return typeof u === "number" && Number.isFinite(u) ? u : null;
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
        const ra = msOf(a.p.quota?.resetsAt);
        const rb = msOf(b.p.quota?.resetsAt);
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

export function buildRow(ps: ProviderSnapshot, now: Date): Row {
  return {
    id: ps.id,
    state: stateWord(ps),
    countdown: countdownText(ps, now),
    forecast: forecastText(ps, now),
    elapsedPct: elapsedPct(ps, now),
    usedPct: usedPctOf(ps),
    railCells: railCells(ps, now),
  };
}
