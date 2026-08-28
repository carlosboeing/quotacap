import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/store/db.ts";
import { upsertQuota, getLatestByProvider } from "../../src/store/quotas.ts";

test("store works under bun runtime", () => {
  const db = openDb(":memory:");
  migrate(db);
  const q = {
    provider: "claude",
    plan: "max",
    usedPct: 25,
    resetsAt: "2026-09-03T21:00:00+10:00",
    periodStart: "2026-08-26T00:00:00Z",
    raw: "x",
    source: "cli" as const,
    fetchedAt: new Date().toISOString(),
  };
  upsertQuota(db, q);
  const got = getLatestByProvider(db, "claude");
  expect(got?.usedPct).toBe(25);
  db.close();
});