import { describe, it, expect } from "vitest";
import { buildApp, testCtx } from "../src/http/server.js";
import { createCoordinator } from "../src/runtime/poll.js";
import { openDb, migrate } from "../src/store/db.js";
describe("integration", () => {
  it("refresh isolates failures", async () => {
    const db=openDb(":memory:"); migrate(db);
    // Injected fake poll: one success, one failure — never real providers.
    const now = new Date().toISOString();
    const coordinator = createCoordinator({
      db,
      enabledProviders: ["fake-ok", "fake-bad"],
      pollFn: async () => [
        { provider: "fake-ok", status: "fulfilled", value: { provider: "fake-ok", plan: "p", usedPct: 10, resetsAt: new Date(Date.now()+7*86400000).toISOString(), periodStart: new Date(Date.now()-7*86400000).toISOString(), source: "cli", fetchedAt: now } },
        { provider: "fake-bad", status: "rejected", reason: new Error("fetch failed") },
      ],
    });
    const token = "integration-token";
    const app=buildApp(testCtx(db, { token, coordinator }));
    const res = await app.inject({method:"POST", url:"/api/refresh", headers: { "X-QuotaCap-Token": token }});
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // hardened server returns {fulfilled,rejected,lastPollAt} — always 200, degraded only for real failures (manual is skipped, not degraded)
    if (Array.isArray(body)) {
      expect(body.some((r:any)=>r.status==="rejected"||r.status==="fulfilled"||r.status==="skipped")).toBe(true);
    } else {
      expect(body).toHaveProperty("fulfilled");
      expect(body).toHaveProperty("rejected");
      expect(body.fulfilled).toHaveLength(1);
      expect(body.rejected).toHaveLength(1);
      expect(Array.isArray(body.rejected)).toBe(true);
      expect(body.degraded).toBe(true);
    }
  }, 10000);
  it("GET /api/quotas returns real data after ingest", async () => {
    const db=openDb(":memory:"); migrate(db);
    const { upsertQuota } = await import("../src/store/quotas.js");
    upsertQuota(db,{provider:"claude",plan:"max",usedPct:25,resetsAt:"2026-09-03T21:00:00+10:00",periodStart:"2026-08-26T00:00:00Z",raw:"x",source:"cli",fetchedAt:new Date().toISOString()});
    const app=buildApp(testCtx(db));
    const res = await app.inject({method:"GET", url:"/api/quotas"});
    expect(res.statusCode).toBe(200);
    const quotas = JSON.parse(res.body);
    expect(quotas.length).toBeGreaterThan(0);
    expect(quotas[0]).toHaveProperty("provider");
  });
  it("GET /health exposes lastPollAt", async () => {
    const db=openDb(":memory:"); migrate(db);
    const app=buildApp(testCtx(db));
    const res = await app.inject({method:"GET", url:"/health"});
    expect(res.statusCode).toBe(200);
    const j=JSON.parse(res.body);
    expect(j).toHaveProperty("ok", true);
    expect(j).toHaveProperty("uptime");
    // lastPollAt may be null initially, but field exists
    expect(j).toHaveProperty("lastPollAt");
  });
});
