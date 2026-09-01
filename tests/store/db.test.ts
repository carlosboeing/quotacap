import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../../src/store/db.js";
import { upsertQuota, getLatestByProvider, getBurnRates } from "../../src/store/quotas.js";
describe("store", () => {
  it("migrates and upserts", async () => {
    const db = openDb(":memory:"); migrate(db);
    const q = { provider:"claude", plan:"max", usedPct:25, resetsAt:"2026-09-03T21:00:00+10:00", periodStart:"2026-08-26T00:00:00Z", raw:"x", source:"cli" as const, fetchedAt:new Date().toISOString() };
    upsertQuota(db, q);
    const got = getLatestByProvider(db,"claude");
    expect(got?.usedPct).toBe(25);
  });

  it("upserts an array of quotas", () => {
    const db = openDb(":memory:"); migrate(db);
    const q1 = { provider:"agy", plan:"unknown", usedPct:50, resetsAt:"2026-09-01T13:42:08Z", periodStart:"2026-08-25T00:00:00Z", raw:"x", source:"cli" as const, fetchedAt:new Date().toISOString() };
    const q2 = { provider:"agy:3p", plan:"unknown", usedPct:60, resetsAt:"2026-09-07T07:04:27Z", periodStart:"2026-08-31T00:00:00Z", raw:"y", source:"cli" as const, fetchedAt:new Date().toISOString() };
    upsertQuota(db, [q1, q2]);
    expect(getLatestByProvider(db, "agy")?.usedPct).toBe(50);
    expect(getLatestByProvider(db, "agy:3p")?.usedPct).toBe(60);
  });

  it("measures burn from poll history over a real 24h window", () => {
    const db = openDb(":memory:"); migrate(db);
    const now = Date.now();
    const h = (n: number) => new Date(now - n * 3600000).toISOString();
    db.prepare(`INSERT INTO quotas(provider, plan, used_pct, resets_at, period_start, source, fetched_at) VALUES('claude','max',25,'2026-09-03T21:00:00+10:00','2026-08-26T00:00:00Z','cli',?)`).run(h(24));
    db.prepare(`INSERT INTO quotas(provider, plan, used_pct, resets_at, period_start, source, fetched_at) VALUES('claude','max',44,'2026-09-03T21:00:00+10:00','2026-08-26T00:00:00Z','cli',?)`).run(h(0));
    const rates = getBurnRates(db);
    expect(rates.get("claude")).toBeCloseTo(19, 0);
  });

  it("skips burn measurement with fewer than two polls or a sub-hour window", () => {
    const db = openDb(":memory:"); migrate(db);
    const now = Date.now();
    const h = (n: number) => new Date(now - n * 3600000).toISOString();
    db.prepare(`INSERT INTO quotas(provider, plan, used_pct, resets_at, period_start, source, fetched_at) VALUES('claude','max',40,'2026-09-03T21:00:00+10:00','2026-08-26T00:00:00Z','cli',?)`).run(h(0.2));
    db.prepare(`INSERT INTO quotas(provider, plan, used_pct, resets_at, period_start, source, fetched_at) VALUES('claude','max',41,'2026-09-03T21:00:00+10:00','2026-08-26T00:00:00Z','cli',?)`).run(h(0));
    expect(getBurnRates(db).has("claude")).toBe(false);
  });

  it("skips a burn measurement across a reset (usage went down)", () => {
    const db = openDb(":memory:"); migrate(db);
    const now = Date.now();
    const h = (n: number) => new Date(now - n * 3600000).toISOString();
    db.prepare(`INSERT INTO quotas(provider, plan, used_pct, resets_at, period_start, source, fetched_at) VALUES('claude','max',44,'2026-09-03T21:00:00+10:00','2026-08-26T00:00:00Z','cli',?)`).run(h(24));
    db.prepare(`INSERT INTO quotas(provider, plan, used_pct, resets_at, period_start, source, fetched_at) VALUES('claude','max',10,'2026-09-03T21:00:00+10:00','2026-08-26T00:00:00Z','cli',?)`).run(h(0));
    expect(getBurnRates(db).has("claude")).toBe(false);
  });

  it("does not persist raw and round-trips creditsUsd", () => {
    const db = openDb(":memory:"); migrate(db);
    const q: any = { provider:"grok", plan:"SuperGrok", usedPct: 26, resetsAt:"2026-09-07T00:22:00Z", periodStart:"2026-08-31T00:22:00Z", source:"api" as const, fetchedAt:new Date().toISOString(), creditsUsd: 4.85, raw:"should-not-persist" };
    upsertQuota(db, q);
    const got:any = getLatestByProvider(db,"grok");
    expect(got.usedPct).toBe(26);
    expect(got.creditsUsd).toBe(4.85);
    expect(got.raw).toBeUndefined();
    expect((got as any).raw).toBeUndefined();
    const colNames = (db.prepare(`PRAGMA table_info(quotas)`).all() as any[]).map((c:any)=>c.name);
    expect(colNames).not.toContain("raw");
    expect(colNames).toContain("credits_usd");
  });

  it("sets file and dir modes 0600/0700 on openDb", async () => {
    const { mkdtempSync, statSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "qc-w1b-"));
    const freshDir = join(dir, "nested", "dbdir");
    const dbPath = join(freshDir, "quotacap.db");
    const db = openDb(dbPath); migrate(db);
    upsertQuota(db, { provider:"claude", plan:"max", usedPct:10, resetsAt:"2026-09-03T21:00:00Z", periodStart:"2026-08-26T00:00:00Z", source:"cli" as const, fetchedAt:new Date().toISOString() });
    const dirMode = statSync(freshDir).mode & 0o777;
    const fileMode = statSync(dbPath).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
    db.close?.();
  });

  it("migrates old schema with raw column preserving rows", () => {
    const db = openDb(":memory:");
    db.exec(`CREATE TABLE quotas(id INTEGER PRIMARY KEY, provider TEXT, plan TEXT, used_pct REAL, resets_at TEXT, period_start TEXT, raw TEXT, source TEXT, fetched_at TEXT)`);
    db.exec(`INSERT INTO quotas(provider, plan, used_pct, resets_at, period_start, raw, source, fetched_at) VALUES('claude','max',25,'2026-09-03T21:00:00+10:00','2026-08-26T00:00:00Z','secret','cli','2026-08-30T00:00:00Z')`);
    db.exec(`INSERT INTO quotas(provider, plan, used_pct, resets_at, period_start, raw, source, fetched_at) VALUES('grok','pro',50,'2026-09-07T00:22:00Z','2026-08-31T00:22:00Z','secret2','api','2026-08-30T01:00:00Z')`);
    migrate(db);
    const cols = (db.prepare(`PRAGMA table_info(quotas)`).all() as any[]).map((c:any)=>c.name);
    expect(cols).not.toContain("raw");
    expect(cols).toContain("credits_usd");
    const rows = db.prepare(`SELECT provider, used_pct FROM quotas`).all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].provider).toBe("claude");
    const latest = getLatestByProvider(db,"claude");
    expect(latest?.usedPct).toBe(25);
    expect((latest as any).raw).toBeUndefined();
  });
});
