function mapRow(row:any){
  if(!row) return row;
  // normalize snake_case DB row to camelCase Quota shape while keeping snake fields for compat
  return {
    ...row,
    usedPct: row.used_pct ?? row.usedPct,
    resetsAt: row.resets_at ?? row.resetsAt,
    periodStart: row.period_start ?? row.periodStart,
    fetchedAt: row.fetched_at ?? row.fetchedAt,
  };
}

export function upsertQuota(db:any, q:any){
  if (Array.isArray(q)) {
    for (const item of q) upsertQuota(db, item);
    return;
  }
  db.prepare(`INSERT INTO quotas(provider, plan, used_pct, resets_at, period_start, raw, source, fetched_at) VALUES(?,?,?,?,?,?,?,?)`).run(q.provider, q.plan, q.usedPct, q.resetsAt, q.periodStart, q.raw, q.source, q.fetchedAt);
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
  // (up to 24h), so calendar-day boundaries and poll timing cannot skew it.
  const rows = db.prepare(`SELECT provider, used_pct, fetched_at FROM quotas`).all() as {provider:string; used_pct:number; fetched_at:string}[];
  const byProvider = new Map<string, {usedPct:number; t:number}[]>();
  for (const r of rows) {
    const t = new Date(r.fetched_at).getTime();
    if (Number.isNaN(t)) continue;
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
    if (burn >= 0) out.set(provider, burn);
  }
  return out;
}
