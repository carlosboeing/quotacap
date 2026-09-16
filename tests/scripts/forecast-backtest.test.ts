import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CONSTANTS,
  candidateVerdict,
  currentVerdict,
  loadDatasetFromJson,
  loadDatasetFromDb,
  runBacktest,
  formatReport,
} from "../../scripts/forecast-backtest.mjs";
import { computeAdvisory } from "../../src/advisory/engine.js";
import { BLEND_K, RISK_MARGIN, GATE_TOL } from "../../src/advisory/types.js";
import { openDb, migrate } from "../../src/store/db.js";
import type { Quota } from "../../src/adapters/types.js";

const scriptPath = fileURLToPath(new URL("../../scripts/forecast-backtest.mjs", import.meta.url));
const fixturePath = fileURLToPath(new URL("../fixtures/forecast-weeks.json", import.meta.url));
const fixtureRaw = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const dataset = loadDatasetFromJson(fixtureRaw);
const result = runBacktest(dataset);

const NOW = new Date("2026-09-16T00:00:00.000Z");

function quota(over: Partial<Quota> = {}): Quota {
  return {
    provider: "probe",
    plan: "p",
    usedPct: 50,
    periodStart: "2026-09-12T00:00:00.000Z",
    resetsAt: "2026-09-19T00:00:00.000Z",
    source: "cli",
    fetchedAt: NOW.toISOString(),
    ...over,
  } as Quota;
}

function closeOrNull(actual: number | null, expected: number | null) {
  if (expected === null) expect(actual).toBeNull();
  else expect(actual as number).toBeCloseTo(expected, 9);
}

function expectMirror(mirror: any, real: any) {
  expect(mirror.status).toBe(real.status);
  expect(mirror.urgency).toBe(real.urgency);
  expect(mirror.paceSource).toBe(real.paceSource);
  expect(mirror.burnMeasured).toBe(real.burnMeasured);
  expect(mirror.aheadOfElapsed).toBe(real.aheadOfElapsed);
  expect(mirror.daysToExhaust).toBe(real.daysToExhaust);
  expect(mirror.wastePct).toBe(real.wastePct);
  expect(mirror.burnRate).toBe(real.burnRate);
  expect(mirror.recentRate).toBe(real.recentRate);
  expect(mirror.baselineRate).toBe(real.baselineRate);
  closeOrNull(mirror.avgPace, real.avgPace);
  closeOrNull(mirror.daysLeft, real.daysLeft);
  closeOrNull(mirror.remaining, real.remaining);
  closeOrNull(mirror.idealRate, real.idealRate);
}

function dayOf(provider: string, day: string) {
  const found = result.days.find((d: any) => d.provider === provider && d.day === day);
  expect(found, `${provider} ${day} verdict present`).toBeTruthy();
  return found!;
}

const tempDbs: string[] = [];

afterEach(() => {
  while (tempDbs.length) {
    const p = tempDbs.pop()!;
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      try {
        fs.rmSync(p + suffix, { force: true });
      } catch {}
    }
  }
});

