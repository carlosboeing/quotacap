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

  it("measures burn from poll history over a real 24h window", () => {
    const db = openDb(":memory:"); migrate(db);
    const now = Date.now();
    const h = (n: number) => new Date(now - n * 3600000).toISOString();
    db.prepare(`INSERT INTO quotas(provider, plan, used_pct, resets_at, period_start, raw, source, fetched_at) VALUES('claude','max',25,'2026-09-03T21:00:00+10:00','2026-08-26T00:00:00Z','x','cli',?)`).run(h(24));
    db.prepare(`INSERT INTO quotas(provider, plan, used_pct, resets_at, period_start, raw, source, fetched_at) VALUES('claude','max',44,'2026-09-03T21:00:00+10:00','2026-08-26T00:00:00Z','x','cli',?)`).run(h(0));
    const rates = getBurnRates(db);
    expect(rates.get("claude")).toBeCloseTo(19, 0);
  });

  it("skips burn measurement with fewer than two polls or a sub-hour window", () => {
    const db = openDb(":memory:"); migrate(db);
    const now = Date.now();
    const h = (n: number) => new Date(now - n * 3600000).toISOString();
    db.prepare(`INSERT INTO quotas(provider, plan, used_pct, resets_at, period_start, raw, source, fetched_at) VALUES('claude','max',40,'2026-09-03T21:00:00+10:00','2026-08-26T00:00:00Z','x','cli',?)`).run(h(0.2));
    db.prepare(`INSERT INTO quotas(provider, plan, used_pct, resets_at, period_start, raw, source, fetched_at) VALUES('claude','max',41,'2026-09-03T21:00:00+10:00','2026-08-26T00:00:00Z','x','cli',?)`).run(h(0));
    expect(getBurnRates(db).has("claude")).toBe(false);
  });

  it("skips a burn measurement across a reset (usage went down)", () => {
    const db = openDb(":memory:"); migrate(db);
    const now = Date.now();
    const h = (n: number) => new Date(now - n * 3600000).toISOString();
    db.prepare(`INSERT INTO quotas(provider, plan, used_pct, resets_at, period_start, raw, source, fetched_at) VALUES('claude','max',44,'2026-09-03T21:00:00+10:00','2026-08-26T00:00:00Z','x','cli',?)`).run(h(24));
    db.prepare(`INSERT INTO quotas(provider, plan, used_pct, resets_at, period_start, raw, source, fetched_at) VALUES('claude','max',10,'2026-09-03T21:00:00+10:00','2026-08-26T00:00:00Z','x','cli',?)`).run(h(0));
    expect(getBurnRates(db).has("claude")).toBe(false);
  });
});
