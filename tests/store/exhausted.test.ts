import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../../src/store/db.js";
import { getExhaustedTimestamps, upsertQuota } from "../../src/store/quotas.js";

describe("getExhaustedTimestamps", () => {
  it("finds the earliest 100% reading in the current cycle", () => {
    const db = openDb(":memory:");
    migrate(db);

    // Reading 1: 50% on Monday morning
    upsertQuota(db, {
      provider: "muse",
      plan: "Pro",
      weeklyPct: 50,
      resetsAt: "2026-10-26T00:00:00.000Z",
      periodStart: "2026-10-19T00:00:00.000Z",
      fetchedAt: "2026-10-19T10:00:00.000Z",
      source: "tui",
    });

    // Reading 2: First 100% on Monday night
    upsertQuota(db, {
      provider: "muse",
      plan: "Pro",
      weeklyPct: 100,
      resetsAt: "2026-10-26T00:00:00.000Z",
      periodStart: "2026-10-19T00:00:00.000Z",
      fetchedAt: "2026-10-19T23:31:00.000Z",
      source: "tui",
    });

    // Reading 3: Still 100% on Tuesday
    upsertQuota(db, {
      provider: "muse",
      plan: "Pro",
      weeklyPct: 100,
      resetsAt: "2026-10-26T00:00:00.000Z",
      periodStart: "2026-10-19T00:00:00.000Z",
      fetchedAt: "2026-10-20T12:00:00.000Z",
      source: "tui",
    });

    // Reading 4: Still 100% on Wednesday
    upsertQuota(db, {
      provider: "muse",
      plan: "Pro",
      weeklyPct: 100,
      resetsAt: "2026-10-26T00:00:00.000Z",
      periodStart: "2026-10-19T00:00:00.000Z",
      fetchedAt: "2026-10-21T12:00:00.000Z",
      source: "tui",
    });

    const res = getExhaustedTimestamps(db, Date.parse("2026-10-21T12:00:00.000Z"));
    expect(res.weekly.get("muse")).toBe("2026-10-19T23:31:00.000Z");
  });

  it("returns empty map when usage has not reached 100%", () => {
    const db = openDb(":memory:");
    migrate(db);

    upsertQuota(db, {
      provider: "claude",
      plan: "Pro",
      weeklyPct: 40,
      resetsAt: "2026-10-26T00:00:00.000Z",
      periodStart: "2026-10-19T00:00:00.000Z",
      fetchedAt: "2026-10-20T10:00:00.000Z",
      source: "cli",
    });

    const res = getExhaustedTimestamps(db, Date.parse("2026-10-20T12:00:00.000Z"));
    expect(res.weekly.has("claude")).toBe(false);
  });
});
