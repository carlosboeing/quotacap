import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../../src/store/db.js";
import { getCatalog, upsertCatalog, markCatalogFailure } from "../../src/store/catalogs.js";

function db() {
  const d = openDb(":memory:");
  migrate(d);
  return d;
}

describe("model_catalogs", () => {
  it("missing row is unfetched", () => {
    expect(getCatalog(db(), "agy:3p")).toEqual({
      status: "unfetched",
      fetchedAt: null,
      listed: [],
    });
  });

  it("upsert then read", () => {
    const d = db();
    upsertCatalog(d, "agy:3p", [{ id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6 (Thinking)" }], "2026-09-16T00:00:00.000Z");
    const v = getCatalog(d, "agy:3p");
    expect(v.status).toBe("ok");
    expect(v.listed[0].id).toBe("claude-sonnet-4-6");
    expect(v.fetchedAt).toBe("2026-09-16T00:00:00.000Z");
  });

  it("failed refresh keeps last list and fetched_at", () => {
    const d = db();
    upsertCatalog(d, "claude", [{ id: "opus", displayName: "opus" }], "2026-09-16T00:00:00.000Z");
    markCatalogFailure(d, "claude", {
      diagnosticCode: "timeout",
      summary: "timed out",
      action: "retry",
      errorDetail: "timeout",
    });
    const v = getCatalog(d, "claude");
    expect(v.status).toBe("stale");
    expect(v.listed).toEqual([{ id: "opus", displayName: "opus" }]);
    expect(v.fetchedAt).toBe("2026-09-16T00:00:00.000Z");
  });

  it("failure with no prior list is error and empty", () => {
    const d = db();
    markCatalogFailure(d, "muse", {
      diagnosticCode: "timeout",
      summary: "timed out",
      action: "retry",
      errorDetail: "timeout",
    });
    const v = getCatalog(d, "muse");
    expect(v.status).toBe("error");
    expect(v.listed).toEqual([]);
    expect(v.fetchedAt).toBeNull();
  });

  it("missing table is unfetched, not a throw", () => {
    const d = openDb(":memory:");
    d.exec(`CREATE TABLE quotas(id INTEGER PRIMARY KEY, provider TEXT, plan TEXT, used_pct REAL, resets_at TEXT, period_start TEXT, source TEXT, fetched_at TEXT, credits_usd REAL, resets_at_estimated INTEGER, session_pct REAL)`);
    d.exec(`CREATE TABLE adapter_attempts(provider TEXT PRIMARY KEY, attempted_at TEXT NOT NULL, completed_at TEXT, succeeded_at TEXT, success INTEGER NOT NULL, failure_category TEXT, diagnostic_code TEXT, summary TEXT, action TEXT, error_detail TEXT)`);
    expect(getCatalog(d, "claude").status).toBe("unfetched");
  });
});
