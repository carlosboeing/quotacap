// node:sqlite under node, bun:sqlite under bun — same sync API surface used here.
// Variable specifier keeps vite/rollup from statically resolving the other runtime's builtin.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
const BUN_SQLITE = "bun:sqlite";
let SQLite: any;
try {
  SQLite = require("node:sqlite").DatabaseSync;
} catch {
  SQLite = require(BUN_SQLITE).Database;
}
export function openDb(p: string) {
  if (p !== ":memory:" && !p.startsWith("file:")) {
    try {
      const dir = path.dirname(p);
      if (dir && dir !== "." && dir !== "/") {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        try { fs.chmodSync(dir, 0o700); } catch {}
      }
    } catch {}
  }
  const db = new SQLite(p);
  if (p !== ":memory:" && !p.startsWith("file:")) {
    try { fs.chmodSync(p, 0o600); } catch {}
  }
  return db;
}
export function migrate(db:any){
  db.exec(`CREATE TABLE IF NOT EXISTS quotas(id INTEGER PRIMARY KEY, provider TEXT, plan TEXT, used_pct REAL, resets_at TEXT, period_start TEXT, source TEXT, fetched_at TEXT, credits_usd REAL);
           CREATE TABLE IF NOT EXISTS snapshots(day TEXT, provider TEXT, used_pct REAL, burn_rate REAL, ideal_rate REAL, PRIMARY KEY(day, provider));
           CREATE INDEX IF NOT EXISTS idx_quotas_provider ON quotas(provider);`);
  try {
    const cols = db.prepare(`PRAGMA table_info(quotas)`).all() as { name: string }[];
    const names = new Set(cols.map((c:any)=>c.name));
    const hasRaw = names.has("raw");
    const hasCredits = names.has("credits_usd");
    if (hasRaw) {
      db.exec(`CREATE TABLE IF NOT EXISTS quotas_new(id INTEGER PRIMARY KEY, provider TEXT, plan TEXT, used_pct REAL, resets_at TEXT, period_start TEXT, source TEXT, fetched_at TEXT, credits_usd REAL)`);
      const selCredits = hasCredits ? "credits_usd" : "NULL";
      db.exec(`INSERT INTO quotas_new(id, provider, plan, used_pct, resets_at, period_start, source, fetched_at, credits_usd) SELECT id, provider, plan, used_pct, resets_at, period_start, source, fetched_at, ${selCredits} FROM quotas`);
      db.exec(`DROP TABLE quotas`);
      db.exec(`ALTER TABLE quotas_new RENAME TO quotas`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_quotas_provider ON quotas(provider)`);
    } else if (!hasCredits) {
      db.exec(`ALTER TABLE quotas ADD COLUMN credits_usd REAL`);
    }
  } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_quotas_provider ON quotas(provider)`); } catch {}
}
