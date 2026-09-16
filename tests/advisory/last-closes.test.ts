import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../../src/store/db.js";
import { upsertQuota } from "../../src/store/quotas.js";
import {
  buildSnapshot,
  projectQuotasResponse,
  projectRecommendationResponse,
} from "../../src/advisory/snapshot.js";

const NOW = new Date("2026-09-07T06:00:00+10:00");
const RT = { available: true, ready: true, polling: "idle" as const, lastCompletedPollAt: "2026-09-07T05:45:00+10:00", version: "0.0.21" };

function quota(db: any, q: any) { upsertQuota(db, { plan: "p", source: "cli", ...q }); }

function withCloses(db: any, n: number, provider = "kimi") {
  const base = Date.parse("2026-06-01T02:20:00Z");
  const week = 7 * 86400000;
  const iso = (t: number) => new Date(t).toISOString();
  for (let i = 0; i < n; i++) {
    const at = base + i * week;
    quota(db, { provider, usedPct: 80 + i, resetsAt: iso(at + 5 * 60000), periodStart: iso(at - week + 5 * 60000), fetchedAt: iso(at) });
    quota(db, { provider, usedPct: 0, resetsAt: iso(at + week + 5 * 60000), periodStart: iso(at + 5 * 60000), fetchedAt: iso(at + 20 * 60000) });
  }
}

describe("lastCloses on the snapshot", () => {
  it("is always an array, empty with no closes", () => {
    const db = openDb(":memory:"); migrate(db);
    quota(db, { provider: "kimi", usedPct: 16, resetsAt: "2026-09-14T06:00:00+10:00", periodStart: "2026-08-31T06:00:00+10:00", fetchedAt: NOW.toISOString() });
    const s = buildSnapshot(db, { enabledProviders: ["kimi", "claude"], now: NOW, runtime: RT });
    expect(s.providers).toHaveLength(2);
    for (const p of s.providers) expect(p.lastCloses).toEqual([]);
  });

  it("carries newest-first closes capped at four", () => {
    const db = openDb(":memory:"); migrate(db);
    withCloses(db, 5);
    const s = buildSnapshot(db, { enabledProviders: ["kimi"], now: NOW, runtime: RT });
    const kimi = s.providers.find(p => p.id === "kimi")!;
    expect(kimi.lastCloses).toHaveLength(4);
    const base = Date.parse("2026-06-01T02:20:00Z");
    expect(kimi.lastCloses[0].detectedAt).toBe(new Date(base + 4 * 7 * 86400000 + 20 * 60000).toISOString());
    const times = kimi.lastCloses.map(c => Date.parse(c.detectedAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(kimi.lastCloses[0].leftoverPct).toBe(16);
  });

  it("projects lastCloses onto the quotas response", () => {
    const db = openDb(":memory:"); migrate(db);
    withCloses(db, 1);
    const s = buildSnapshot(db, { enabledProviders: ["kimi"], now: NOW, runtime: RT });
    const rows = projectQuotasResponse(s);
    const kimi = rows.find((r: any) => r.provider === "kimi")!;
    expect(kimi.lastCloses).toHaveLength(1);
    expect(kimi.lastCloses[0].leftoverPct).toBe(20);
  });

  it("leaves the recommendation payload untouched by closes", () => {
    const db = openDb(":memory:"); migrate(db);
    quota(db, { provider: "kimi", usedPct: 16, resetsAt: "2026-09-14T06:00:00+10:00", periodStart: "2026-08-31T06:00:00+10:00", fetchedAt: NOW.toISOString() });
    const before = buildSnapshot(db, { enabledProviders: ["kimi"], now: NOW, runtime: RT });
    db.prepare(
      `INSERT INTO window_closes(provider, plan, used_pct, leftover_pct, sampled_at, sampled_quota_id, period_start, resets_at, resets_at_estimated, detected_at, reason) VALUES('kimi','p',88,12,'2026-06-01T02:20:00Z',9999,'2026-05-25T02:25:00Z','2026-06-01T02:25:00Z',NULL,'2026-06-01T02:40:00Z','usage-drop')`,
    ).run();
    const after = buildSnapshot(db, { enabledProviders: ["kimi"], now: NOW, runtime: RT });
    expect(after.providers.find(p => p.id === "kimi")!.lastCloses).toHaveLength(1);
    const r = projectRecommendationResponse(after, "any");
    expect(r).toEqual(before.recommendation);
    expect(JSON.stringify(r)).not.toContain("leftover");
    expect((r as any).lastCloses).toBeUndefined();
  });
});
