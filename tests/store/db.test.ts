import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../../src/store/db.js";
import { upsertQuota, getLatestByProvider } from "../../src/store/quotas.js";
describe("store", () => {
  it("migrates and upserts", async () => {
    const db = openDb(":memory:"); migrate(db);
    const q = { provider:"claude", plan:"max", usedPct:25, resetsAt:"2026-09-03T21:00:00+10:00", periodStart:"2026-08-26T00:00:00Z", raw:"x", source:"cli" as const, fetchedAt:new Date().toISOString() };
    upsertQuota(db, q);
    const got = getLatestByProvider(db,"claude");
    expect(got?.usedPct).toBe(25);
  });
});
