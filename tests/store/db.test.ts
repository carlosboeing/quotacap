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

  it("measures burn rate from snapshot history", () => {
    const db = openDb(":memory:"); migrate(db);
    db.prepare(`INSERT INTO snapshots(day, provider, used_pct) VALUES('2026-08-26','claude',35)`).run();
    db.prepare(`INSERT INTO snapshots(day, provider, used_pct) VALUES('2026-08-28','claude',40)`).run();
    db.prepare(`INSERT INTO snapshots(day, provider, used_pct) VALUES('2026-08-28','kimi',16)`).run();
    const rates = getBurnRates(db);
    expect(rates.get("claude")).toBeCloseTo(2.5, 5);
    expect(rates.has("kimi")).toBe(false);
  });

  it("skips a burn measurement across a reset (usage went down)", () => {
    const db = openDb(":memory:"); migrate(db);
    db.prepare(`INSERT INTO snapshots(day, provider, used_pct) VALUES('2026-08-26','claude',40)`).run();
    db.prepare(`INSERT INTO snapshots(day, provider, used_pct) VALUES('2026-08-28','claude',16)`).run();
    expect(getBurnRates(db).has("claude")).toBe(false);
  });
});
