import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../../src/store/db.js";
import { getHistoryBaseline } from "../../src/store/quotas.js";

let sampledQuotaId = 1;

function close(db: any, over: any = {}) {
  const r = {
    provider: "agy",
    plan: "Pro",
    usedPct: 70,
    leftoverPct: 30,
    sampledAt: "2026-09-10T02:20:00Z",
    periodStart: "2026-09-03T02:25:00Z",
    resetsAt: "2026-09-10T02:25:00Z",
    resetsAtEstimated: false,
    detectedAt: "2026-09-10T02:40:00Z",
    reason: "usage-drop",
    ...over,
  };
  db.prepare(
    `INSERT INTO window_closes(provider, plan, used_pct, leftover_pct, sampled_at, sampled_quota_id, period_start, resets_at, resets_at_estimated, detected_at, reason) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    r.provider, r.plan, r.usedPct, r.leftoverPct, r.sampledAt, sampledQuotaId++,
    r.periodStart, r.resetsAt, r.resetsAtEstimated ? 1 : null, r.detectedAt, r.reason
  );
}

describe("history baseline", () => {
  it("computes the prior-week daily mean per provider", () => {
    const db = openDb(":memory:"); migrate(db);
    close(db, { usedPct: 70, detectedAt: "2026-09-03T02:40:00Z" });
    close(db, { usedPct: 84, detectedAt: "2026-09-10T02:40:00Z" });
    close(db, { provider: "grok", usedPct: 35 });
    const baseline = getHistoryBaseline(db);
    expect(baseline.get("agy")).toBeCloseTo(11, 10);
    expect(baseline.get("grok")).toBeCloseTo(5, 10);
    expect(baseline.has("kimi")).toBe(false);
  });

  it("uses verified closes only when the pool contains at least one", () => {
    const db = openDb(":memory:"); migrate(db);
    close(db, { usedPct: 100, resetsAtEstimated: true, detectedAt: "2026-09-10T02:40:00Z" });
    close(db, { usedPct: 91, resetsAtEstimated: true, detectedAt: "2026-09-08T02:40:00Z" });
    close(db, { usedPct: 70, detectedAt: "2026-09-06T02:40:00Z" });
    expect(getHistoryBaseline(db).get("agy")).toBeCloseTo(10, 10);
  });

  it("falls back to all closes when none are verified", () => {
    const db = openDb(":memory:"); migrate(db);
    close(db, { usedPct: 35, resetsAtEstimated: true, detectedAt: "2026-09-10T02:40:00Z" });
    close(db, { usedPct: 49, resetsAtEstimated: true, detectedAt: "2026-09-08T02:40:00Z" });
    expect(getHistoryBaseline(db).get("agy")).toBeCloseTo(6, 10);
  });

  it("returns no entry without closes", () => {
    const db = openDb(":memory:"); migrate(db);
    expect(getHistoryBaseline(db).size).toBe(0);
  });

  it("uses only the four newest closes by default", () => {
    const db = openDb(":memory:"); migrate(db);
    close(db, { usedPct: 0, detectedAt: "2026-09-01T02:40:00Z" });
    close(db, { usedPct: 14, detectedAt: "2026-09-02T02:40:00Z" });
    close(db, { usedPct: 21, detectedAt: "2026-09-03T02:40:00Z" });
    close(db, { usedPct: 28, detectedAt: "2026-09-04T02:40:00Z" });
    close(db, { usedPct: 35, detectedAt: "2026-09-05T02:40:00Z" });
    expect(getHistoryBaseline(db).get("agy")).toBeCloseTo(3.5, 10);
  });

  it("honors a custom limit", () => {
    const db = openDb(":memory:"); migrate(db);
    close(db, { usedPct: 0, detectedAt: "2026-09-01T02:40:00Z" });
    close(db, { usedPct: 14, detectedAt: "2026-09-02T02:40:00Z" });
    close(db, { usedPct: 21, detectedAt: "2026-09-03T02:40:00Z" });
    close(db, { usedPct: 28, detectedAt: "2026-09-04T02:40:00Z" });
    close(db, { usedPct: 35, detectedAt: "2026-09-05T02:40:00Z" });
    expect(getHistoryBaseline(db, 2).get("agy")).toBeCloseTo(4.5, 10);
  });

  it("returns an empty map without the ledger table", () => {
    const db = openDb(":memory:");
    expect(getHistoryBaseline(db).size).toBe(0);
  });
});
