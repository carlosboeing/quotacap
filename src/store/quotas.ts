function mapRow(row:any){
  if(!row) return row;
  const out:any = {
    ...row,
    usedPct: row.used_pct ?? row.usedPct,
    resetsAt: row.resets_at ?? row.resetsAt,
    periodStart: row.period_start ?? row.periodStart,
    fetchedAt: row.fetched_at ?? row.fetchedAt,
    creditsUsd: row.credits_usd ?? row.creditsUsd,
    resetsAtEstimated: !!(row.resets_at_estimated ?? row.resetsAtEstimated),
    sessionPct: row.session_pct ?? row.sessionPct ?? undefined,
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
  if (out.sessionPct == null) delete out.sessionPct;
  return out;
}

export function upsertQuota(db:any, q:any){
  if (Array.isArray(q)) {
    for (const item of q) upsertQuota(db, item);
    return;
  }
  const credits = q.creditsUsd ?? q.credits_usd ?? null;
  const estimated = q.resetsAtEstimated ? 1 : null;
  const sessionPct = q.sessionPct ?? q.session_pct ?? null;
  db.prepare(`INSERT INTO quotas(provider, plan, used_pct, resets_at, period_start, source, fetched_at, credits_usd, resets_at_estimated, session_pct) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(q.provider, q.plan, q.usedPct, q.resetsAt, q.periodStart, q.source, q.fetchedAt, credits, estimated, sessionPct);
  const day = new Date().toISOString().slice(0,10);
  db.prepare(`INSERT INTO snapshots(day, provider, used_pct) VALUES(?,?,?) ON CONFLICT(day, provider) DO UPDATE SET used_pct=excluded.used_pct`).run(day, q.provider, q.usedPct);
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
export function getBurnRates(db:any, now = Date.now()): Map<string, number> {
  // Burn is the used-pct delta over a real rolling window of poll history
  // (up to 24h) within the current cycle window (periodStart to resetsAt).
  const rows = db.prepare(`SELECT provider, used_pct, fetched_at, period_start, resets_at FROM quotas`).all() as {
    provider: string;
    used_pct: number;
    fetched_at: string;
    period_start: string | null;
    resets_at: string | null;
  }[];

  // 1. Read latest row per provider (with valid fetchedAt <= now) to fix the current window
  const latestByProvider = new Map<string, { periodStart: string | null; resetsAt: string | null; t: number }>();
  for (const r of rows) {
    const t = new Date(r.fetched_at).getTime();
    if (Number.isNaN(t) || t > now) continue;
    const cur = latestByProvider.get(r.provider);
    if (!cur || t > cur.t) {
      latestByProvider.set(r.provider, { periodStart: r.period_start, resetsAt: r.resets_at, t });
    }
  }

  const byProvider = new Map<string, { usedPct: number; t: number }[]>();
  for (const r of rows) {
    const t = new Date(r.fetched_at).getTime();
    if (Number.isNaN(t) || t > now) continue;
    const currentWindow = latestByProvider.get(r.provider);
    if (!currentWindow) continue;

    // Cycle guard: drop points whose stored periodStart differs from the current window start
    if (currentWindow.periodStart != null) {
      if (r.period_start !== currentWindow.periodStart) continue;
      const startMs = new Date(currentWindow.periodStart).getTime();
      if (!Number.isNaN(startMs) && t < startMs) continue;
    }

    const pts = byProvider.get(r.provider) ?? [];
    pts.push({ usedPct: r.used_pct, t });
    byProvider.set(r.provider, pts);
  }

  const out = new Map<string, number>();
  for (const [provider, pts] of byProvider) {
    const sorted = pts.sort((a, b) => a.t - b.t);
    const latest = sorted[sorted.length - 1];
    const cutoff = latest.t - 86400000;
    const windowStart = sorted.find((p) => p.t >= cutoff) ?? sorted[0];
    const days = (latest.t - windowStart.t) / 86400000;
    if (sorted.length < 2 || days < 1 / 24) continue;
    const burn = (latest.usedPct - windowStart.usedPct) / days;
    if (burn >= 0 && Number.isFinite(burn)) out.set(provider, burn);
  }
  return out;
}
