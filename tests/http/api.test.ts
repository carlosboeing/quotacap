import { describe, it, expect } from "vitest";
import { buildApp, testCtx } from "../../src/http/server.js";
import { openDb, migrate } from "../../src/store/db.js";
import { upsertQuota } from "../../src/store/quotas.js";
import { webAssets } from "../../src/webAssets.js";

function appWithDb() {
  const db = openDb(":memory:");
  migrate(db);
  return buildApp(testCtx(db));
}

describe("http", () => {
  it("GET /api/quotas returns latest", async () => {
    const db = openDb(":memory:"); migrate(db);
    upsertQuota(db,{provider:"claude",plan:"max",usedPct:25,resetsAt:"2026-09-03T21:00:00+10:00",periodStart:"2026-08-26T00:00:00Z",raw:"x",source:"cli",fetchedAt:new Date().toISOString()});
    const app = buildApp(testCtx(db));
    const res = await app.inject({method:"GET",url:"/api/quotas"});
    expect(res.statusCode).toBe(200);
  });

  it("GET /api/quotas does not expose raw and round-trips creditsUsd", async () => {
    const db = openDb(":memory:"); migrate(db);
    const now = new Date().toISOString();
    upsertQuota(db,{provider:"grok",plan:"SuperGrok",usedPct:30,resetsAt:"2026-09-07T00:22:00Z",periodStart:"2026-08-31T00:22:00Z",source:"tui",fetchedAt:now,creditsUsd:4.85, raw:"secret" } as any);
    const app = buildApp(testCtx(db));
    const res = await app.inject({method:"GET",url:"/api/quotas"});
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0].provider).toBe("grok");
    expect(body[0].creditsUsd).toBe(4.85);
    expect(body[0].raw).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(JSON.stringify(body)).not.toContain("\"raw\"");
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
    const name = Object.keys(webAssets).find((k) => k.endsWith(".js"));
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

describe("http host allowlist", () => {
  it("GET /health with Host localhost:8787 is 200", async () => {
    const app = appWithDb();
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: "localhost:8787" } });
    expect(res.statusCode).toBe(200);
  });

  it("GET /health with Host 127.0.0.1:8787 is 200", async () => {
    const app = appWithDb();
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: "127.0.0.1:8787" } });
    expect(res.statusCode).toBe(200);
  });

  it("GET /health with Host 127.0.0.1 (no port) is 200", async () => {
    const app = appWithDb();
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: "127.0.0.1" } });
    expect(res.statusCode).toBe(200);
  });

  it("GET /health with Host [::1]:8787 is 200", async () => {
    const app = appWithDb();
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: "[::1]:8787" } });
    expect(res.statusCode).toBe(200);
  });

  it("GET /health with Host [::1] (no port) is 200", async () => {
    const app = appWithDb();
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: "[::1]" } });
    expect(res.statusCode).toBe(200);
  });

  it("Rebinding Host: evil.example is 403", async () => {
    const app = appWithDb();
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: "evil.example" } });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "forbidden host" });
  });

  it("Rebinding Host: evil.com:8787 is 403", async () => {
    const app = appWithDb();
    const res = await app.inject({ method: "GET", url: "/api/quotas", headers: { host: "evil.com:8787" } });
    expect(res.statusCode).toBe(403);
  });

  it("Host: localhost.evil.example is 403", async () => {
    const app = appWithDb();
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: "localhost.evil.example" } });
    expect(res.statusCode).toBe(403);
  });

  it("Malformed Host header is 403", async () => {
    const app = appWithDb();
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: "localhost:8787:8787" } });
    expect(res.statusCode).toBe(403);
  });
});

