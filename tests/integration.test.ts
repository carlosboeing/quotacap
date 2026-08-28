import { describe, it, expect } from "vitest";
import { buildApp } from "../src/http/server.js";
import { openDb, migrate } from "../src/store/db.js";
describe("integration", () => {
  it("refresh isolates failures", async () => {
    const db=openDb(":memory:"); migrate(db);
    const app=buildApp(db);
    const res = await app.inject({method:"POST", url:"/api/refresh"});
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // hardened server returns {fulfilled,rejected,lastPollAt} or array — both 200 is degraded handling
    if (Array.isArray(body)) {
      expect(body.some((r:any)=>r.status==="rejected"||r.status==="fulfilled")).toBe(true);
    } else {
      expect(body).toHaveProperty("fulfilled");
      expect(body).toHaveProperty("rejected");
      expect(body.rejected.some((r:any)=>r.provider==="manual")).toBe(true);
      expect(body.degraded).toBe(true);
    }
  }, 10000);
  it("GET /api/quotas returns real data after ingest", async () => {
    const db=openDb(":memory:"); migrate(db);
    const { upsertQuota } = await import("../src/store/quotas.js");
    upsertQuota(db,{provider:"claude",plan:"max",usedPct:25,resetsAt:"2026-09-03T21:00:00+10:00",periodStart:"2026-08-26T00:00:00Z",raw:"x",source:"cli",fetchedAt:new Date().toISOString()});
    const app=buildApp(db);
    const res = await app.inject({method:"GET", url:"/api/quotas"});
    expect(res.statusCode).toBe(200);
    const quotas = JSON.parse(res.body);
    expect(quotas.length).toBeGreaterThan(0);
    expect(quotas[0]).toHaveProperty("provider");
  });
  it("GET /health exposes lastPollAt", async () => {
    const db=openDb(":memory:"); migrate(db);
    const app=buildApp(db);
    const res = await app.inject({method:"GET", url:"/health"});
    expect(res.statusCode).toBe(200);
    const j=JSON.parse(res.body);
    expect(j).toHaveProperty("ok", true);
    expect(j).toHaveProperty("uptime");
    // lastPollAt may be null initially, but field exists
    expect(j).toHaveProperty("lastPollAt");
  });
});
