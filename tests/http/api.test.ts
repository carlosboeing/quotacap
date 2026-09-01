import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/http/server.js";
import { openDb, migrate } from "../../src/store/db.js";
import { upsertQuota } from "../../src/store/quotas.js";
import { webAssets } from "../../src/webAssets.js";

function appWithDb() {
  const db = openDb(":memory:");
  migrate(db);
  return buildApp(db);
}

describe("http", () => {
  it("GET /api/quotas returns latest", async () => {
    const db = openDb(":memory:"); migrate(db);
    upsertQuota(db,{provider:"claude",plan:"max",usedPct:25,resetsAt:"2026-09-03T21:00:00+10:00",periodStart:"2026-08-26T00:00:00Z",raw:"x",source:"cli",fetchedAt:new Date().toISOString()});
    const app = buildApp(db);
    const res = await app.inject({method:"GET",url:"/api/quotas"});
    expect(res.statusCode).toBe(200);
  });

  it("GET /assets//etc/passwd is 400", async () => {
    const app = appWithDb();
    const res = await app.inject({ method: "GET", url: "/assets//etc/passwd" });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("root:");
  });

  it("GET /assets/..%2f..%2fetc/passwd is 400", async () => {
    const app = appWithDb();
    const res = await app.inject({ method: "GET", url: "/assets/..%2f..%2fetc/passwd" });
    expect(res.statusCode).toBe(400);
  });

  it("GET /assets/<real-asset>.js is 200 with correct content type", async () => {
    const app = appWithDb();
    const name = Object.keys(webAssets)[0];
    expect(name).toBeTruthy();
    const res = await app.inject({ method: "GET", url: `/assets/${name}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/javascript");
  });

  it("GET /assets/nonexistent.js is 404", async () => {
    const app = appWithDb();
    const res = await app.inject({ method: "GET", url: "/assets/nonexistent.js" });
    expect(res.statusCode).toBe(404);
  });
});