describe("http origin allowlist", () => {
  it("GET /api/quotas still works with absent Origin", async () => {
    const app = appWithDb();
    const res = await app.inject({ method: "GET", url: "/api/quotas", headers: { host: "localhost:8787" } });
    expect(res.statusCode).toBe(200);
  });

  it("GET /api/quotas with loopback Origin http://localhost:8787 is 200", async () => {
    const app = appWithDb();
    const res = await app.inject({
      method: "GET",
      url: "/api/quotas",
      headers: { host: "localhost:8787", origin: "http://localhost:8787" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("GET /api/quotas with loopback Origin http://127.0.0.1:8787 is 200", async () => {
    const app = appWithDb();
    const res = await app.inject({
      method: "GET",
      url: "/api/quotas",
      headers: { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("GET /api/quotas with loopback Origin http://[::1]:8787 is 200", async () => {
    const app = appWithDb();
    const res = await app.inject({
      method: "GET",
      url: "/api/quotas",
      headers: { host: "[::1]:8787", origin: "http://[::1]:8787" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("GET /api/quotas with foreign Origin http://evil.com is 403", async () => {
    const app = appWithDb();
    const res = await app.inject({
      method: "GET",
      url: "/api/quotas",
      headers: { host: "localhost:8787", origin: "http://evil.com" },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "forbidden origin" });
  });

  it("GET /api/quotas with foreign Origin null is 403", async () => {
    const app = appWithDb();
    const res = await app.inject({
      method: "GET",
      url: "/api/quotas",
      headers: { host: "localhost:8787", origin: "null" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("http token auth and mutating routes", () => {
  it("GET /api/token returns shared secret token", async () => {
    const db = openDb(":memory:"); migrate(db);
    const app = buildApp(testCtx(db, { token: "custom-secret-token" }));
    const res = await app.inject({ method: "GET", url: "/api/token" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ token: "custom-secret-token" });
  });

  it("GET /api/token is protected by Origin check", async () => {
    const app = appWithDb();
    const res = await app.inject({
      method: "GET",
      url: "/api/token",
      headers: { host: "localhost:8787", origin: "http://evil.example" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST without the token header is 401", async () => {
    const app = appWithDb();
    const res = await app.inject({ method: "POST", url: "/api/refresh" });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining("unauthorized") });
  });

  it("POST with invalid token header is 401", async () => {
    const db = openDb(":memory:"); migrate(db);
    const app = buildApp(testCtx(db, { token: "correct-token" }));
    const res = await app.inject({
      method: "POST",
      url: "/api/refresh",
      headers: { "x-quotacap-token": "wrong-token" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("Cross-origin POST with a foreign Origin is 403", async () => {
    const db = openDb(":memory:"); migrate(db);
    const app = buildApp(testCtx(db, { token: "correct-token" }));
    const res = await app.inject({
      method: "POST",
      url: "/api/refresh",
      headers: {
        host: "localhost:8787",
        origin: "http://evil.example",
        "x-quotacap-token": "correct-token",
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST with the correct header is 200 and debounced", async () => {
    const db = openDb(":memory:"); migrate(db);
    const app = buildApp(testCtx(db, { token: "correct-token" }));
    const res1 = await app.inject({
      method: "POST",
      url: "/api/refresh",
      headers: { "X-QuotaCap-Token": "correct-token" },
    });
    expect(res1.statusCode).toBe(200);
    const body1 = JSON.parse(res1.body);
    expect(body1).toHaveProperty("fulfilled");
    expect(body1).toHaveProperty("lastPollAt");

    // Second call immediately within 60s debounce window
    const res2 = await app.inject({
      method: "POST",
      url: "/api/refresh",
      headers: { "x-quotacap-token": "correct-token" },
    });
    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.body);
    expect(body2.lastPollAt).toBe(body1.lastPollAt);
  }, 15000);

  describe("PATCH /api/providers/:id", () => {
    it("rejects request without token header (401)", async () => {
      const db = openDb(":memory:"); migrate(db);
      const app = buildApp(testCtx(db, { token: "secret" }));
      const res = await app.inject({
        method: "PATCH",
        url: "/api/providers/claude",
        payload: { displayName: "My Claude" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("rejects request with invalid token header (401)", async () => {
      const db = openDb(":memory:"); migrate(db);
      const app = buildApp(testCtx(db, { token: "secret" }));
      const res = await app.inject({
        method: "PATCH",
        url: "/api/providers/claude",
        headers: { "x-quotacap-token": "wrong" },
        payload: { displayName: "My Claude" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("rejects cross-origin request with foreign origin (403)", async () => {
      const db = openDb(":memory:"); migrate(db);
      const app = buildApp(testCtx(db, { token: "secret" }));
      const res = await app.inject({
        method: "PATCH",
        url: "/api/providers/claude",
        headers: {
          host: "localhost:8787",
          origin: "http://evil.com",
          "x-quotacap-token": "secret",
        },
        payload: { displayName: "My Claude" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("rejects invalid displayName values (400)", async () => {
      const db = openDb(":memory:"); migrate(db);
      const app = buildApp(testCtx(db, { token: "secret" }));

      // empty string
      const r1 = await app.inject({
        method: "PATCH",
        url: "/api/providers/claude",
        headers: { "x-quotacap-token": "secret" },
        payload: { displayName: "   " },
      });
      expect(r1.statusCode).toBe(400);

      // ANSI escape
      const r2 = await app.inject({
        method: "PATCH",
        url: "/api/providers/claude",
        headers: { "x-quotacap-token": "secret" },
        payload: { displayName: "\x1b[31mRed\x1b[0m" },
      });
      expect(r2.statusCode).toBe(400);

      // longer than 32 chars
      const r3 = await app.inject({
        method: "PATCH",
        url: "/api/providers/claude",
        headers: { "x-quotacap-token": "secret" },
        payload: { displayName: "a".repeat(33) },
      });
      expect(r3.statusCode).toBe(400);

      // non-string / non-null
      const r4 = await app.inject({
        method: "PATCH",
        url: "/api/providers/claude",
        headers: { "x-quotacap-token": "secret" },
        payload: { displayName: 123 },
      });
      expect(r4.statusCode).toBe(400);
    });

    it("sets override for registered provider and updates GET /api/state", async () => {
      const db = openDb(":memory:"); migrate(db);
      const app = buildApp(testCtx(db, { token: "secret", enabledProviders: ["muse"] }));
      const res = await app.inject({
        method: "PATCH",
        url: "/api/providers/muse",
        headers: { "x-quotacap-token": "secret" },
        payload: { displayName: "Work Muse" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        ok: true,
        id: "muse",
        displayName: "Work Muse",
        builtinName: "Muse",
        override: "Work Muse",
      });

      const stateRes = await app.inject({ method: "GET", url: "/api/state" });
      const state = JSON.parse(stateRes.body);
      const muse = state.providers.find((p: any) => p.id === "muse");
      expect(muse).toBeDefined();
      expect(muse.displayName).toBe("Work Muse");
      expect(muse.builtinName).toBe("Muse");
    });

    it("accepts override for unregistered provider id", async () => {
      const db = openDb(":memory:"); migrate(db);
      const app = buildApp(testCtx(db, { token: "secret", enabledProviders: [] }));
      const res = await app.inject({
        method: "PATCH",
        url: "/api/providers/custom-unregistered",
        headers: { "x-quotacap-token": "secret" },
        payload: { displayName: "My Custom" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        ok: true,
        id: "custom-unregistered",
        displayName: "My Custom",
        builtinName: null,
        override: "My Custom",
      });
    });

    it("clears override with null displayName, restoring built-in", async () => {
      const db = openDb(":memory:"); migrate(db);
      const app = buildApp(
        testCtx(db, {
          token: "secret",
          enabledProviders: ["muse"],
          providerNames: { muse: "Work Muse" },
        }),
      );

      // Verify initial overridden state
      const initial = JSON.parse((await app.inject({ method: "GET", url: "/api/state" })).body);
      expect(initial.providers.find((p: any) => p.id === "muse").displayName).toBe("Work Muse");

      // Clear override
      const res = await app.inject({
        method: "PATCH",
        url: "/api/providers/muse",
        headers: { "x-quotacap-token": "secret" },
        payload: { displayName: null },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        ok: true,
        id: "muse",
        displayName: "Muse",
        builtinName: "Muse",
        override: null,
      });

      // Verify restored built-in in GET /api/state
      const stateRes = await app.inject({ method: "GET", url: "/api/state" });
      const state = JSON.parse(stateRes.body);
      const muse = state.providers.find((p: any) => p.id === "muse");
      expect(muse.displayName).toBe("Muse");
      expect(muse.builtinName).toBe("Muse");
    });
  });
});

