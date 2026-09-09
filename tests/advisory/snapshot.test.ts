import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../../src/store/db.js";
import { upsertQuota } from "../../src/store/quotas.js";
import { recordAttempt } from "../../src/store/attempts.js";
import { buildSnapshot } from "../../src/advisory/snapshot.js";

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
});
