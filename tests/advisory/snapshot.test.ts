import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../../src/store/db.js";
import { upsertQuota } from "../../src/store/quotas.js";
import { upsertCatalog } from "../../src/store/catalogs.js";
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

function close(db: any, provider: string, usedPct: number) {
  db.prepare(
    `INSERT INTO window_closes(provider, plan, used_pct, leftover_pct, sampled_at, sampled_quota_id, period_start, resets_at, resets_at_estimated, detected_at, reason) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
  ).run(provider, "p", usedPct, 100 - usedPct, NOW.toISOString(), 1, "2026-08-31T06:00:00+10:00", NOW.toISOString(), null, NOW.toISOString(), "usage-drop");
}

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

  it("joins model catalog: provider catalog filled, recommendation.models equals pick's list, each alternative has catalog", () => {
    const db = openDb(":memory:"); migrate(db);
    quota(db, { provider: "claude", usedPct: 80, resetsAt: "2026-09-14T06:00:00+10:00", periodStart: "2026-08-31T06:00:00+10:00", fetchedAt: NOW.toISOString() });
    quota(db, { provider: "kimi", usedPct: 20, resetsAt: "2026-09-14T06:00:00+10:00", periodStart: "2026-08-31T06:00:00+10:00", fetchedAt: NOW.toISOString() });

    upsertCatalog(db, "claude", [{ id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", default: true }], NOW.toISOString());
    upsertCatalog(db, "kimi", [{ id: "k3", displayName: "K3" }], NOW.toISOString());

    const s = buildSnapshot(db, { enabledProviders: ["claude", "kimi"], now: NOW, runtime: RT });

    const claude = s.providers.find((p) => p.id === "claude")!;
    expect(claude.catalog.status).toBe("ok");
    expect(claude.catalog.listed.map((m) => m.id)).toEqual(["claude-sonnet-4-6"]);

    const kimi = s.providers.find((p) => p.id === "kimi")!;
    expect(kimi.catalog.status).toBe("ok");
    expect(kimi.catalog.listed.map((m) => m.id)).toEqual(["k3"]);

    // Kimi is recommended (less usage, more headroom)
    expect(s.recommendation.use).toBe("kimi");
    expect(s.recommendation.models.map((m) => m.id)).toEqual(["k3"]);
    expect(s.recommendation.catalogStatus).toBe("ok");
    expect(s.recommendation.catalogFetchedAt).toBe(NOW.toISOString());

    expect(s.recommendation.alternatives.length).toBeGreaterThan(0);
    for (const alt of s.recommendation.alternatives) {
      expect(alt).toHaveProperty("catalog");
      expect(alt.catalog).toBeDefined();
    }
  });

  it("recommend() yields the same pick whether catalogs exist in DB or not", () => {
    const db1 = openDb(":memory:"); migrate(db1);
    const db2 = openDb(":memory:"); migrate(db2);

    quota(db1, { provider: "claude", usedPct: 80, resetsAt: "2026-09-14T06:00:00+10:00", periodStart: "2026-08-31T06:00:00+10:00", fetchedAt: NOW.toISOString() });
    quota(db1, { provider: "kimi", usedPct: 20, resetsAt: "2026-09-14T06:00:00+10:00", periodStart: "2026-08-31T06:00:00+10:00", fetchedAt: NOW.toISOString() });

    quota(db2, { provider: "claude", usedPct: 80, resetsAt: "2026-09-14T06:00:00+10:00", periodStart: "2026-08-31T06:00:00+10:00", fetchedAt: NOW.toISOString() });
    quota(db2, { provider: "kimi", usedPct: 20, resetsAt: "2026-09-14T06:00:00+10:00", periodStart: "2026-08-31T06:00:00+10:00", fetchedAt: NOW.toISOString() });

    upsertCatalog(db2, "claude", [{ id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" }], NOW.toISOString());
    upsertCatalog(db2, "kimi", [{ id: "k3", displayName: "K3" }], NOW.toISOString());

    const s1 = buildSnapshot(db1, { enabledProviders: ["claude", "kimi"], now: NOW, runtime: RT });
    const s2 = buildSnapshot(db2, { enabledProviders: ["claude", "kimi"], now: NOW, runtime: RT });

    expect(s1.recommendation.use).toBe(s2.recommendation.use);
    expect(s1.recommendation.reason).toBe(s2.recommendation.reason);
  });

  it("pre-catalog database without model_catalogs table succeeds with unfetched catalog", () => {
    const db = openDb(":memory:");
    // Do NOT call migrate(db). Create only the pre-catalog tables (no model_catalogs).
    db.exec(`
      CREATE TABLE IF NOT EXISTS quotas(id INTEGER PRIMARY KEY, provider TEXT, plan TEXT, used_pct REAL, resets_at TEXT, period_start TEXT, source TEXT, fetched_at TEXT, credits_usd REAL, resets_at_estimated INTEGER, session_pct REAL, monthly_pct REAL, monthly_resets_at TEXT, monthly_status TEXT, monthly_kind TEXT);
      CREATE TABLE IF NOT EXISTS snapshots(day TEXT, provider TEXT, used_pct REAL, burn_rate REAL, ideal_rate REAL, PRIMARY KEY(day, provider));
      CREATE TABLE IF NOT EXISTS adapter_attempts(provider TEXT PRIMARY KEY, attempted_at TEXT NOT NULL, completed_at TEXT, succeeded_at TEXT, success INTEGER NOT NULL, failure_category TEXT, diagnostic_code TEXT, summary TEXT, action TEXT, error_detail TEXT);
      CREATE INDEX IF NOT EXISTS idx_quotas_provider ON quotas(provider);
    `);
    quota(db, { provider: "claude", usedPct: 50, resetsAt: "2026-09-14T06:00:00+10:00", periodStart: "2026-08-31T06:00:00+10:00", fetchedAt: NOW.toISOString() });

    const s = buildSnapshot(db, { enabledProviders: ["claude"], now: NOW, runtime: RT });
    expect(s.providers[0].catalog.status).toBe("unfetched");
    expect(s.providers[0].catalog.listed).toEqual([]);
    expect(s.recommendation.catalogStatus).toBe("unfetched");
    expect(s.recommendation.models).toEqual([]);
  });

  it("wires the recent rate and the history baseline into the blended advisory", () => {
    const db = openDb(":memory:"); migrate(db);
    // Two polls six hours apart: 10% -> 16% is a 24%/day recent rate.
    quota(db, { provider: "kimi", usedPct: 10, resetsAt: "2026-09-14T06:00:00+10:00", periodStart: "2026-09-05T06:00:00+10:00", fetchedAt: "2026-09-07T00:00:00+10:00" });
    quota(db, { provider: "kimi", usedPct: 16, resetsAt: "2026-09-14T06:00:00+10:00", periodStart: "2026-09-05T06:00:00+10:00", fetchedAt: NOW.toISOString() });
    // One recorded close at 70% used over its week is a 10%/day baseline.
    close(db, "kimi", 70);
    const s = buildSnapshot(db, { enabledProviders: ["kimi"], now: NOW, runtime: RT });
    const adv = s.providers[0].advisory!;
    expect(adv.recentRate).toBeCloseTo(24, 5);
    expect(adv.baselineRate).toBeCloseTo(10, 5);
    expect(adv.burnRate).toBeCloseTo(17, 5); // 10 + 0.5 * (24 - 10)
    expect(adv.paceSource).toBe("recent");
    expect(adv.burnMeasured).toBe(true);
    expect(adv.status).toBe("watch");
  });

  it("ranks a verified impending deadline over an estimated phantom window", () => {
    const db = openDb(":memory:"); migrate(db);
    // Verified: 18h left, 2 polls 6h apart -> recent 8%/day, window average 9.6 -> blend 8.8, 33% waste.
    quota(db, { provider: "claude", usedPct: 58, resetsAt: "2026-09-08T00:00:00+10:00", periodStart: "2026-09-01T00:00:00+10:00", fetchedAt: "2026-09-07T00:00:00+10:00" });
    quota(db, { provider: "claude", usedPct: 60, resetsAt: "2026-09-08T00:00:00+10:00", periodStart: "2026-09-01T00:00:00+10:00", fetchedAt: NOW.toISOString() });
    // Estimated: a fictional 7d window whose phantom waste beats the real one.
    quota(db, { provider: "grok", usedPct: 9.5, resetsAt: "2026-09-14T06:00:00+10:00", periodStart: "2026-09-07T06:00:00+10:00", fetchedAt: "2026-09-07T00:00:00+10:00", resetsAtEstimated: true });
    quota(db, { provider: "grok", usedPct: 10, resetsAt: "2026-09-14T06:00:00+10:00", periodStart: "2026-09-07T06:00:00+10:00", fetchedAt: NOW.toISOString(), resetsAtEstimated: true });
    const s = buildSnapshot(db, { enabledProviders: ["claude", "grok"], now: NOW, runtime: RT });
    const claudeAdv = s.providers.find((p) => p.id === "claude")!.advisory!;
    const grokAdv = s.providers.find((p) => p.id === "grok")!.advisory!;
    expect(grokAdv.wastePct!).toBeGreaterThan(claudeAdv.wastePct!);
    expect(claudeAdv.aheadOfElapsed).toBe(false);
    expect(grokAdv.aheadOfElapsed).toBe(false);
    expect(s.recommendation.use).toBe("claude");
    expect(s.recommendation.recommendationBasis).toBe("known-waste");
  });

  it("emits null new advisory fields when pace is unknown", () => {
    const db = openDb(":memory:"); migrate(db);
    quota(db, { provider: "kimi", usedPct: 2, resetsAt: "2026-09-14T06:00:00+10:00", periodStart: "2026-09-07T05:30:00+10:00", fetchedAt: NOW.toISOString() });
    const s = buildSnapshot(db, { enabledProviders: ["kimi"], now: NOW, runtime: RT });
    const adv = s.providers[0].advisory!;
    expect(adv.burnRate).toBeNull();
    expect(adv.recentRate).toBeNull();
    expect(adv.baselineRate).toBeNull();
    expect(adv.aheadOfElapsed).toBeNull();
    const r = projectRecommendationResponse(s, "any");
    expect(r.advisories[0]).toHaveProperty("recentRate", null);
    expect(r.advisories[0]).toHaveProperty("baselineRate", null);
    expect(r.advisories[0]).toHaveProperty("aheadOfElapsed", null);
  });

  it("a junk stored monthly percent never invalidates the provider", () => {
    const db = openDb(":memory:"); migrate(db);
    const now = new Date("2026-09-21T08:00:00.000Z");
    upsertQuota(db, { provider: "opencode-go", plan: "unknown", source: "api", weeklyPct: 44,
      resetsAt: "2026-09-28T00:00:00.000Z", periodStart: "2026-09-21T00:00:00.000Z", fetchedAt: now.toISOString(),
      monthlyKind: "included", monthlyStatus: "ok", monthlyPct: 50, monthlyResetsAt: "2026-09-22T13:05:15.904Z" });
    db.exec(`UPDATE quotas SET monthly_pct = 'NaN'`);
    const s = buildSnapshot(db, { enabledProviders: ["opencode-go"], now,
      runtime: { available: true, ready: true, polling: "idle", lastCompletedPollAt: null, version: "test" } });
    const go = s.providers.find((p) => p.id === "opencode-go")!;
    expect(go.exclusionReason).toBeNull();
    expect(go.quota?.monthlyPct).toBeUndefined();
  });
});
