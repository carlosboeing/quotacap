// node:sqlite under node, bun:sqlite under bun — same sync API surface used here.
// Variable specifier keeps vite/rollup from statically resolving the other runtime's builtin.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const BUN_SQLITE = "bun:sqlite";
let SQLite: any;
try {
  SQLite = require("node:sqlite").DatabaseSync;
} catch {
  SQLite = require(BUN_SQLITE).Database;
}
export function openDb(path: string) { return new SQLite(path); }
export function migrate(db:any){
  db.exec(`CREATE TABLE IF NOT EXISTS quotas(id INTEGER PRIMARY KEY, provider TEXT, plan TEXT, used_pct REAL, resets_at TEXT, period_start TEXT, raw TEXT, source TEXT, fetched_at TEXT);
           CREATE TABLE IF NOT EXISTS snapshots(day TEXT, provider TEXT, used_pct REAL, burn_rate REAL, ideal_rate REAL, PRIMARY KEY(day, provider));
           CREATE INDEX IF NOT EXISTS idx_quotas_provider ON quotas(provider);`);
}
