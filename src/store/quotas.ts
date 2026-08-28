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
export function getBurnRates(db:any): Map<string, number> {
  const rows = db.prepare(`SELECT day, provider, used_pct FROM snapshots`).all() as {day:string; provider:string; used_pct:number}[];
  const byProvider = new Map<string, {day:string; usedPct:number}[]>();
  for (const r of rows) {
    const pts = byProvider.get(r.provider) ?? [];
    pts.push({ day: r.day, usedPct: r.used_pct });
    byProvider.set(r.provider, pts);
  }
  const out = new Map<string, number>();
  for (const [provider, pts] of byProvider) {
    if (pts.length < 2) continue;
    const sorted = [...pts].sort((a, b) => a.day.localeCompare(b.day));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const days = (new Date(last.day).getTime() - new Date(first.day).getTime()) / 86400000;
    if (days < 1) continue;
    const burn = (last.usedPct - first.usedPct) / days;
    if (burn >= 0) out.set(provider, burn);
  }
  return out;
}
