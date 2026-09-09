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
