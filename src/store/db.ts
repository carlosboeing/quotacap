import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
export function openDb(path:string){ return new DatabaseSync(path); }
export function migrate(db:any){
  db.exec(`CREATE TABLE IF NOT EXISTS quotas(id INTEGER PRIMARY KEY, provider TEXT, plan TEXT, used_pct REAL, resets_at TEXT, period_start TEXT, raw TEXT, source TEXT, fetched_at TEXT);
           CREATE TABLE IF NOT EXISTS snapshots(day TEXT, provider TEXT, used_pct REAL, burn_rate REAL, ideal_rate REAL, PRIMARY KEY(day, provider));
           CREATE INDEX IF NOT EXISTS idx_quotas_provider ON quotas(provider);`);
}
