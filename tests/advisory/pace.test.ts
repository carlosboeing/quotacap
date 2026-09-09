import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../../src/store/db.js";
import { getBurnRates, upsertQuota } from "../../src/store/quotas.js";
import { averagePace } from "../../src/advisory/engine.js";
import { parseGrokTui } from "../../src/adapters/grok.js";

const NOW = new Date("2026-09-07T06:00:00+10:00");

function row(db: any, used: number, fetchedIso: string, periodStart = "2026-08-31T06:00:00+10:00", resets = "2026-09-14T06:00:00+10:00") {
  db.prepare(`INSERT INTO quotas(provider, plan, used_pct, resets_at, period_start, source, fetched_at) VALUES('kimi','p',?,'${resets}','${periodStart}','cli',?)`).run(used, fetchedIso);
}

describe("current-cycle pace", () => {
  it("measures within the current window", () => {
    const db = openDb(":memory:"); migrate(db);
    row(db, 20, "2026-09-06T06:00:00+10:00"); row(db, 44, "2026-09-07T06:00:00+10:00");
    expect(getBurnRates(db, NOW.getTime()).get("kimi")).toBeCloseTo(24, 0);
  });

  it("ignores pre-reset rows (usage fell after reset)", () => {
    const db = openDb(":memory:"); migrate(db);
    row(db, 90, "2026-09-06T04:00:00+10:00", "2026-08-24T06:00:00+10:00", "2026-08-31T06:00:00+10:00");
    row(db, 10, "2026-09-07T06:00:00+10:00", "2026-08-31T06:00:00+10:00", "2026-09-14T06:00:00+10:00");
    expect(getBurnRates(db, NOW.getTime()).has("kimi")).toBe(false);
  });

  it("ignores pre-reset rows when usage increased across reset boundary", () => {
    const db = openDb(":memory:"); migrate(db);
    row(db, 5, "2026-09-06T12:00:00+10:00", "2026-08-24T06:00:00+10:00", "2026-08-31T06:00:00+10:00");
    row(db, 10, "2026-09-07T06:00:00+10:00", "2026-08-31T06:00:00+10:00", "2026-09-14T06:00:00+10:00");
    expect(getBurnRates(db, NOW.getTime()).has("kimi")).toBe(false);
  });

  it("ignores rows fetched in the future", () => {
    const db = openDb(":memory:"); migrate(db);
    row(db, 10, "2026-09-07T05:00:00+10:00");
    row(db, 20, "2026-09-07T08:00:00+10:00"); // future relative to NOW (06:00)
    expect(getBurnRates(db, NOW.getTime()).has("kimi")).toBe(false);
  });

  it("keeps the one-hour minimum on the window average", () => {
    expect(averagePace({ provider: "kimi", usedPct: 1, periodStart: "2026-09-07T05:30:00+10:00" } as any, NOW)).toBeNull();
    expect(averagePace({ provider: "kimi", usedPct: 60, periodStart: "2026-09-04T06:00:00+10:00" } as any, NOW)).toBeCloseTo(20, 5);
  });

  it("keeps history when the adapter estimates the reset", () => {
    const db = openDb(":memory:"); migrate(db);
    const tui = (pct: number) => `Weekly limit (SuperGrok) ${pct}% used\n`;
    upsertQuota(db, parseGrokTui(tui(20), new Date("2026-09-07T02:00:00+10:00")));
    upsertQuota(db, parseGrokTui(tui(30), new Date("2026-09-07T06:00:00+10:00")));
    // periodStart moves with each poll, so only a cycle guard that reads
    // resetsAt keeps the earlier reading: 10% over 4 hours is 60%/day.
    expect(getBurnRates(db, NOW.getTime()).get("grok")).toBeCloseTo(60, 5);
  });

  it("skips rows with invalid fetchedAt", () => {
    const db = openDb(":memory:"); migrate(db);
    row(db, 20, "not-a-date"); row(db, 44, "2026-09-07T06:00:00+10:00");
    expect(getBurnRates(db, NOW.getTime()).has("kimi")).toBe(false);
  });
});