function tempDbPath(): string {
  const p = path.join(os.tmpdir(), `quotacap-backtest-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  tempDbs.push(p);
  return p;
}

/** Materializes the JSON fixture as a real SQLite DB (the recorded-receipt path). */
function writeFixtureDb(): string {
  const dbPath = tempDbPath();
  const db = openDb(dbPath) as any;
  migrate(db);
  const insQ = db.prepare(
    `INSERT INTO quotas(id, provider, plan, used_pct, resets_at, period_start, source, fetched_at, resets_at_estimated)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  for (const q of fixtureRaw.quotas) {
    insQ.run(q.id, q.provider, q.plan, q.usedPct, q.resetsAt, q.periodStart, q.source, q.fetchedAt, q.resetsAtEstimated ? 1 : null);
  }
  const insC = db.prepare(
    `INSERT INTO window_closes(id, provider, plan, used_pct, leftover_pct, sampled_at, sampled_quota_id, period_start, resets_at, resets_at_estimated, detected_at, reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const c of fixtureRaw.windowCloses) {
    insC.run(c.id, c.provider, c.plan, c.usedPct, c.leftoverPct, c.sampledAt, c.id, c.periodStart, c.resetsAt, c.resetsAtEstimated ? 1 : null, c.detectedAt, c.reason);
  }
  db.close();
  return dbPath;
}

function emptyDb(): string {
  const dbPath = tempDbPath();
  const db = openDb(dbPath) as any;
  migrate(db);
  db.close();
  return dbPath;
}

describe("forecast backtest — shipped constants", () => {
  it("mirrors src/advisory/types.ts", () => {
    expect(DEFAULT_CONSTANTS).toEqual({ K: BLEND_K, M: RISK_MARGIN, T: GATE_TOL });
  });
});

describe("forecast backtest — verdict mirrors", () => {
  const cases: Array<[string, Quota, number | null, number | null]> = [
    ["over and gated -> at risk", quota({ usedPct: 65 }), 40, 20],
    ["over behind elapsed -> gate fails", quota({ usedPct: 30 }), 40, 20],
    ["marginal band", quota({ usedPct: 50 }), 16, 16],
    ["on track", quota({ usedPct: 50 }), 10, 10],
    ["estimated ceiling", quota({ usedPct: 65, resetsAtEstimated: true }), 40, 20],
    ["estimated exhausted stays red", quota({ usedPct: 100, resetsAtEstimated: true }), 0, 0],
    ["verified exhausted", quota({ usedPct: 100 }), 0, 0],
    ["no forecast inputs", quota({ usedPct: 50 }), null, null],
    ["no forecast inputs, exhausted", quota({ usedPct: 100 }), null, null],
    ["missing window start", quota({ usedPct: 50, periodStart: "" as any }), 20, 10],
  ];

  it("candidateVerdict matches computeAdvisory field for field", () => {
    for (const [label, q, recent, baseline] of cases) {
      const mirror = candidateVerdict(q, recent, baseline, NOW, DEFAULT_CONSTANTS);
      const real = computeAdvisory(q, recent, baseline, NOW);
      expectMirror(mirror, real);
      // A failed field check names the case through the assertion above.
      expect(label).toBeTruthy();
    }
  });

  it("candidateVerdict honors a moved margin and tolerance", () => {
    const q = quota({ usedPct: 65 });
    const shipped = candidateVerdict(q, 40, 20, NOW, DEFAULT_CONSTANTS);
    expect(shipped.status).toBe("at risk");
    // A larger margin loosens `over` until the same inputs read watch.
    const loose = candidateVerdict(q, 20, 20, NOW, { K: 0.5, M: 0.9, T: 0.1 });
    expect(loose.status).toBe("watch");
  });

  it("currentVerdict reproduces the pre-blend formula: red iff dte < daysLeft, no margin, no gate", () => {
    const gated = currentVerdict(quota({ usedPct: 65 }), 40, 20, NOW);
    expect(gated.status).toBe("at risk");
    const behind = currentVerdict(quota({ usedPct: 30 }), 40, 20, NOW);
    expect(behind.status).toBe("at risk"); // no gate: cumulative position ignored
    expect(behind.daysToExhaust).toBeCloseTo(70 / 40, 9);
    const marginal = currentVerdict(quota({ usedPct: 50 }), 16, 16, NOW);
    expect(marginal.status).toBe("on track"); // no deadband
    const exhausted = currentVerdict(quota({ usedPct: 100, resetsAtEstimated: true }), 0, 0, NOW);
    expect(exhausted.status).toBe("at risk");
    expect(exhausted.daysToExhaust).toBe(0);
    const unknown = currentVerdict(quota(), null, null, NOW);
    expect(unknown.status).toBe("unknown");
  });
});

describe("forecast-weeks fixture — recorded receipts", () => {
  it("labels each week from its close receipt", () => {
    expect(result.weeks.map((w: any) => [w.provider, w.sampledAt.slice(0, 10), w.label])).toEqual([
      ["alpha", "2026-08-09", "clearly-not-capped"],
      ["alpha", "2026-08-16", "clearly-not-capped"],
      ["alpha", "2026-08-23", "capped"],
      ["bravo", "2026-08-09", "clearly-not-capped"],
      ["bravo", "2026-08-16", "clearly-not-capped"],
      ["bravo", "2026-08-23", "capped"],
      ["charlie", "2026-08-09", "clearly-not-capped"],
      ["charlie", "2026-08-16", "clearly-not-capped"],
      ["charlie", "2026-08-23", "capped"],
    ]);
    expect(result.receiptCount).toBe(9);
    expect(result.evaluable).toBe(true);
  });

  it("stratifies estimated clocks from the receipts and the day rows", () => {
    const charlie = result.weeks.filter((w: any) => w.provider === "charlie");
    expect(charlie.map((w: any) => w.estimated)).toEqual([true, true, true]);
    const verified = result.weeks.filter((w: any) => w.provider !== "charlie");
    expect(verified.map((w: any) => w.estimated)).toEqual([false, false, false, false, false, false]);
    expect(dayOf("charlie", "2026-08-14").estimated).toBe(true);
    expect(dayOf("bravo", "2026-08-12").estimated).toBe(false);
  });

  it("replays a verdict per provider-day, exposing only data at or before each boundary", () => {
    expect(result.days).toHaveLength(66); // 22 days x 3 providers
    const first = dayOf("alpha", "2026-08-03");
    expect(first.asOf).toBe("2026-08-04T00:00:00.000Z");
    expect(first.candidate.recentRate).toBeCloseTo(8, 9);
    expect(first.candidate.baselineRate).toBeCloseTo(8, 9);
    expect(first.candidate.status).toBe("on track");
    expect(first.current.status).toBe("on track");
  });

  it("keeps the steady week out of red under both formulas", () => {
    const steady = dayOf("alpha", "2026-08-09");
    expect(steady.candidate.status).toBe("on track");
    expect(steady.current.status).toBe("on track");
    expect(steady.label).toBe("clearly-not-capped");
  });

  it("halves the spike into watch where the current formula reds", () => {
    const spike = dayOf("bravo", "2026-08-12");
    expect(spike.label).toBe("clearly-not-capped");
    expect(spike.candidate.burnRate).toBeCloseTo(13, 9); // 6 + 0.5 * (20 - 6)
    expect(spike.candidate.status).toBe("watch");
    expect(spike.candidate.daysToExhaust).toBeCloseTo(55 / 13, 6);
    expect(spike.current.status).toBe("at risk");
    expect(spike.current.daysToExhaust).toBeCloseTo(55 / 20, 6);
  });

  it("keeps a behind-elapsed surge out of red (estimated clock)", () => {
    const surge = dayOf("charlie", "2026-08-13");
    expect(surge.label).toBe("clearly-not-capped");
    expect(surge.candidate.status).toBe("on track");
    expect(surge.current.status).toBe("at risk");
    expect(surge.current.daysToExhaust).toBeCloseTo(60 / 25, 6);
  });

  it("caps estimated clocks at watch, red only when exhausted", () => {
    const ceiling = dayOf("charlie", "2026-08-17");
    expect(ceiling.candidate.status).toBe("watch");
    expect(ceiling.candidate.daysToExhaust).toBeGreaterThan(0);
    expect(ceiling.current.status).toBe("at risk");
    const exhausted = dayOf("charlie", "2026-08-20");
    expect(exhausted.candidate.status).toBe("at risk");
    expect(exhausted.current.status).toBe("at risk");
  });

  it("reds a verified capped week in its final days", () => {
    const sprint = dayOf("alpha", "2026-08-17");
    expect(sprint.candidate.status).toBe("at risk");
    expect(sprint.current.status).toBe("at risk");
    const close = dayOf("alpha", "2026-08-23");
    expect(close.candidate.status).toBe("at risk");
    expect(close.current.status).toBe("at risk");
  });

  it("catches a late taper the current formula misses", () => {
    const rescue = dayOf("bravo", "2026-08-21");
    expect(rescue.daysToClose).toBeCloseTo(2, 9);
    expect(rescue.candidate.status).toBe("at risk");
    expect(rescue.current.status).toBe("on track");
    const quiet = dayOf("bravo", "2026-08-23");
    expect(quiet.candidate.status).toBe("on track");
    expect(quiet.current.status).toBe("on track");
  });

  it("leaves the trailing in-flight day unlabeled", () => {
    const trailing = dayOf("alpha", "2026-08-24");
    expect(trailing.label).toBe("unlabeled");
    expect(trailing.weekId).toBeNull();
    expect(trailing.daysToClose).toBeNull();
  });
});

describe("forecast-weeks fixture — scores", () => {
  it("counts false-red provider-days, stratified by clock", () => {
    expect(result.scores.current.falseRedDays).toEqual({ total: 2, verified: 1, estimated: 1 });
    expect(result.scores.candidate.falseRedDays).toEqual({ total: 0, verified: 0, estimated: 0 });
  });

  it("counts missed caps (no red in a capped week's final 3 days), stratified", () => {
    expect(result.scores.current.missedCaps).toEqual({ total: 1, verified: 1, estimated: 0 });
    expect(result.scores.candidate.missedCaps).toEqual({ total: 0, verified: 0, estimated: 0 });
  });

  it("means |dte - actual| on capped weeks, stratified, excluding non-finite forecasts", () => {
    expect(result.scores.candidate.dteSamples).toEqual({ total: 21, verified: 14, estimated: 7 });
    expect(result.scores.current.dteSamples).toEqual({ total: 21, verified: 14, estimated: 7 });
    expect(result.scores.candidate.meanAbsDteError.total!).toBeCloseTo(1.8, 1);
    expect(result.scores.candidate.meanAbsDteError.verified!).toBeCloseTo(1.67, 1);
    expect(result.scores.candidate.meanAbsDteError.estimated!).toBeCloseTo(2.08, 1);
    expect(result.scores.current.meanAbsDteError.total!).toBeCloseTo(2.63, 1);
    expect(result.scores.current.meanAbsDteError.verified!).toBeCloseTo(2.73, 1);
    expect(result.scores.current.meanAbsDteError.estimated!).toBeCloseTo(2.43, 1);
  });

  it("reports the ship gate as false-red fall with no new missed caps", () => {
    expect(result.gate).toEqual({ falseRedFall: 2, newMissedCaps: -1, pass: true });
  });

  it("reports not evaluable when the ledger holds no close receipts", () => {
    const empty = runBacktest({ quotas: [], closes: [] });
    expect(empty.evaluable).toBe(false);
    expect(empty.receiptCount).toBe(0);
    expect(empty.days).toEqual([]);
    expect(empty.scores.candidate.falseRedDays.total).toBe(0);
    expect(empty.scores.candidate.meanAbsDteError.total).toBeNull();
    expect(empty.gate.pass).toBe(false);
    expect(formatReport(empty)).toContain("not evaluable — 0 recorded close receipts");
  });
});

describe("forecast backtest — SQLite path", () => {
  it("reads quotas and window_closes read-only and replays the fixture identically", () => {
    const dbPath = writeFixtureDb();
    const before = fs.readFileSync(dbPath);
    const fromDb = runBacktest(loadDatasetFromDb(dbPath));
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
    expect(fromDb.receiptCount).toBe(9);
    expect(fromDb.scores).toEqual(result.scores);
    expect(fromDb.days).toEqual(result.days);
  });

  it("refuses a missing database instead of creating one", () => {
    const missing = path.join(os.tmpdir(), `quotacap-backtest-missing-${Date.now()}.db`);
    expect(() => loadDatasetFromDb(missing)).toThrow();
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("runs the CLI against a DB: report exits 0, JSON carries the scores", () => {
    const dbPath = writeFixtureDb();
    const report = spawnSync(process.execPath, [scriptPath, "--db", dbPath], { encoding: "utf8" });
    expect(report.status).toBe(0);
    expect(report.stdout).toContain("candidate");
    expect(report.stdout).toContain("false-red");

    const json = spawnSync(process.execPath, [scriptPath, "--db", dbPath, "--json"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(json.status).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.evaluable).toBe(true);
    expect(parsed.scores.candidate.falseRedDays.total).toBe(0);
    expect(parsed.scores.current.falseRedDays.total).toBe(2);
  });

  it("exits 3 with a not-evaluable line when the ledger has no receipts", () => {
    const dbPath = emptyDb();
    const cli = spawnSync(process.execPath, [scriptPath, "--db", dbPath], { encoding: "utf8" });
    expect(cli.status).toBe(3);
    expect(cli.stdout).toContain("not evaluable — 0 recorded close receipts");
  });
});
