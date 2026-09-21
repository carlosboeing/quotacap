import { openDb, migrate } from "../../src/store/db.js";
import { upsertQuota } from "../../src/store/quotas.js";
import { recordAttempt } from "../../src/store/attempts.js";
import { buildSnapshot } from "../../src/advisory/snapshot.js";
import type { StateSnapshot } from "../../src/advisory/types.js";

export const FIXED_NOW = new Date("2026-09-07T06:00:00+10:00");
export const RT = {
  available: true,
  ready: true,
  polling: "idle" as const,
  lastCompletedPollAt: "2026-09-07T05:45:00+10:00",
  version: "0.0.21",
};
export const ENABLED = ["claude", "codex", "kimi", "grok", "agy"];

export function buildFixtureDb(): any {
  const db = openDb(":memory:");
  migrate(db);
  const Q = (q: any) => upsertQuota(db, { plan: "p", source: "cli", ...q });
  Q({
    provider: "kimi",
    usedPct: 22,
    resetsAt: "2026-09-14T06:00:00+10:00",
    periodStart: "2026-08-31T06:00:00+10:00",
    fetchedAt: FIXED_NOW.toISOString(),
  });
  Q({
    provider: "claude",
    usedPct: 40,
    sessionPct: 22,
    resetsAt: "2026-09-14T06:00:00+10:00",
    periodStart: "2026-08-31T06:00:00+10:00",
    fetchedAt: FIXED_NOW.toISOString(),
  });
  Q({
    provider: "grok",
    usedPct: 30,
    resetsAt: "not-a-date",
    periodStart: "2026-08-31T06:00:00+10:00",
    fetchedAt: FIXED_NOW.toISOString(),
  });
  Q({
    provider: "codex",
    usedPct: 40,
    resetsAt: "2026-09-14T06:00:00+10:00",
    periodStart: "2026-08-31T06:00:00+10:00",
    fetchedAt: FIXED_NOW.toISOString(),
    resetsAtEstimated: true,
  });
  Q({
    provider: "my-plan",
    usedPct: 12,
    resetsAt: "2026-09-14T06:00:00+10:00",
    periodStart: "2026-08-31T06:00:00+10:00",
    fetchedAt: FIXED_NOW.toISOString(),
    source: "manual",
  });
  Q({
    provider: "agy",
    usedPct: 50,
    resetsAt: "2026-09-14T06:00:00+10:00",
    periodStart: "2026-09-07T06:00:00+10:00",
    fetchedAt: FIXED_NOW.toISOString(),
  });
  Q({
    provider: "agy:3p",
    usedPct: 60,
    resetsAt: "2026-09-14T06:00:00+10:00",
    periodStart: "2026-09-07T06:00:00+10:00",
    fetchedAt: "2026-09-07T03:00:00+10:00",
  });
  for (const p of ["kimi", "claude", "codex", "my-plan", "agy"]) {
    recordAttempt(db, {
      provider: p,
      attemptedAt: FIXED_NOW.toISOString(),
      completedAt: FIXED_NOW.toISOString(),
      succeededAt: FIXED_NOW.toISOString(),
      success: true,
      failureCategory: null,
    });
  }
  recordAttempt(db, {
    provider: "manual",
    attemptedAt: FIXED_NOW.toISOString(),
    completedAt: FIXED_NOW.toISOString(),
    succeededAt: null,
    success: true,
    failureCategory: "skipped",
  });
  return db;
}

export function buildStaleDb(): any {
  const db = buildFixtureDb();
  upsertQuota(db, {
    provider: "kimi",
    plan: "p",
    source: "cli",
    usedPct: 22,
    resetsAt: "2026-09-14T06:00:00+10:00",
    periodStart: "2026-08-31T06:00:00+10:00",
    fetchedAt: "2026-09-07T03:00:00+10:00",
  });
  return db;
}

export function buildResetPassedDb(): any {
  const db = buildFixtureDb();
  upsertQuota(db, {
    provider: "kimi",
    plan: "p",
    source: "cli",
    usedPct: 22,
    resetsAt: "2026-09-06T06:00:00+10:00",
    periodStart: "2026-08-31T06:00:00+10:00",
    fetchedAt: FIXED_NOW.toISOString(),
  });
  return db;
}

