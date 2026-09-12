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

  it("records diagnostic fields for failure and exposes error alias equal to errorDetail", () => {
    const db = openDb(":memory:"); migrate(db);
    recordAttempt(db, {
      provider: "claude",
      attemptedAt: "2026-09-07T06:00:00+10:00",
      completedAt: "2026-09-07T06:00:05+10:00",
      succeededAt: null,
      success: false,
      failureCategory: "unknown",
      diagnosticCode: "terminal_error",
      summary: "Unable to open Claude session",
      action: "Check your terminal",
      errorDetail: "pty exited during settle (code 1): stdin is not a terminal",
    });

    const got = getAttempt(db, "claude")!;
    expect(got.success).toBe(false);
    expect(got.failureCategory).toBe("unknown");
    expect(got.diagnosticCode).toBe("terminal_error");
    expect(got.summary).toBe("Unable to open Claude session");
    expect(got.action).toBe("Check your terminal");
    expect(got.errorDetail).toBe("pty exited during settle (code 1): stdin is not a terminal");
    expect(got.error).toBe(got.errorDetail);

    const all = getAttempts(db);
    const claudeAttempt = all.find(a => a.provider === "claude")!;
    expect(claudeAttempt.diagnosticCode).toBe("terminal_error");
    expect(claudeAttempt.errorDetail).toBe("pty exited during settle (code 1): stdin is not a terminal");
    expect(claudeAttempt.error).toBe(claudeAttempt.errorDetail);
  });

  it("clears diagnostic fields after subsequent success", () => {
    const db = openDb(":memory:"); migrate(db);
    recordAttempt(db, {
      provider: "codex",
      attemptedAt: "2026-09-07T06:00:00+10:00",
      completedAt: "2026-09-07T06:00:05+10:00",
      succeededAt: null,
      success: false,
      failureCategory: "auth",
      diagnosticCode: "auth",
      summary: "Login required",
      action: "Run login",
      errorDetail: "unauthorized",
    });

    recordAttempt(db, {
      provider: "codex",
      attemptedAt: "2026-09-07T06:10:00+10:00",
      completedAt: "2026-09-07T06:10:03+10:00",
      succeededAt: "2026-09-07T06:10:03+10:00",
      success: true,
      failureCategory: null,
    });

    const got = getAttempt(db, "codex")!;
    expect(got.success).toBe(true);
    expect(got.failureCategory).toBeNull();
    expect(got.diagnosticCode).toBeNull();
    expect(got.summary).toBeNull();
    expect(got.action).toBeNull();
    expect(got.errorDetail).toBeNull();
    expect(got.error).toBeNull();
    expect(got.succeededAt).toBe("2026-09-07T06:10:03+10:00");
  });

  it("clears diagnostic fields after subsequent skip", () => {
    const db = openDb(":memory:"); migrate(db);
    recordAttempt(db, {
      provider: "grok",
      attemptedAt: "2026-09-07T06:00:00+10:00",
      completedAt: "2026-09-07T06:00:05+10:00",
      succeededAt: null,
      success: false,
      failureCategory: "unknown",
      diagnosticCode: "terminal_error",
      summary: "Terminal error",
      action: "Check terminal",
      errorDetail: "not a tty",
    });

    recordAttempt(db, {
      provider: "grok",
      attemptedAt: "2026-09-07T06:10:00+10:00",
      completedAt: "2026-09-07T06:10:00+10:00",
      succeededAt: null,
      success: true,
      failureCategory: "skipped",
    });

    const got = getAttempt(db, "grok")!;
    expect(got.success).toBe(true);
    expect(got.failureCategory).toBe("skipped");
    expect(got.diagnosticCode).toBeNull();
    expect(got.summary).toBeNull();
    expect(got.action).toBeNull();
    expect(got.errorDetail).toBeNull();
    expect(got.error).toBeNull();
  });

  it("replaces previous diagnosis on new failure", () => {
    const db = openDb(":memory:"); migrate(db);
    recordAttempt(db, {
      provider: "kimi",
      attemptedAt: "2026-09-07T06:00:00+10:00",
      completedAt: "2026-09-07T06:00:05+10:00",
      succeededAt: null,
      success: false,
      failureCategory: "auth",
      diagnosticCode: "auth",
      summary: "Login required",
      action: "Run login",
      errorDetail: "unauthorized",
    });

    recordAttempt(db, {
      provider: "kimi",
      attemptedAt: "2026-09-07T06:10:00+10:00",
      completedAt: "2026-09-07T06:10:05+10:00",
      succeededAt: null,
      success: false,
      failureCategory: "unknown",
      diagnosticCode: "terminal_error",
      summary: "Terminal error",
      action: "Check terminal",
      errorDetail: "not a tty",
    });

    const got = getAttempt(db, "kimi")!;
    expect(got.diagnosticCode).toBe("terminal_error");
    expect(got.summary).toBe("Terminal error");
    expect(got.action).toBe("Check terminal");
    expect(got.errorDetail).toBe("not a tty");
    expect(got.error).toBe("not a tty");
  });

  it("defaults missing diagnostic columns on legacy schema to null and maintains alias equality", () => {
    const db = openDb(":memory:");
    // Legacy schema directly created without new columns
    db.exec(`CREATE TABLE adapter_attempts(provider TEXT PRIMARY KEY, attempted_at TEXT NOT NULL, completed_at TEXT, succeeded_at TEXT, success INTEGER NOT NULL, failure_category TEXT)`);
    db.exec(`INSERT INTO adapter_attempts(provider, attempted_at, completed_at, succeeded_at, success, failure_category)
      VALUES('legacy_p', '2026-09-07T06:00:00Z', '2026-09-07T06:00:05Z', NULL, 0, 'parse')`);

    const got = getAttempt(db, "legacy_p")!;
    expect(got.failureCategory).toBe("parse");
    expect(got.diagnosticCode).toBeNull();
    expect(got.summary).toBeNull();
    expect(got.action).toBeNull();
    expect(got.errorDetail).toBeNull();
    expect(got.error).toBeNull();
    expect(got.error).toBe(got.errorDetail);
  });

  it("does not treat error property as an independent write source", () => {
    const db = openDb(":memory:"); migrate(db);
    recordAttempt(db, {
      provider: "codex",
      attemptedAt: "2026-09-07T06:00:00+10:00",
      completedAt: "2026-09-07T06:00:05+10:00",
      succeededAt: null,
      success: false,
      failureCategory: "unknown",
      error: "spoofed error",
    } as any);

    const got = getAttempt(db, "codex")!;
    expect(got.errorDetail).toBeNull();
    expect(got.error).toBeNull();
  });
});
