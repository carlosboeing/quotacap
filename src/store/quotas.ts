import { MIN_PACE_SPAN_DAYS } from "../advisory/types.js";

function mapRow(row:any){
  if(!row) return row;
  const weeklyPct = row.used_pct ?? row.weeklyPct ?? row.usedPct;
  const fiveHourPct = row.session_pct ?? row.fiveHourPct ?? row.sessionPct ?? undefined;
  const out:any = {
    ...row,
    weeklyPct,
    usedPct: weeklyPct,
    resetsAt: row.resets_at ?? row.resetsAt,
    periodStart: row.period_start ?? row.periodStart,
    fetchedAt: row.fetched_at ?? row.fetchedAt,
    creditsUsd: row.credits_usd ?? row.creditsUsd,
    resetsAtEstimated: !!(row.resets_at_estimated ?? row.resetsAtEstimated),
    fiveHourPct,
    sessionPct: fiveHourPct,
  };
  delete out.used_pct;
  delete out.resets_at;
  delete out.period_start;
  delete out.fetched_at;
  delete out.credits_usd;
  delete out.resets_at_estimated;
  delete out.session_pct;
  delete out.raw;
  if (!out.resetsAtEstimated) delete out.resetsAtEstimated;
  if (out.fiveHourPct == null) {
    delete out.fiveHourPct;
    delete out.sessionPct;
  }
  out.fiveHourResetsAt = row.five_hour_resets_at ?? row.fiveHourResetsAt ?? undefined;
  delete out.five_hour_resets_at;
  if (out.fiveHourResetsAt == null) delete out.fiveHourResetsAt;
  // A junk monthly percent means no usable monthly reading. It never
  // invalidates the provider; only a bad weekly percent does (snapshot.ts).
  const m = row.monthly_pct;
  const monthlyValid = typeof m === "number" && Number.isFinite(m) && m >= 0 && m <= 100;
  out.monthlyPct = monthlyValid ? m : undefined;
  out.monthlyResetsAt = row.monthly_resets_at ?? undefined;
  out.monthlyStatus = row.monthly_status ?? undefined;
  out.monthlyKind = row.monthly_kind ?? undefined;
  delete out.monthly_pct;
  delete out.monthly_resets_at;
  delete out.monthly_status;
  delete out.monthly_kind;
  for (const k of ["monthlyPct", "monthlyResetsAt", "monthlyStatus", "monthlyKind"]) {
    if (!monthlyValid || out[k] == null) delete out[k];
  }
  return out;
}

type CycleBreakReason = "usage-drop" | "resets-at-rolled" | "both";

function cycleBreakReason(
  prev: { usedPct: number; t: number; resetsAt: string | null },
  cur: { usedPct: number; t: number; resetsAt: string | null },
): CycleBreakReason | null {
  const dropped = cur.usedPct < prev.usedPct;
  const prevResets = prev.resetsAt ? new Date(prev.resetsAt).getTime() : NaN;
  const boundaryRolled =
    !Number.isNaN(prevResets) && prevResets <= cur.t && prev.resetsAt !== cur.resetsAt;
  if (dropped && boundaryRolled) return "both";
  if (dropped) return "usage-drop";
  if (boundaryRolled) return "resets-at-rolled";
  return null;
}

export function isWeeklyCycleBreak(
  prev: { usedPct: number; t: number; resetsAt: string | null },
  cur: { usedPct: number; t: number; resetsAt: string | null },
): boolean {
  return cycleBreakReason(prev, cur) !== null;
}

