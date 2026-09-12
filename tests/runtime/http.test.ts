import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

  it("POST /api/ingest is 404 unless experimental ingest is enabled", async () => {
    const db = buildFixtureDb();
    const app = buildApp(ctxWith(db));
    const res = await app.inject({
      method: "POST",
      url: "/api/ingest",
      headers: { "x-quotacap-token": TOKEN },
      payload: { provider: "p", text: "10% used" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("(e) POST /api/ingest stores quota fields only and no attempt", async () => {
    const db = buildFixtureDb();
    const app = buildApp(ctxWith(db, { ingestEnabled: true }));

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

  it("POST /api/ingest is 503 after ownership loss and while closing", async () => {
    const db = buildFixtureDb();
    let owner = true;
    const coordinator = createCoordinator({
      db,
      enabledProviders: [],
      pollFn: async () => [],
    });
    const app = buildApp(ctxWith(db, { coordinator, canWrite: () => owner, ingestEnabled: true }));
    const ingest = () =>
      app.inject({
        method: "POST",
        url: "/api/ingest",
        headers: { "x-quotacap-token": TOKEN },
        payload: { provider: "fenced", text: "Weekly limit 16% used resets in 3d" },
      });

    // Ownership lost: refuse before any write, not at the next poll.
    owner = false;
    const lost = await ingest();
    expect(lost.statusCode).toBe(503);
    expect(getLatestByProvider(db, "fenced")).toBeUndefined();

    // Closing: the shutdown wait refuses writes too.
    owner = true;
    coordinator.setClosing();
    const closing = await ingest();
    expect(closing.statusCode).toBe(503);
    expect(getLatestByProvider(db, "fenced")).toBeUndefined();
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

  it("(g) POST /api/restart responds 202, then runs the graceful-stop hook", async () => {
    const db = buildFixtureDb();
    const infos: any[] = [];
    const app = buildApp(ctxWith(db, { onRestart: (info: any) => infos.push(info) }));

    const anon = await app.inject({ method: "POST", url: "/api/restart" });
    expect(anon.statusCode).toBe(401);

    const res = await app.inject({
      method: "POST",
      url: "/api/restart",
      headers: { "x-quotacap-token": TOKEN },
      payload: { version: "0.0.23", exec: "/new/quotacap" },
    });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ ok: true, restarting: true, version: "9.9.9-test" });
    expect(body.pid).toBe(process.pid);
    // The hook fires after the response flushes, not before it.
    await new Promise((r) => setTimeout(r, 50));
    expect(infos).toEqual([{ version: "0.0.23", exec: "/new/quotacap" }]);
  });

  it("POST /api/restart accepts an empty body", async () => {
    const db = buildFixtureDb();
    const infos: any[] = [];
    const app = buildApp(ctxWith(db, { onRestart: (info: any) => infos.push(info) }));
    const res = await app.inject({
      method: "POST",
      url: "/api/restart",
      headers: { "x-quotacap-token": TOKEN },
    });
    expect(res.statusCode).toBe(202);
    await new Promise((r) => setTimeout(r, 50));
    expect(infos).toHaveLength(1);
    expect(infos[0].version).toBeUndefined();
    expect(infos[0].exec).toBeUndefined();
  });

  it("GET /api/state carries the additive update field from the daily cache", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "qc-state-update-"));
    const saved = process.env.QUOTACAP_HOME;
    process.env.QUOTACAP_HOME = home;
    try {
      const db = buildFixtureDb();
      const app = buildApp(ctxWith(db, { version: "9.9.9" }));
      const plain = await app.inject({ method: "GET", url: "/api/state" });
      expect(JSON.parse(plain.body).runtime.update).toEqual({
        current: "9.9.9",
        latest: null,
        upToDate: true,
        checkedAt: null,
      });
      fs.mkdirSync(path.join(home, ".quotacap"), { recursive: true });
      fs.writeFileSync(
        path.join(home, ".quotacap", "updates.json"),
        JSON.stringify({
          checkedAt: "2026-09-11T00:00:00.000Z",
          latest: "9.9.10",
          channel: "standalone",
          current: "9.9.9",
        }),
      );
      const stale = await app.inject({ method: "GET", url: "/api/state" });
      expect(JSON.parse(stale.body).runtime.update).toEqual({
        current: "9.9.9",
        latest: "9.9.10",
        upToDate: false,
        checkedAt: "2026-09-11T00:00:00.000Z",
      });
      // Unparseable dev versions never report stale: string order keeps them quiet.
      const dev = buildApp(ctxWith(db));
      const devRes = await dev.inject({ method: "GET", url: "/api/state" });
      expect(JSON.parse(devRes.body).runtime.update.upToDate).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.QUOTACAP_HOME;
      else process.env.QUOTACAP_HOME = saved;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("POST /api/refresh returns enriched rejection and safe error detail for provider failure, reflected in subsequent GET /api/state without secrets", async () => {
    const db = buildFixtureDb();
    const coordinator = createCoordinator({
      db,
      enabledProviders: ["codex"],
      pollFn: async () => [
        {
          provider: "codex",
          status: "rejected",
          reason: new Error("Error: unauthorized token=secret-tok"),
        },
      ],
    });
    const app = buildApp(ctxWith(db, { coordinator, enabledProviders: ["codex"] }));

    const refreshRes = await app.inject({
      method: "POST",
      url: "/api/refresh",
      headers: { "x-quotacap-token": TOKEN },
    });
    expect(refreshRes.statusCode).toBe(200);
    const refreshBody = JSON.parse(refreshRes.body);
    expect(refreshBody.degraded).toBe(true);
    expect(refreshBody.rejected).toHaveLength(1);
    const rej = refreshBody.rejected[0];
    expect(rej.provider).toBe("codex");
    expect(rej.diagnosticCode).toBe("auth");
    expect(rej.category).toBe("auth");
    expect(rej.summary).toBeTruthy();
    expect(rej.action).toBeTruthy();
    expect(rej.errorDetail).toBe("unauthorized");
    expect(rej.error).toBe("unauthorized");
    expect(rej.reason).toBe("unauthorized");
    expect(refreshRes.body).not.toContain("secret-tok");

    const stateRes = await app.inject({ method: "GET", url: "/api/state" });
    expect(stateRes.statusCode).toBe(200);
    const stateBody = JSON.parse(stateRes.body);
    const codex = stateBody.providers.find((p: any) => p.id === "codex");
    expect(codex.lastAttempt.diagnosticCode).toBe("auth");
    expect(codex.lastAttempt.errorDetail).toBe("unauthorized");
    expect(codex.lastAttempt.error).toBe("unauthorized");
    expect(stateRes.body).not.toContain("secret-tok");
  });

  it("POST /api/refresh catches coordinator generation error, returns enriched rejection for provider 'all', safe error, and excludes secret", async () => {
    const db = buildFixtureDb();
    const coordinator = createCoordinator({
      db,
      enabledProviders: ["codex"],
      pollFn: async () => {
        throw new Error("unexpected generation crash secret=my-secret-token");
      },
    });
    const app = buildApp(ctxWith(db, { coordinator, enabledProviders: ["codex"] }));

    const res = await app.inject({
      method: "POST",
      url: "/api/refresh",
      headers: { "x-quotacap-token": TOKEN },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.degraded).toBe(true);
    expect(body.rejected).toHaveLength(1);
    const rej = body.rejected[0];
    expect(rej.provider).toBe("all");
    expect(rej.diagnosticCode).toBe("unknown");
    expect(rej.summary).toBeTruthy();
    expect(rej.action).toBeTruthy();
    expect(rej.errorDetail).toBeTruthy();
    expect(rej.error).toBe(rej.errorDetail);
    expect(body.error).toBe(rej.errorDetail);
    expect(res.body).not.toContain("my-secret-token");
  });
});
