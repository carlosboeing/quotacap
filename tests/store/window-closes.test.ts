import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../../src/store/db.js";
import { upsertQuota, getWindowCloses } from "../../src/store/quotas.js";

function row(over: any = {}) {
  return {
    provider: "agy",
    plan: "Pro",
    usedPct: 0,
    resetsAt: "2026-09-10T02:25:00Z",
    periodStart: "2026-09-03T02:25:00Z",
    source: "cli",
    fetchedAt: "2026-09-10T02:40:00Z",
    ...over,
  };
}

describe("window closes", () => {
  it("writes leftover from the last old-window poll when usage drops", () => {
    const db = openDb(":memory:"); migrate(db);
    upsertQuota(db, row({ usedPct: 88, fetchedAt: "2026-09-10T02:20:00Z", resetsAt: "2026-09-10T02:25:00Z" }));
    upsertQuota(db, row({ usedPct: 0, fetchedAt: "2026-09-10T02:40:00Z", resetsAt: "2026-09-17T02:25:00Z" }));
    const closes = getWindowCloses(db, "agy");
    expect(closes).toHaveLength(1);
    expect(closes[0].usedPct).toBe(88);
    expect(closes[0].leftoverPct).toBe(12);
    expect(closes[0].sampledAt).toBe("2026-09-10T02:20:00Z");
    expect(closes[0].detectedAt).toBe("2026-09-10T02:40:00Z");
    expect(closes[0].reason).toBe("both");
    expect(closes[0].plan).toBe("Pro");
    expect(closes[0].periodStart).toBe("2026-09-03T02:25:00Z");
    expect(closes[0].resetsAt).toBe("2026-09-10T02:25:00Z");
    expect(closes[0].resetsAtEstimated).toBe(false);
    const firstId = (db.prepare(`SELECT id FROM quotas ORDER BY id`).all() as any[])[0].id;
    expect(db.prepare(`SELECT sampled_quota_id, reason FROM window_closes`).all()).toEqual([
      { sampled_quota_id: firstId, reason: "both" },
    ]);
  });

  it("writes reason usage-drop when usage falls inside the same reset boundary", () => {
    const db = openDb(":memory:"); migrate(db);
    upsertQuota(db, row({ usedPct: 60, fetchedAt: "2026-09-10T02:20:00Z", resetsAt: "2026-09-17T02:25:00Z" }));
    upsertQuota(db, row({ usedPct: 40, fetchedAt: "2026-09-10T02:40:00Z", resetsAt: "2026-09-17T02:25:00Z" }));
    const closes = getWindowCloses(db, "agy");
    expect(closes).toHaveLength(1);
    expect(closes[0].usedPct).toBe(60);
    expect(closes[0].reason).toBe("usage-drop");
  });

  it("writes a close when resetsAt rolls even if usedPct rose", () => {
    const db = openDb(":memory:"); migrate(db);
    upsertQuota(db, row({ usedPct: 40, fetchedAt: "2026-09-10T02:20:00Z", resetsAt: "2026-09-10T02:25:00Z" }));
    upsertQuota(db, row({ usedPct: 55, fetchedAt: "2026-09-10T02:40:00Z", resetsAt: "2026-09-17T02:25:00Z" }));
    const closes = getWindowCloses(db, "agy");
    expect(closes).toHaveLength(1);
    expect(closes[0].usedPct).toBe(40);
    expect(closes[0].leftoverPct).toBe(60);
    expect(closes[0].reason).toBe("resets-at-rolled");
  });

  it("writes no close on the first poll of a provider", () => {
    const db = openDb(":memory:"); migrate(db);
    upsertQuota(db, row({ usedPct: 30, fetchedAt: "2026-09-10T02:20:00Z" }));
    expect(getWindowCloses(db, "agy")).toEqual([]);
  });

  it("does not duplicate a close when the same new-window poll is persisted again", () => {
    const db = openDb(":memory:"); migrate(db);
    const oldWindow = row({ usedPct: 88, fetchedAt: "2026-09-10T02:20:00Z", resetsAt: "2026-09-10T02:25:00Z" });
    const newWindow = row({ usedPct: 0, fetchedAt: "2026-09-10T02:40:00Z", resetsAt: "2026-09-17T02:25:00Z" });
    upsertQuota(db, oldWindow);
    upsertQuota(db, newWindow);
    upsertQuota(db, newWindow);
    expect(getWindowCloses(db, "agy")).toHaveLength(1);
  });

  it("ignores a sessionPct drop when usedPct is unchanged", () => {
    const db = openDb(":memory:"); migrate(db);
    upsertQuota(db, row({ usedPct: 40, sessionPct: 80, fetchedAt: "2026-09-10T02:20:00Z", resetsAt: "2026-09-10T02:25:00Z" }));
    upsertQuota(db, row({ usedPct: 40, sessionPct: 5, fetchedAt: "2026-09-10T02:40:00Z", resetsAt: "2026-09-10T02:25:00Z" }));
    expect(getWindowCloses(db, "agy")).toEqual([]);
  });

  it("returns closes newest-first, capped at four, per provider", () => {
    const db = openDb(":memory:"); migrate(db);
    const base = Date.parse("2026-06-01T02:20:00Z");
    const week = 7 * 86400000;
    const iso = (t: number) => new Date(t).toISOString();
    for (let i = 0; i < 6; i++) {
      const at = base + i * week;
      upsertQuota(db, row({ usedPct: 80 + i, fetchedAt: iso(at), resetsAt: iso(at + 5 * 60000) }));
      upsertQuota(db, row({ usedPct: 0, fetchedAt: iso(at + 20 * 60000), resetsAt: iso(at + week + 5 * 60000) }));
    }
    const closes = getWindowCloses(db, "agy");
    expect(closes).toHaveLength(4);
    expect(closes[0].detectedAt).toBe(iso(base + 5 * week + 20 * 60000));
    expect(closes[1].detectedAt).toBe(iso(base + 4 * week + 20 * 60000));
    expect(closes[3].detectedAt).toBe(iso(base + 2 * week + 20 * 60000));
    expect(getWindowCloses(db, "grok")).toEqual([]);
  });

  it("clamps leftover at zero when the last reading exceeded 100%", () => {
    const db = openDb(":memory:"); migrate(db);
    upsertQuota(db, row({ usedPct: 104, fetchedAt: "2026-09-10T02:20:00Z", resetsAt: "2026-09-10T02:25:00Z" }));
    upsertQuota(db, row({ usedPct: 0, fetchedAt: "2026-09-10T02:40:00Z", resetsAt: "2026-09-17T02:25:00Z" }));
    expect(getWindowCloses(db, "agy")[0].leftoverPct).toBe(0);
  });

  it("carries the estimated flag from the sampled row", () => {
    const db = openDb(":memory:"); migrate(db);
    upsertQuota(db, row({ usedPct: 50, resetsAtEstimated: true, fetchedAt: "2026-09-10T02:20:00Z", resetsAt: "2026-09-10T02:25:00Z" }));
    upsertQuota(db, row({ usedPct: 0, resetsAtEstimated: true, fetchedAt: "2026-09-10T02:40:00Z", resetsAt: "2026-09-17T02:25:00Z" }));
    expect(getWindowCloses(db, "agy")[0].resetsAtEstimated).toBe(true);
  });
});
