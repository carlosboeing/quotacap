import { describe, it, expect } from "vitest";
import { handleTool } from "../../src/mcp/server.js";
import { buildApp, testCtx } from "../../src/http/server.js";
import { openDb, migrate } from "../../src/store/db.js";
import { upsertQuota } from "../../src/store/quotas.js";

describe("mcp get_quotas", () => {
  it("renders the shared markdown table for quota status", async () => {
    const db = openDb(":memory:"); migrate(db);
    upsertQuota(db, {provider:"claude",plan:"max",usedPct:40,resetsAt:"2026-09-03T21:00:00+10:00",periodStart:"2026-08-26T00:00:00Z",source:"cli" as const,fetchedAt:new Date().toISOString()});
    const app = buildApp(testCtx(db));
    const addr = await app.listen({ port: 0, host: "127.0.0.1" });
    process.env.QUOTACAP_URL = addr;
    try {
      const res: any = await handleTool("get_quotas", {});
      expect(res.isError).toBeUndefined();
      expect(res.content[0].text).toBe(
        [
          "| Provider | Used | Elapsed | Resets | State | Forecast |",
          "|---|---|---|---|---|---|",
          "| claude | 40% | 100% | passed | Not reporting | reset passed — awaiting fresh window |",
        ].join("\n"),
      );
      const rows = JSON.parse(res.content[1].text);
      expect(rows).toHaveLength(1);
      expect(rows[0].provider).toBe("claude");
      expect(rows[0].exclusionReason).toBe("reset-passed");
      expect(rows[0].displayName).toBe("Claude");
      for (const k of ["displayName", "vendor", "harness", "description"]) {
        expect(k in rows[0]).toBe(true);
      }
    } finally {
      delete process.env.QUOTACAP_URL;
      await app.close();
    }
  });

  it("mcp get_quotas does not leak raw and includes creditsUsd", async () => {
    const db = openDb(":memory:"); migrate(db);
    upsertQuota(db, {provider:"grok",plan:"SuperGrok",usedPct:30,resetsAt:"2026-09-07T00:22:00Z",periodStart:"2026-08-31T00:22:00Z",source:"tui" as const,fetchedAt:new Date().toISOString(),creditsUsd:4.85, raw:"secret"} as any);
    const app = buildApp(testCtx(db));
    const addr = await app.listen({ port: 0, host: "127.0.0.1" });
    process.env.QUOTACAP_URL = addr;
    try {
      const res: any = await handleTool("get_quotas", {});
      const jsonText = res.content[1]?.text ?? res.content[0].text;
      expect(jsonText).not.toContain("secret");
      expect(jsonText).not.toContain("\"raw\"");
      const parsed = JSON.parse(jsonText);
      expect(parsed[0].creditsUsd).toBe(4.85);
      expect(parsed[0].raw).toBeUndefined();
      for (const k of ["stale", "ageMs", "evidence", "exclusionReason"]) {
        expect(k in parsed[0]).toBe(true);
      }
    } finally {
      delete process.env.QUOTACAP_URL;
      await app.close();
    }
  });
});
