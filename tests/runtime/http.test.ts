import { describe, it, expect } from "vitest";
import { buildApp, testCtx } from "../../src/http/server.js";
import { createCoordinator } from "../../src/runtime/poll.js";
import { getLatestByProvider } from "../../src/store/quotas.js";
import { getAttempt } from "../../src/store/attempts.js";
import {
  buildFixtureDb,
  FIXED_NOW,
  ENABLED,
} from "../fixtures/stable-state.js";
import {
  buildSnapshot,
  projectQuotasResponse,
} from "../../src/advisory/snapshot.js";

const TOKEN = "test-token-http";

function ctxWith(db: any, overrides?: Record<string, any>) {
  return testCtx(db, {
    token: TOKEN,
    enabledProviders: ENABLED,
    now: () => FIXED_NOW,
    version: "9.9.9-test",
    exec: "/test/quotacap",
    ...overrides,
  });
}

function cannedQuota(provider: string, usedPct: number): any {
  const now = new Date().toISOString();
  return {
    provider,
    plan: "test",
    usedPct,
    resetsAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    periodStart: new Date(Date.now() - 7 * 86400000).toISOString(),
    source: "cli",
    fetchedAt: now,
  };
}

describe("http runtime context", () => {
  it("(a) GET /api/state envelope covers every enabled provider", async () => {
    const db = buildFixtureDb();
    const app = buildApp(ctxWith(db));
    const res = await app.inject({ method: "GET", url: "/api/state" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.asOf).toBe(FIXED_NOW.toISOString());
    expect(body.runtime).toMatchObject({
      available: true,
      ready: true,
      polling: "idle",
      lastCompletedPollAt: null,
      version: "9.9.9-test",
    });
    expect(body.providers.map((p: any) => p.id)).toEqual(
      expect.arrayContaining(ENABLED),
    );
    expect(body.recommendation).toHaveProperty("use");
    expect(body.recommendation).toHaveProperty("reason");
  });

  it("(b) GET /api/quotas matches the snapshot projector output", async () => {
    const db = buildFixtureDb();
    const app = buildApp(ctxWith(db));
    const res = await app.inject({ method: "GET", url: "/api/quotas" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const expected = projectQuotasResponse(
      buildSnapshot(db, {
        enabledProviders: ENABLED,
        now: FIXED_NOW,
        runtime: {
          available: true,
          ready: true,
          polling: "idle",
          lastCompletedPollAt: null,
          version: "9.9.9-test",
        },
      }),
    );
    expect(body).toEqual(JSON.parse(JSON.stringify(expected)));
    // Baseline shape keys plus additive evidence keys.
    expect(body[0]).toHaveProperty("provider");
    expect(body[0]).toHaveProperty("usedPct");
    expect(body[0]).toHaveProperty("stale");
    expect(body[0]).toHaveProperty("ageMs");
    expect(body[0]).toHaveProperty("evidence");
    expect(body[0]).toHaveProperty("exclusionReason");
  });

  it("(c) GET /api/recommendation validates task", async () => {
    const db = buildFixtureDb();
    const app = buildApp(ctxWith(db));
    const bad = await app.inject({
      method: "GET",
      url: "/api/recommendation?task=bogus",
    });
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body)).toMatchObject({
      error: expect.stringContaining("invalid-argument"),
    });
    for (const task of ["any", "heavy", "light"]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/recommendation?task=${task}`,
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toHaveProperty("use");
    }
  });

  it("(d) POST /api/refresh joins and cools per the coordinator", async () => {
    const db = buildFixtureDb();
    let calls = 0;
    const coordinator = createCoordinator({
      db,
      enabledProviders: ["fake-x"],
      pollFn: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 50));
        return [
          {
            provider: "fake-x",
            status: "fulfilled",
            value: cannedQuota("fake-x", 12),
          },
        ];
      },
    });
    const app = buildApp(ctxWith(db, { coordinator }));

    const anon = await app.inject({ method: "POST", url: "/api/refresh" });
    expect(anon.statusCode).toBe(401);

    const [r1, r2] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/refresh",
        headers: { "x-quotacap-token": TOKEN },
      }),
      app.inject({
        method: "POST",
        url: "/api/refresh",
        headers: { "x-quotacap-token": TOKEN },
      }),
    ]);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    const b1 = JSON.parse(r1.body);
    const b2 = JSON.parse(r2.body);
    expect(calls).toBe(1);
    expect([b1.shared, b2.shared].sort()).toEqual([false, true]);
    expect(b1.lastPollAt).toBe(b2.lastPollAt);

    // Inside the cooldown: cached result with the flag, no new poll.
    const r3 = await app.inject({
      method: "POST",
      url: "/api/refresh",
      headers: { "x-quotacap-token": TOKEN },
    });
    const b3 = JSON.parse(r3.body);
    expect(b3.cooldown).toBe(true);
    expect(b3.lastPollAt).toBe(b1.lastPollAt);
    expect(calls).toBe(1);
  });

  it("(e) POST /api/ingest stores quota fields only and no attempt", async () => {
    const db = buildFixtureDb();
    const app = buildApp(ctxWith(db));

    const anon = await app.inject({
      method: "POST",
      url: "/api/ingest",
      payload: { provider: "p", text: "10% used" },
    });
    expect(anon.statusCode).toBe(401);

    for (const payload of [
      {},
      { provider: "p" },
      { text: "10% used" },
      { provider: "", text: "10% used" },
      { provider: 42, text: "10% used" },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/ingest",
        headers: { "x-quotacap-token": TOKEN },
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({
        error: expect.stringContaining("invalid-argument"),
      });
    }

    const res = await app.inject({
      method: "POST",
      url: "/api/ingest",
      headers: { "x-quotacap-token": TOKEN },
      payload: { provider: "my-manual", text: "Weekly limit 16% used resets in 3d" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, provider: "my-manual" });
    const stored = getLatestByProvider(db, "my-manual");
    expect(stored?.usedPct).toBe(16);
    expect(stored?.source).toBe("manual");
    expect((stored as any)?.raw).toBeUndefined();
    expect(getAttempt(db, "my-manual")).toBeNull();
  });

  it("(f) GET /health carries additive identity and readiness keys", async () => {
    const db = buildFixtureDb();
    const app = buildApp(ctxWith(db));
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ ok: true });
    expect(body).toHaveProperty("uptime");
    expect(body).toHaveProperty("lastPollAt");
    expect(body).toMatchObject({
      version: "9.9.9-test",
      exec: "/test/quotacap",
      ready: true,
      polling: "idle",
      lastCompletedPollAt: null,
    });
  });

  it("SPA fallback serves index.html for /setup accepting text/html", async () => {
    const db = buildFixtureDb();
    const app = buildApp(ctxWith(db));
    const res = await app.inject({
      method: "GET",
      url: "/setup",
      headers: { accept: "text/html" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body.toLowerCase()).toContain("<!doctype html");

    const json = await app.inject({
      method: "GET",
      url: "/setup",
      headers: { accept: "application/json" },
    });
    expect(json.statusCode).toBe(404);

    const api = await app.inject({
      method: "GET",
      url: "/api/nonexistent",
      headers: { accept: "text/html" },
    });
    expect(api.statusCode).toBe(404);
  });
});
