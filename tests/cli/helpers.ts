// CLI test helpers: seed isolated file databases from the in-memory fixture
// builders via VACUUM INTO (D14) — no A changes, no live-database contact.
import fs from "node:fs";
import path from "node:path";
import { migrate, openDb } from "../../src/store/db.js";
import { FIXED_NOW, buildFixtureDb } from "../fixtures/stable-state.js";

export function seedEmptyDb(filePath: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.rmSync(filePath);
  } catch {
    /* fresh file */
  }
  const db = openDb(filePath);
  try {
    migrate(db);
  } finally {
    db.close();
  }
  return filePath;
}

export function seedFileDb(filePath: string, build: () => any = buildFixtureDb): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.rmSync(filePath);
  } catch {
    /* VACUUM INTO refuses an existing target */
  }
  const db = build();
  try {
    db.exec(`VACUUM INTO '${filePath.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  return filePath;
}

// Pre-A schema: quotas without session_pct (or credits/estimated columns)
// and no adapter_attempts table at all.
export function seedLegacyDb(filePath: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.rmSync(filePath);
  } catch {
    /* fresh file */
  }
  const db = openDb(filePath);
  try {
    db.exec(
      `CREATE TABLE quotas(id INTEGER PRIMARY KEY, provider TEXT, plan TEXT, used_pct REAL, resets_at TEXT, period_start TEXT, source TEXT, fetched_at TEXT)`,
    );
    db.prepare(
      `INSERT INTO quotas(provider, plan, used_pct, resets_at, period_start, source, fetched_at) VALUES(?,?,?,?,?,?,?)`,
    ).run(
      "kimi",
      "p",
      22,
      "2026-09-14T06:00:00+10:00",
      "2026-08-31T06:00:00+10:00",
      "cli",
      FIXED_NOW.toISOString(),
    );
  } finally {
    db.close();
  }
  return filePath;
}
