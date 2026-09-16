import { describe, it, expect } from "vitest";
import { handleTool } from "../../src/mcp/server.js";
import { buildApp, testCtx } from "../../src/http/server.js";
import { openDb, migrate } from "../../src/store/db.js";
import { upsertQuota } from "../../src/store/quotas.js";

function seedClose(db: any) {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  upsertQuota(db, {
    provider: "claude",
    plan: "max",
    usedPct: 88,
    resetsAt: iso(now - 40 * 60000),
    periodStart: iso(now - 7 * 86400000),
    source: "cli",
    fetchedAt: iso(now - 45 * 60000),
  });
  upsertQuota(db, {
    provider: "claude",
    plan: "max",
    usedPct: 0,
    resetsAt: iso(now + 7 * 86400000),
    periodStart: iso(now - 40 * 60000),
    source: "cli",
    fetchedAt: iso(now - 5 * 60000),
  });
}

async function withService(db: any, fn: () => Promise<void>) {
  const app = buildApp(testCtx(db));
  const addr = await app.listen({ port: 0, host: "127.0.0.1" });
  process.env.QUOTACAP_URL = addr;
  try {
    await fn();
  } finally {
    delete process.env.QUOTACAP_URL;
    await app.close();
  }
}

describe("mcp lastCloses", () => {
  it("get_quotas JSON carries lastCloses", async () => {
    const db = openDb(":memory:"); migrate(db); seedClose(db);
    await withService(db, async () => {
      const res: any = await handleTool("get_quotas", {});
      const rows = JSON.parse(res.content[1].text);
      expect(rows[0].provider).toBe("claude");
      expect(rows[0].lastCloses).toHaveLength(1);
      expect(rows[0].lastCloses[0].leftoverPct).toBe(12);
      expect(rows[0].lastCloses[0].usedPct).toBe(88);
    });
  });

  it("forecast JSON carries lastCloses for that provider", async () => {
    const db = openDb(":memory:"); migrate(db); seedClose(db);
    await withService(db, async () => {
      const res: any = await handleTool("forecast", { provider: "claude" });
      const body = JSON.parse(res.content[0].text);
      expect(body.lastCloses).toHaveLength(1);
      expect(body.lastCloses[0].leftoverPct).toBe(12);
    });
  });

  it("get_recommendation payload does not grow leftover fields", async () => {
    const db = openDb(":memory:"); migrate(db); seedClose(db);
    await withService(db, async () => {
      const res: any = await handleTool("get_recommendation", { task: "any" });
      const json = res.content[1].text;
      expect(json).not.toContain("lastCloses");
      expect(json).not.toContain("leftover");
    });
  });
});