export function upsertQuota(db:any, q:any){
  if (Array.isArray(q)) {
    for (const item of q) upsertQuota(db, item);
    return;
  }
  const credits = q.creditsUsd ?? q.credits_usd ?? null;
  const estimated = q.resetsAtEstimated ? 1 : null;
  // Either spelling binds; an explicit null stays null (SQLite binds it),
  // while a missing field stays undefined and fails the bind as before.
  const weeklyPct = q.weeklyPct !== undefined ? q.weeklyPct : q.usedPct;
  const fiveHourPct = q.fiveHourPct ?? q.sessionPct ?? q.session_pct ?? null;
  db.exec("BEGIN");
  try {
    const prev = getLatestByProvider(db, q.provider);
    if (prev) {
      const reason = cycleBreakReason(
        { usedPct: prev.weeklyPct, t: Date.parse(prev.fetchedAt), resetsAt: prev.resetsAt ?? null },
        { usedPct: weeklyPct, t: Date.parse(q.fetchedAt), resetsAt: q.resetsAt ?? null },
      );
      if (reason) {
        db.prepare(`INSERT OR IGNORE INTO window_closes(provider, plan, used_pct, leftover_pct, sampled_at, sampled_quota_id, period_start, resets_at, resets_at_estimated, detected_at, reason) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
          .run(prev.provider, prev.plan ?? null, prev.weeklyPct, Math.max(0, 100 - prev.weeklyPct), prev.fetchedAt, prev.id, prev.periodStart ?? null, prev.resetsAt ?? null, prev.resetsAtEstimated ? 1 : null, q.fetchedAt, reason);
      }
    }
    db.prepare(`INSERT INTO quotas(provider, plan, used_pct, resets_at, period_start, source, fetched_at, credits_usd, resets_at_estimated, session_pct, monthly_pct, monthly_resets_at, monthly_status, monthly_kind, five_hour_resets_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(q.provider, q.plan, weeklyPct, q.resetsAt, q.periodStart, q.source, q.fetchedAt, credits, estimated, fiveHourPct, q.monthlyPct ?? null, q.monthlyResetsAt ?? null, q.monthlyStatus ?? null, q.monthlyKind ?? null, q.fiveHourResetsAt ?? null);
    const day = new Date().toISOString().slice(0,10);
    db.prepare(`INSERT INTO snapshots(day, provider, used_pct) VALUES(?,?,?) ON CONFLICT(day, provider) DO UPDATE SET used_pct=excluded.used_pct`).run(day, q.provider, weeklyPct);
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

function monthlyPeriodStart(resetIso: string | null | undefined): string | null {
  if (!resetIso) return null;
  const resetMs = Date.parse(resetIso);
  if (!Number.isFinite(resetMs)) return null;
  const start = new Date(resetMs);
  start.setMonth(start.getMonth() - 1);
  return start.toISOString();
}

export function getWindowCloses(
  db: any,
  provider: string,
  limit = 4,
  window: "weekly" | "monthly" = "weekly",
): Array<{
  provider: string;
  plan: string | null;
  usedPct: number;
  leftoverPct: number;
  sampledAt: string;
  periodStart: string | null;
  resetsAt: string | null;
  resetsAtEstimated: boolean;
  detectedAt: string;
  reason: "usage-drop" | "resets-at-rolled" | "both";
}> {
  if (window === "monthly") {
    let qRows: any[] = [];
    try {
      qRows = db
        .prepare(
          `SELECT id, provider, plan, monthly_pct, monthly_resets_at, monthly_kind, fetched_at FROM quotas WHERE provider=? ORDER BY fetched_at ASC, id ASC`,
        )
        .all(provider) as any[];
    } catch (e: any) {
      if (!/no such table|no such column/i.test(String(e?.message ?? ""))) throw e;
    }
    const valid = qRows.filter(
      (r) =>
        r.monthly_kind === "included" &&
        typeof r.monthly_pct === "number" &&
        Number.isFinite(r.monthly_pct) &&
        r.monthly_pct >= 0 &&
        r.monthly_pct <= 100 &&
        typeof r.monthly_resets_at === "string" &&
        Number.isFinite(Date.parse(r.monthly_resets_at)) &&
        Number.isFinite(Date.parse(r.fetched_at)),
    );
    const closes: Array<{
      provider: string;
      plan: string | null;
      usedPct: number;
      leftoverPct: number;
      sampledAt: string;
      periodStart: string | null;
      resetsAt: string | null;
      resetsAtEstimated: boolean;
      detectedAt: string;
      reason: CycleBreakReason;
    }> = [];
    for (let i = 1; i < valid.length; i++) {
      const prev = valid[i - 1];
      const cur = valid[i];
      const reason = cycleBreakReason(
        {
          usedPct: prev.monthly_pct,
          t: Date.parse(prev.fetched_at),
          resetsAt: prev.monthly_resets_at ?? null,
        },
        {
          usedPct: cur.monthly_pct,
          t: Date.parse(cur.fetched_at),
          resetsAt: cur.monthly_resets_at ?? null,
        },
      );
      if (reason) {
        closes.push({
          provider: prev.provider,
          plan: prev.plan ?? null,
          usedPct: prev.monthly_pct,
          leftoverPct: Math.max(0, 100 - prev.monthly_pct),
          sampledAt: prev.fetched_at,
          periodStart: monthlyPeriodStart(prev.monthly_resets_at),
          resetsAt: prev.monthly_resets_at ?? null,
          resetsAtEstimated: false,
          detectedAt: cur.fetched_at,
          reason,
        });
      }
    }
    return closes.reverse().slice(0, limit);
  }
  let rows: any[] = [];
  try {
    rows = db.prepare(`SELECT provider, plan, used_pct, leftover_pct, sampled_at, period_start, resets_at, resets_at_estimated, detected_at, reason FROM window_closes WHERE provider=? ORDER BY detected_at DESC, id DESC LIMIT ?`).all(provider, limit) as any[];
  } catch (e: any) {
    // A pre-observability database read offline is never migrated, so the
    // table can be absent. No table means no recorded closes.
    if (!/no such table/i.test(String(e?.message ?? ""))) throw e;
  }
  return rows.map((r) => ({
    provider: r.provider,
    plan: r.plan ?? null,
    usedPct: r.used_pct,
    leftoverPct: r.leftover_pct,
    sampledAt: r.sampled_at,
    periodStart: r.period_start ?? null,
    resetsAt: r.resets_at ?? null,
    resetsAtEstimated: !!r.resets_at_estimated,
    detectedAt: r.detected_at,
    reason: r.reason,
  }));
}
export function getLatestByProvider(db:any, provider:string){
  const row = db.prepare(`SELECT * FROM quotas WHERE provider=? ORDER BY fetched_at DESC LIMIT 1`).get(provider);
  return mapRow(row);
}
export function getAllLatest(db:any){
  const rows = db.prepare(`SELECT * FROM quotas WHERE id IN (SELECT MAX(id) FROM quotas GROUP BY provider)`).all();
  return rows.map(mapRow);
}
// alias for plan's getQuotas naming
export const getQuotas = getAllLatest;
export function getSnapshots(db:any){ return db.prepare(`SELECT * FROM snapshots ORDER BY day DESC`).all(); }
interface BurnPoint { usedPct: number; t: number; resetsAt: string | null }

// Readings since the last reset. A reset happened between two consecutive
// readings when usage fell, or when the earlier reading's own resetsAt had both
// passed by the later fetch and moved to a new boundary. Comparing stored
// periodStart values cannot do this job: providers that estimate the reset
// (grok with no "Resets:" line, claude with an unparsed reset) derive
// periodStart from the poll time, so it moves on every poll and exact equality
// would discard every earlier reading in the same cycle.
function currentCycle<T extends BurnPoint>(sorted: T[]): T[] {
  let start = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (isWeeklyCycleBreak(sorted[i - 1], sorted[i])) start = i;
  }
  return start === 0 ? sorted : sorted.slice(start);
}

export function getBurnRates(db:any, now = Date.now()): Map<string, number> {
  // Burn is the used-pct delta over a real rolling window of poll history
  // (up to 24h) within the current cycle.
  const rows = db.prepare(`SELECT provider, used_pct, fetched_at, resets_at FROM quotas`).all() as {
    provider: string;
    used_pct: number;
    fetched_at: string;
    resets_at: string | null;
  }[];

  const byProvider = new Map<string, BurnPoint[]>();
  for (const r of rows) {
    const t = new Date(r.fetched_at).getTime();
    if (Number.isNaN(t) || t > now) continue;
    const pts = byProvider.get(r.provider) ?? [];
    pts.push({ usedPct: r.used_pct, t, resetsAt: r.resets_at });
    byProvider.set(r.provider, pts);
  }

  const out = new Map<string, number>();
  for (const [provider, all] of byProvider) {
    const sorted = currentCycle(all.sort((a, b) => a.t - b.t));
    const latest = sorted[sorted.length - 1];
    const cutoff = latest.t - 86400000;
    const windowStart = sorted.find((p) => p.t >= cutoff) ?? sorted[0];
    const days = (latest.t - windowStart.t) / 86400000;
    if (sorted.length < 2 || days < MIN_PACE_SPAN_DAYS) continue;
    const burn = (latest.usedPct - windowStart.usedPct) / days;
    if (burn >= 0 && Number.isFinite(burn)) out.set(provider, burn);
  }
  return out;
}

interface ReadingPoint {
  usedPct: number;
  t: number;
  resetsAt: string | null;
  monthlyPct?: number | null;
  monthlyStatus?: string | null;
}

export function getExhaustedTimestamps(
  db: any,
  now = Date.now(),
): { weekly: Map<string, string>; monthly: Map<string, string> } {
  let rows: {
    provider: string;
    used_pct: number;
    fetched_at: string;
    resets_at: string | null;
    monthly_pct?: number | null;
    monthly_status?: string | null;
  }[] = [];
  try {
    rows = db
      .prepare(
        `SELECT provider, used_pct, fetched_at, resets_at, monthly_pct, monthly_status FROM quotas`,
      )
      .all() as any[];
  } catch (e: any) {
    if (!/no such column/i.test(String(e?.message ?? ""))) throw e;
    rows = db
      .prepare(`SELECT provider, used_pct, fetched_at, resets_at FROM quotas`)
      .all() as any[];
  }

  const byProvider = new Map<string, ReadingPoint[]>();
  for (const r of rows) {
    const t = new Date(r.fetched_at).getTime();
    if (Number.isNaN(t) || t > now) continue;
    const pts = byProvider.get(r.provider) ?? [];
    pts.push({
      usedPct: r.used_pct,
      t,
      resetsAt: r.resets_at,
      monthlyPct: r.monthly_pct,
      monthlyStatus: r.monthly_status,
    });
    byProvider.set(r.provider, pts);
  }

  const weekly = new Map<string, string>();
  const monthly = new Map<string, string>();

  for (const [provider, all] of byProvider) {
    const sorted = currentCycle(all.sort((a, b) => a.t - b.t));
    if (sorted.length === 0) continue;
    const latest = sorted[sorted.length - 1];

    if (latest.usedPct >= 100) {
      const first = sorted.find((p) => p.usedPct >= 100);
      if (first) weekly.set(provider, new Date(first.t).toISOString());
    }

    const latestMonthlyExhausted =
      latest.monthlyStatus === "exhausted" ||
      (typeof latest.monthlyPct === "number" && latest.monthlyPct >= 100);
    if (latestMonthlyExhausted) {
      const firstMonthly = sorted.find(
        (p) =>
          p.monthlyStatus === "exhausted" ||
          (typeof p.monthlyPct === "number" && p.monthlyPct >= 100),
      );
      if (firstMonthly) monthly.set(provider, new Date(firstMonthly.t).toISOString());
    }
  }

  return { weekly, monthly };
}

export function getHistoryBaseline(db:any, limit = 4): Map<string, number> {
  let rows: { provider: string; used_pct: number; resets_at_estimated: number | null }[] = [];
  try {
    rows = db.prepare(`SELECT provider, used_pct, resets_at_estimated FROM window_closes ORDER BY detected_at DESC, id DESC`).all() as any[];
  } catch (e: any) {
    // A pre-observability database read offline is never migrated, so the
    // table can be absent. No table means no recorded closes.
    if (!/no such table/i.test(String(e?.message ?? ""))) throw e;
  }

  const byProvider = new Map<string, { usedPct: number; verified: boolean }[]>();
  for (const r of rows) {
    const closes = byProvider.get(r.provider) ?? [];
    closes.push({ usedPct: r.used_pct, verified: !r.resets_at_estimated });
    byProvider.set(r.provider, closes);
  }

  const out = new Map<string, number>();
  for (const [provider, newestFirst] of byProvider) {
    const pool = newestFirst.slice(0, limit);
    if (!pool.length) continue;
    const verified = pool.filter((c) => c.verified);
    const chosen = verified.length ? verified : pool;
    const mean = chosen.reduce((sum, c) => sum + c.usedPct, 0) / chosen.length;
    const rate = mean / 7;
    if (Number.isFinite(rate)) out.set(provider, rate);
  }
  return out;
}
