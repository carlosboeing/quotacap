import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../../src/store/db.js";
import { recordAttempt, getAttempt, getAttempts } from "../../src/store/attempts.js";

describe("adapter attempts", () => {
  it("records attempted/completed/successful distinctly and retains across reopen", () => {
    const db = openDb(":memory:"); migrate(db);
    recordAttempt(db, { provider: "kimi", attemptedAt: "2026-09-07T06:00:00+10:00",
      completedAt: "2026-09-07T06:00:08+10:00", succeededAt: "2026-09-07T06:00:08+10:00",
      success: true, failureCategory: null });
    recordAttempt(db, { provider: "kimi", attemptedAt: "2026-09-07T06:15:00+10:00",
      completedAt: "2026-09-07T06:15:14+10:00", succeededAt: "2026-09-07T06:00:08+10:00",
      success: false, failureCategory: "timeout" });
    const got = getAttempt(db, "kimi")!;
    expect(got.success).toBe(false);
    expect(got.failureCategory).toBe("timeout");
    expect(got.succeededAt).toBe("2026-09-07T06:00:08+10:00"); // last success retained
    expect(getAttempts(db).map(a => a.provider)).toContain("kimi");
  });

  it("stores skips without raw output", () => {
    const db = openDb(":memory:"); migrate(db);
    recordAttempt(db, { provider: "manual", attemptedAt: "2026-09-07T06:00:00+10:00",
      completedAt: "2026-09-07T06:00:00+10:00", succeededAt: null, success: true, failureCategory: "skipped" });
    expect(getAttempt(db, "manual")!.failureCategory).toBe("skipped");
    const cols = (db.prepare(`PRAGMA table_info(adapter_attempts)`).all() as any[]).map(c => c.name);
    expect(JSON.stringify(cols)).not.toContain("raw");
  });
});
