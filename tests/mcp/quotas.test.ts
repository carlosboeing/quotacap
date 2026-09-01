import { describe, it, expect } from "vitest";
import { handleTool } from "../../src/mcp/server.js";
import { buildApp } from "../../src/http/server.js";
import { openDb, migrate } from "../../src/store/db.js";
import { upsertQuota } from "../../src/store/quotas.js";

describe("mcp get_quotas", () => {
  it("renders the shared table for quota status", async () => {
    const db = openDb(":memory:"); migrate(db);
    upsertQuota(db, {provider:"claude",plan:"max",usedPct:40,resetsAt:"2026-09-03T21:00:00+10:00",periodStart:"2026-08-26T00:00:00Z",raw:"x",source:"cli" as const,fetchedAt:new Date().toISOString()});
    const app = buildApp(db);
    const addr = await app.listen({ port: 0, host: "127.0.0.1" });
    process.env.QUOTACAP_URL = addr;
    try {
      const res: any = await handleTool("get_quotas", {});
      expect(res.content[0].text).toMatch(/\| Provider \| Used \| Left \| Resets \| Days left \|/);
      expect(res.content[0].text).toMatch(/\| claude \| 40% \| 60% \|/);
    } finally {
      delete process.env.QUOTACAP_URL;
      await app.close();
    }
  });

  it("mcp get_quotas does not leak raw and includes creditsUsd", async () => {
    const db = openDb(":memory:"); migrate(db);
    upsertQuota(db, {provider:"grok",plan:"SuperGrok",usedPct:30,resetsAt:"2026-09-07T00:22:00Z",periodStart:"2026-08-31T00:22:00Z",source:"tui" as const,fetchedAt:new Date().toISOString(),creditsUsd:4.85, raw:"secret"} as any);
    const app = buildApp(db);
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
    } finally {
      delete process.env.QUOTACAP_URL;
      await app.close();
    }
  });
});