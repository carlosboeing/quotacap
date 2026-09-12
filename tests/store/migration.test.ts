import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../../src/store/db.js";
import { upsertQuota, getLatestByProvider } from "../../src/store/quotas.js";

const NOW = "2026-09-07T06:00:00+10:00";

describe("session_pct migration", () => {
  it("persists sessionPct without inventing a session reset", () => {
    const db = openDb(":memory:"); migrate(db);
    upsertQuota(db, { provider: "claude", plan: "max", usedPct: 40, sessionPct: 22,
      resetsAt: "2026-09-14T06:00:00+10:00", periodStart: "2026-09-07T06:00:00+10:00",
      source: "cli", fetchedAt: NOW } as any);
    const got: any = getLatestByProvider(db, "claude");
    expect(got.sessionPct).toBe(22);
    expect(got.resetsAt).toBe("2026-09-14T06:00:00+10:00");
  });

  it("upgrades a pre-session_pct database preserving rows", () => {
    const db = openDb(":memory:");
    db.exec(`CREATE TABLE quotas(id INTEGER PRIMARY KEY, provider TEXT, plan TEXT, used_pct REAL, resets_at TEXT, period_start TEXT, source TEXT, fetched_at TEXT, credits_usd REAL, resets_at_estimated INTEGER)`);
    db.exec(`INSERT INTO quotas(provider, plan, used_pct, resets_at, period_start, source, fetched_at) VALUES('claude','max',25,'2026-09-14T06:00:00+10:00','2026-09-07T06:00:00+10:00','cli','${NOW}')`);
    migrate(db); migrate(db); // idempotent
    const cols = (db.prepare(`PRAGMA table_info(quotas)`).all() as any[]).map(c => c.name);
    expect(cols).toContain("session_pct");
    expect((getLatestByProvider(db, "claude") as any).usedPct).toBe(25);
    expect((getLatestByProvider(db, "claude") as any).sessionPct).toBeUndefined();
  });

  it("recovers: second migrate after partial upgrade keeps data", () => {
    const db = openDb(":memory:");
    db.exec(`CREATE TABLE quotas(id INTEGER PRIMARY KEY, provider TEXT, plan TEXT, used_pct REAL, resets_at TEXT, period_start TEXT, raw TEXT, source TEXT, fetched_at TEXT)`);
    db.exec(`INSERT INTO quotas(provider, plan, used_pct, resets_at, period_start, raw, source, fetched_at) VALUES('kimi','p',22,'2026-09-14T06:00:00+10:00','2026-08-31T06:00:00+10:00','secret','cli','2026-09-07T06:00:00+10:00')`);
    migrate(db);
    const cols = (db.prepare(`PRAGMA table_info(quotas)`).all() as any[]).map((c: any) => c.name);
    expect(cols).not.toContain("raw");
    for (const c of ["credits_usd", "resets_at_estimated", "session_pct"]) expect(cols).toContain(c);
    expect(db.prepare(`SELECT COUNT(*) v FROM adapter_attempts`).get()).toMatchObject({ v: 0 });
    migrate(db);
    expect((getLatestByProvider(db, "kimi") as any).usedPct).toBe(22);
    expect(JSON.stringify(db.prepare(`SELECT * FROM quotas`).all())).not.toContain("secret");
  });
});

describe("adapter_attempts migration", () => {
  it("upgrades a pre-observability database preserving rows and retaining legacy parse", () => {
    const db = openDb(":memory:");
    // Create pre-observability schema directly
    db.exec(`CREATE TABLE adapter_attempts(provider TEXT PRIMARY KEY, attempted_at TEXT NOT NULL, completed_at TEXT, succeeded_at TEXT, success INTEGER NOT NULL, failure_category TEXT)`);
    db.exec(`INSERT INTO adapter_attempts(provider, attempted_at, completed_at, succeeded_at, success, failure_category)
      VALUES('kimi', '2026-09-07T06:00:00Z', '2026-09-07T06:00:05Z', NULL, 0, 'parse')`);

    migrate(db);
    migrate(db); // Idempotent

    const cols = (db.prepare(`PRAGMA table_info(adapter_attempts)`).all() as any[]).map((c: any) => c.name);
    for (const col of ["diagnostic_code", "summary", "action", "error_detail"]) {
      expect(cols).toContain(col);
    }

    const row = db.prepare(`SELECT * FROM adapter_attempts WHERE provider='kimi'`).get() as any;
    expect(row.failure_category).toBe("parse");
    expect(row.diagnostic_code).toBeNull();
    expect(row.summary).toBeNull();
    expect(row.action).toBeNull();
    expect(row.error_detail).toBeNull();
  });

  it("repeated migration idempotency on fresh database", () => {
    const db = openDb(":memory:");
    migrate(db);
    migrate(db);
    const cols = (db.prepare(`PRAGMA table_info(adapter_attempts)`).all() as any[]).map((c: any) => c.name);
    for (const col of ["diagnostic_code", "summary", "action", "error_detail"]) {
      expect(cols).toContain(col);
    }
  });
});
