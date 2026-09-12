import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../../src/store/db.js";
import { upsertQuota } from "../../src/store/quotas.js";
import { recordAttempt } from "../../src/store/attempts.js";
import {
  buildSnapshot,
  projectQuotasResponse,
  projectRecommendationResponse,
} from "../../src/advisory/snapshot.js";
import { providerIdentity } from "../../src/advisory/provider-names.js";

const NOW = new Date("2026-09-07T06:00:00+10:00");
const RT = { available: true, ready: true, polling: "idle" as const, lastCompletedPollAt: "2026-09-07T05:45:00+10:00", version: "0.0.21" };

function quota(db: any, q: any) { upsertQuota(db, { plan: "p", source: "cli", ...q }); }

describe("snapshot", () => {
  it("represents an enabled provider before its first reading", () => {
    const db = openDb(":memory:"); migrate(db);
    const s = buildSnapshot(db, { enabledProviders: ["claude", "kimi"], now: NOW, runtime: RT });
    const kimi = s.providers.find(p => p.id === "kimi")!;
    expect(kimi.quota).toBeNull();
    expect(kimi.exclusionReason).toBe("not-reporting");
    expect(kimi.reporting).toBe(false);
  });

  it("excludes stale and reset-passed rows from ranking but keeps last values", () => {
    const db = openDb(":memory:"); migrate(db);
    quota(db, { provider: "kimi", usedPct: 10, resetsAt: "2026-09-14T06:00:00+10:00", periodStart: "2026-08-31T06:00:00+10:00", fetchedAt: "2026-09-07T03:00:00+10:00" }); // 3h old
    quota(db, { provider: "claude", usedPct: 90, resetsAt: "2026-09-06T06:00:00+10:00", periodStart: "2026-08-30T06:00:00+10:00", fetchedAt: "2026-09-06T05:00:00+10:00" });
    const s = buildSnapshot(db, { enabledProviders: ["kimi", "claude"], now: NOW, runtime: RT });
    expect(s.providers.find(p => p.id === "kimi")!.exclusionReason).toBe("stale");
    expect(s.providers.find(p => p.id === "claude")!.exclusionReason).toBe("reset-passed");
    expect(s.providers.find(p => p.id === "kimi")!.quota!.usedPct).toBe(10); // visible
  });

  it("marks invalid dates and failed providers, labels estimated resets", () => {
    const db = openDb(":memory:"); migrate(db);
    quota(db, { provider: "grok", usedPct: 30, resetsAt: "not-a-date", periodStart: "2026-08-31T06:00:00+10:00", fetchedAt: NOW.toISOString() });
    quota(db, { provider: "codex", usedPct: 40, resetsAt: "2026-09-14T06:00:00+10:00", periodStart: "2026-08-31T06:00:00+10:00", fetchedAt: NOW.toISOString(), resetsAtEstimated: true });
    recordAttempt(db, { provider: "codex", attemptedAt: NOW.toISOString(), completedAt: NOW.toISOString(), succeededAt: null, success: false, failureCategory: "auth" });
    const s = buildSnapshot(db, { enabledProviders: ["grok", "codex"], now: NOW, runtime: RT });
    expect(s.providers.find(p => p.id === "grok")!.exclusionReason).toBe("invalid");
    const codex = s.providers.find(p => p.id === "codex")!;
    expect(codex.exclusionReason).toBe("provider-failed");
    expect(codex.evidence).toContain("estimated-reset");
  });

  it("keeps agy group rows independent", () => {
    const db = openDb(":memory:"); migrate(db);
    quota(db, { provider: "agy", usedPct: 50, resetsAt: "2026-09-14T06:00:00+10:00", periodStart: "2026-09-07T06:00:00+10:00", fetchedAt: NOW.toISOString() });
    quota(db, { provider: "agy:3p", usedPct: 60, resetsAt: "2026-09-14T06:00:00+10:00", periodStart: "2026-09-07T06:00:00+10:00", fetchedAt: "2026-09-07T03:00:00+10:00" });
    recordAttempt(db, { provider: "agy", attemptedAt: NOW.toISOString(), completedAt: NOW.toISOString(), succeededAt: NOW.toISOString(), success: true, failureCategory: null });
    const s = buildSnapshot(db, { enabledProviders: ["agy"], now: NOW, runtime: RT });
    expect(s.providers.find(p => p.id === "agy")!.reporting).toBe(true);
    expect(s.providers.find(p => p.id === "agy:3p")!.exclusionReason).toBe("stale");
  });

  it("converts legacy shapes additively", async () => {
    const db = openDb(":memory:"); migrate(db);
    quota(db, { provider: "kimi", usedPct: 16, sessionPct: 5, resetsAt: "2026-09-14T06:00:00+10:00", periodStart: "2026-08-31T06:00:00+10:00", fetchedAt: NOW.toISOString() });
    const s = buildSnapshot(db, { enabledProviders: ["kimi"], now: NOW, runtime: RT });
    const q = projectQuotasResponse(s);
    expect(q[0].provider).toBe("kimi");
    expect(q[0].sessionPct).toBe(5);
    expect(typeof q[0].stale).toBe("boolean");
    const r = projectRecommendationResponse(s, "any");
    expect(["kimi", "none"]).toContain(r.use);
    expect(r).toHaveProperty("advisories");
    expect(JSON.stringify(r)).not.toContain("Infinity");
  });

  it("carries agy group attempt fallback and null diagnostic fields on legacy attempts", () => {
    const db = openDb(":memory:"); migrate(db);
    quota(db, { provider: "agy", usedPct: 50, resetsAt: "2026-09-14T06:00:00+10:00", periodStart: "2026-09-07T06:00:00+10:00", fetchedAt: NOW.toISOString() });
    quota(db, { provider: "agy:3p", usedPct: 60, resetsAt: "2026-09-14T06:00:00+10:00", periodStart: "2026-09-07T06:00:00+10:00", fetchedAt: NOW.toISOString() });
    recordAttempt(db, {
      provider: "agy",
      attemptedAt: NOW.toISOString(),
      completedAt: NOW.toISOString(),
      succeededAt: null,
      success: false,
      failureCategory: "unknown",
      diagnosticCode: "terminal_error",
      summary: "Unable to open Antigravity session",
      action: "Check terminal",
      errorDetail: "pty exited during settle (code 1): stdin is not a terminal",
    });
    recordAttempt(db, {
      provider: "claude",
      attemptedAt: NOW.toISOString(),
      completedAt: NOW.toISOString(),
      succeededAt: null,
      success: false,
      failureCategory: "auth",
    });

    const s = buildSnapshot(db, { enabledProviders: ["agy", "claude"], now: NOW, runtime: RT });
    const agy = s.providers.find((p) => p.id === "agy")!;
    const agy3p = s.providers.find((p) => p.id === "agy:3p")!;
    const claude = s.providers.find((p) => p.id === "claude")!;

    expect(agy.lastAttempt?.diagnosticCode).toBe("terminal_error");
    expect(agy.lastAttempt?.summary).toBe("Unable to open Antigravity session");

    expect(agy3p.lastAttempt?.diagnosticCode).toBe("terminal_error");
    expect(agy3p.lastAttempt?.summary).toBe("Unable to open Antigravity session");
    expect(agy3p.lastAttempt?.errorDetail).toBe(agy.lastAttempt?.errorDetail);

    expect(claude.lastAttempt?.failureCategory).toBe("auth");
    expect(claude.lastAttempt?.diagnosticCode).toBeNull();
    expect(claude.lastAttempt?.summary).toBeNull();
    expect(claude.lastAttempt?.action).toBeNull();
    expect(claude.lastAttempt?.errorDetail).toBeNull();
    expect(claude.lastAttempt?.error).toBeNull();
    expect(claude.lastAttempt?.error).toBe(claude.lastAttempt?.errorDetail);
  });

  it("carries the naming fields on every provider row and the quotas projection", () => {
    const db = openDb(":memory:"); migrate(db);
    quota(db, { provider: "kimi", usedPct: 16, resetsAt: "2026-09-14T06:00:00+10:00", periodStart: "2026-08-31T06:00:00+10:00", fetchedAt: NOW.toISOString() });
    quota(db, { provider: "my-plan", usedPct: 12, resetsAt: "2026-09-14T06:00:00+10:00", periodStart: "2026-08-31T06:00:00+10:00", fetchedAt: NOW.toISOString(), source: "manual" });
    const s = buildSnapshot(db, { enabledProviders: ["kimi", "agy", "agy:3p"], now: NOW, runtime: RT });
    for (const p of s.providers) {
      expect(p.displayName.length).toBeGreaterThan(0);
      expect(p).toHaveProperty("vendor");
      expect(p).toHaveProperty("harness");
      expect(p).toHaveProperty("description");
    }
    expect(s.providers.find((p) => p.id === "kimi")!.displayName).toBe("Kimi");
    expect(s.providers.find((p) => p.id === "agy")!.displayName).toBe("Antigravity");
    expect(s.providers.find((p) => p.id === "agy:3p")!.displayName).toBe("Antigravity 3P");
    const unknown = s.providers.find((p) => p.id === "my-plan")!;
    expect(unknown.displayName).toBe("my-plan");
    expect(unknown.vendor).toBeNull();
    expect(unknown.harness).toBeNull();
    expect(unknown.description).toBeNull();
    for (const row of projectQuotasResponse(s)) {
      expect(row.displayName).toBe(providerIdentity(row.provider).displayName);
      for (const k of ["vendor", "harness", "description"]) {
        expect(k in row).toBe(true);
      }
    }
  });
});