export function buildUnknownPaceDb(): any {
  const db = buildFixtureDb();
  upsertQuota(db, {
    provider: "kimi",
    plan: "p",
    source: "cli",
    usedPct: 22,
    resetsAt: "2026-09-14T06:00:00+10:00",
    periodStart: "2026-09-07T05:30:00+10:00",
    fetchedAt: FIXED_NOW.toISOString(),
  });
  return db;
}

export const exampleStateSnapshot: StateSnapshot = buildSnapshot(buildFixtureDb(), {
  enabledProviders: ENABLED,
  now: FIXED_NOW,
  runtime: RT,
});

export const staleStateSnapshot: StateSnapshot = buildSnapshot(buildStaleDb(), {
  enabledProviders: ENABLED,
  now: FIXED_NOW,
  runtime: RT,
});

export const resetPassedStateSnapshot: StateSnapshot = buildSnapshot(buildResetPassedDb(), {
  enabledProviders: ENABLED,
  now: FIXED_NOW,
  runtime: RT,
});

export const unknownPaceStateSnapshot: StateSnapshot = buildSnapshot(buildUnknownPaceDb(), {
  enabledProviders: ENABLED,
  now: FIXED_NOW,
  runtime: RT,
});

export const exampleStateSnapshotJson = JSON.stringify(exampleStateSnapshot, null, 2);
export const staleStateSnapshotJson = JSON.stringify(staleStateSnapshot, null, 2);
export const resetPassedStateSnapshotJson = JSON.stringify(resetPassedStateSnapshot, null, 2);
export const unknownPaceStateSnapshotJson = JSON.stringify(unknownPaceStateSnapshot, null, 2);

// OpenCode Go with an included month. At FIXED_NOW (2026-09-06T20:00Z) the
// week has 3.2 days left and the month 8.7 days, so monthly binds (5 left ÷
// 8.7d against 56 left ÷ 3.2d) while the weekly story stays Behind pace.
export const GO_MONTHLY_RESETS_AT = "2026-09-15T12:00:00.000Z"; // Tuesday

function addGo(db: any, status: "ok" | "exhausted"): void {
  upsertQuota(db, {
    provider: "opencode-go", plan: "unknown", source: "api",
    weeklyPct: 44, fiveHourPct: 12,
    resetsAt: "2026-09-10T00:00:00.000Z", periodStart: "2026-09-03T00:00:00.000Z",
    fetchedAt: FIXED_NOW.toISOString(),
    monthlyKind: "included", monthlyStatus: status,
    monthlyPct: status === "exhausted" ? 100 : 95,
    monthlyResetsAt: GO_MONTHLY_RESETS_AT,
  });
  recordAttempt(db, {
    provider: "opencode-go",
    attemptedAt: FIXED_NOW.toISOString(),
    completedAt: FIXED_NOW.toISOString(),
    succeededAt: FIXED_NOW.toISOString(),
    success: true,
    failureCategory: null,
  });
}

export function buildMonthlyDb(status: "ok" | "exhausted"): any {
  const db = openDb(":memory:");
  migrate(db);
  addGo(db, status);
  return db;
}

export function buildBoardMonthlyDb(): any {
  const db = buildFixtureDb();
  addGo(db, "ok");
  return db;
}

export const monthlyStateSnapshot: StateSnapshot = buildSnapshot(buildMonthlyDb("ok"), {
  enabledProviders: ["opencode-go"],
  now: FIXED_NOW,
  runtime: RT,
});
export const monthlyExhaustedStateSnapshot: StateSnapshot = buildSnapshot(buildMonthlyDb("exhausted"), {
  enabledProviders: ["opencode-go"],
  now: FIXED_NOW,
  runtime: RT,
});
export const boardMonthlyStateSnapshot: StateSnapshot = buildSnapshot(buildBoardMonthlyDb(), {
  enabledProviders: [...ENABLED, "opencode-go"],
  now: FIXED_NOW,
  runtime: RT,
});
export const monthlyStateSnapshotJson = JSON.stringify(monthlyStateSnapshot, null, 2);
export const monthlyExhaustedStateSnapshotJson = JSON.stringify(monthlyExhaustedStateSnapshot, null, 2);
export const boardMonthlyStateSnapshotJson = JSON.stringify(boardMonthlyStateSnapshot, null, 2);
