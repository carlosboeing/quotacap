import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../../src/store/db.js";
import { getHistoryBaseline } from "../../src/store/quotas.js";

let sampledQuotaId = 1;
const DAY_MS = 86_400_000;
const WEEK0 = Date.parse("2026-08-06T02:25:00Z");

function iso(ms: number) {
  return new Date(ms).toISOString();
}

// A close of week n, sampled 5 minutes before its reset unless overridden.
function week(n: number, over: any = {}) {
  const start = WEEK0 + n * 7 * DAY_MS;
  const reset = start + 7 * DAY_MS;
  return {
    periodStart: iso(start),
    resetsAt: iso(reset),
    sampledAt: iso(reset - 5 * 60_000),
    detectedAt: iso(reset + 15 * 60_000),
    ...over,
  };
}

function close(db: any, over: any = {}) {
  const r = {
    provider: "agy",
    plan: "Pro",
    usedPct: 70,
    leftoverPct: 30,
    resetsAtEstimated: false,
    reason: "usage-drop",
    ...week(4),
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
    close(db, { usedPct: 70, ...week(3) });
    close(db, { usedPct: 84, ...week(4) });
    close(db, { provider: "grok", usedPct: 35 });
    const baseline = getHistoryBaseline(db);
    expect(baseline.get("agy")).toBeCloseTo(11, 10);
    expect(baseline.get("grok")).toBeCloseTo(5, 10);
    expect(baseline.has("kimi")).toBe(false);
  });

  it("uses verified closes only when the pool contains at least one", () => {
    const db = openDb(":memory:"); migrate(db);
    close(db, { usedPct: 100, resetsAtEstimated: true, ...week(4) });
    close(db, { usedPct: 91, resetsAtEstimated: true, ...week(3) });
    close(db, { usedPct: 70, ...week(2) });
    expect(getHistoryBaseline(db).get("agy")).toBeCloseTo(10, 10);
  });

  it("falls back to all closes when none are verified", () => {
    const db = openDb(":memory:"); migrate(db);
    close(db, { usedPct: 35, resetsAtEstimated: true, ...week(4) });
    close(db, { usedPct: 49, resetsAtEstimated: true, ...week(3) });
    expect(getHistoryBaseline(db).get("agy")).toBeCloseTo(6, 10);
  });

  it("returns no entry without closes", () => {
    const db = openDb(":memory:"); migrate(db);
    expect(getHistoryBaseline(db).size).toBe(0);
  });

  it("uses only the four newest closes by default", () => {
    const db = openDb(":memory:"); migrate(db);
    close(db, { usedPct: 0, ...week(0) });
    close(db, { usedPct: 14, ...week(1) });
    close(db, { usedPct: 21, ...week(2) });
    close(db, { usedPct: 28, ...week(3) });
    close(db, { usedPct: 35, ...week(4) });
    expect(getHistoryBaseline(db).get("agy")).toBeCloseTo(3.5, 10);
  });

  it("honors a custom limit", () => {
    const db = openDb(":memory:"); migrate(db);
    close(db, { usedPct: 0, ...week(0) });
    close(db, { usedPct: 14, ...week(1) });
    close(db, { usedPct: 21, ...week(2) });
    close(db, { usedPct: 28, ...week(3) });
    close(db, { usedPct: 35, ...week(4) });
    expect(getHistoryBaseline(db, 2).get("agy")).toBeCloseTo(4.5, 10);
  });

  it("returns an empty map without the ledger table", () => {
    const db = openDb(":memory:");
    expect(getHistoryBaseline(db).size).toBe(0);
  });

  it("rates a window the provider reset early over the days it ran", () => {
    const db = openDb(":memory:"); migrate(db);
    const w = week(4);
    const start = Date.parse(w.periodStart);
    // 35% used, then reset 3.5 days into a 7-day window.
    close(db, {
      usedPct: 35,
      ...w,
      sampledAt: iso(start + 3.5 * DAY_MS),
      detectedAt: iso(start + 3.5 * DAY_MS + 15 * 60_000),
    });
    expect(getHistoryBaseline(db).get("agy")).toBeCloseTo(10, 10);
  });

  it("skips a close that ran under one day", () => {
    const db = openDb(":memory:"); migrate(db);
    const w = week(4);
    const start = Date.parse(w.periodStart);
    close(db, { usedPct: 16, ...w, sampledAt: iso(start + 0.5 * DAY_MS), detectedAt: iso(start + 0.5 * DAY_MS) });
    close(db, { usedPct: 70, ...week(3) });
    expect(getHistoryBaseline(db).get("agy")).toBeCloseTo(10, 10);
  });

  it("collapses closes of one window to the newest", () => {
    const db = openDb(":memory:"); migrate(db);
    const w = week(4);
    const start = Date.parse(w.periodStart);
    close(db, { usedPct: 11, ...w, sampledAt: iso(start + 2 * DAY_MS), detectedAt: iso(start + 2 * DAY_MS) });
    close(db, { usedPct: 11, ...w, sampledAt: iso(start + 2.1 * DAY_MS), detectedAt: iso(start + 2.1 * DAY_MS) });
    close(db, { usedPct: 84, ...w });
    expect(getHistoryBaseline(db).get("agy")).toBeCloseTo(12, 10);
  });

  it("treats resets an hour apart as one window", () => {
    const db = openDb(":memory:"); migrate(db);
    const w = week(4);
    const start = Date.parse(w.periodStart);
    // claude reports the same reset as 20:59 and 21:00.
    close(db, {
      usedPct: 49,
      periodStart: iso(start - 60_000),
      resetsAt: iso(Date.parse(w.resetsAt) - 60_000),
      sampledAt: iso(start + 3 * DAY_MS),
      detectedAt: iso(start + 3 * DAY_MS),
    });
    close(db, { usedPct: 70, ...w });
    expect(getHistoryBaseline(db).get("agy")).toBeCloseTo(10, 10);
  });

  it("ignores a close from the window still open", () => {
    const db = openDb(":memory:"); migrate(db);
    const open = week(5);
    const start = Date.parse(open.periodStart);
    close(db, { usedPct: 43, ...open, sampledAt: iso(start + 3 * DAY_MS), detectedAt: iso(start + 3 * DAY_MS) });
    close(db, { usedPct: 70, ...week(4) });
    const current = new Map([["agy", { resetsAt: open.resetsAt }]]);
    expect(getHistoryBaseline(db, 4, current).get("agy")).toBeCloseTo(10, 10);
    // Without the current window every close counts.
    expect(getHistoryBaseline(db).get("agy")).toBeCloseTo((43 / 3 + 10) / 2, 10);
  });

  it("keeps estimated closes apart even when their resets match", () => {
    const db = openDb(":memory:"); migrate(db);
    close(db, { usedPct: 35, resetsAtEstimated: true, ...week(4) });
    close(db, { usedPct: 49, resetsAtEstimated: true, ...week(4), detectedAt: iso(WEEK0) });
    const current = new Map([["agy", { resetsAt: week(4).resetsAt, resetsAtEstimated: true }]]);
    expect(getHistoryBaseline(db, 4, current).get("agy")).toBeCloseTo(6, 10);
  });
});
