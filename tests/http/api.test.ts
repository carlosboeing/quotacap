import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { buildApp, testCtx } from "../../src/http/server.js";
import { openDb, migrate } from "../../src/store/db.js";
import { upsertQuota } from "../../src/store/quotas.js";
import { upsertCatalog } from "../../src/store/catalogs.js";
import { createServiceClientForBase } from "../../src/runtime/client.js";
import { webAssets } from "../../src/webAssets.js";

let tempHome: string;
const oldHome = process.env.QUOTACAP_HOME;

beforeAll(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "qc-http-api-"));
  process.env.QUOTACAP_HOME = tempHome;
});

afterAll(() => {
  if (oldHome === undefined) delete process.env.QUOTACAP_HOME;
  else process.env.QUOTACAP_HOME = oldHome;
  try {
    fs.rmSync(tempHome, { recursive: true, force: true });
  } catch {}
});

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

    it("persists override to explicit configPath when provided", async () => {
      const db = openDb(":memory:"); migrate(db);
      const testConfigPath = path.join(tempHome, "explicit-config.json");
      fs.writeFileSync(testConfigPath, JSON.stringify({ port: 8787, customFlag: true }));

      const app = buildApp(
        testCtx(db, {
          token: "secret",
          configPath: testConfigPath,
        }),
      );

      const res = await app.inject({
        method: "PATCH",
        url: "/api/providers/claude",
        headers: { "x-quotacap-token": "secret" },
        payload: { displayName: "Persistent Claude" },
      });
      expect(res.statusCode).toBe(200);

      const saved = JSON.parse(fs.readFileSync(testConfigPath, "utf8"));
      expect(saved.port).toBe(8787);
      expect(saved.customFlag).toBe(true);
      expect(saved.providerNames).toEqual({ claude: "Persistent Claude" });
    });

    it("returns 500 when persist to configPath fails", async () => {
      const db = openDb(":memory:"); migrate(db);
      // Point configPath to an invalid path that cannot be written
      const invalidPath = path.join(tempHome, "a-file-not-a-dir", "config.json");
      fs.writeFileSync(path.join(tempHome, "a-file-not-a-dir"), "not a directory");

      const app = buildApp(
        testCtx(db, {
          token: "secret",
          configPath: invalidPath,
        }),
      );

      const res = await app.inject({
        method: "PATCH",
        url: "/api/providers/claude",
        headers: { "x-quotacap-token": "secret" },
        payload: { displayName: "Should Fail" },
      });
      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.error).toContain("failed to persist configuration");
    });
  });
});

describe("/api/models and /api/models/refresh", () => {
  it("GET /api/models Host and Origin allowlist", async () => {
    const db = openDb(":memory:"); migrate(db);
    const app = buildApp(testCtx(db, { enabledProviders: ["claude"], catalogFetchers: {} }));

    // Loopback host is 200
    const r1 = await app.inject({ method: "GET", url: "/api/models", headers: { host: "127.0.0.1:8787" } });
    expect(r1.statusCode).toBe(200);

    // Forbidden host is 403
    const r2 = await app.inject({ method: "GET", url: "/api/models", headers: { host: "evil.com" } });
    expect(r2.statusCode).toBe(403);

    // Foreign origin is 403
    const r3 = await app.inject({
      method: "GET",
      url: "/api/models",
      headers: { host: "localhost:8787", origin: "http://evil.com" },
    });
    expect(r3.statusCode).toBe(403);
  });

  it("GET /api/models returns body elements with id, displayName, harness, vendor, leftoverPct, resetsAt, catalog", async () => {
    const db = openDb(":memory:"); migrate(db);
    const now = new Date();
    upsertQuota(db, {
      provider: "claude",
      plan: "pro",
      usedPct: 20,
      resetsAt: new Date(Date.now() + 86400000).toISOString(),
      periodStart: new Date().toISOString(),
      source: "cli",
      fetchedAt: now.toISOString(),
    });
    upsertCatalog(db, "claude", [{ id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", default: true }], now.toISOString());

    const app = buildApp(testCtx(db, { enabledProviders: ["claude"], catalogFetchers: {} }));
    const res = await app.inject({ method: "GET", url: "/api/models" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      id: "claude",
      displayName: "Claude",
      harness: "Claude Code",
      vendor: "Anthropic",
      leftoverPct: 80,
      catalog: {
        status: "ok",
        listed: [{ id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", default: true }],
      },
    });
    expect(body[0]).toHaveProperty("resetsAt");
  });

  it("GET /api/models rejects unknown provider with 400", async () => {
    const db = openDb(":memory:"); migrate(db);
    const app = buildApp(testCtx(db, { enabledProviders: ["claude"], catalogFetchers: {} }));
    const res = await app.inject({ method: "GET", url: "/api/models?provider=unknown-provider" });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining("unknown provider") });
  });

  it("POST /api/models/refresh requires token (401)", async () => {
    const db = openDb(":memory:"); migrate(db);
    const app = buildApp(testCtx(db, { token: "super-secret" }));

    // No token
    const r1 = await app.inject({ method: "POST", url: "/api/models/refresh" });
    expect(r1.statusCode).toBe(401);

    // Wrong token
    const r2 = await app.inject({
      method: "POST",
      url: "/api/models/refresh",
      headers: { "x-quotacap-token": "wrong" },
    });
    expect(r2.statusCode).toBe(401);
  });

  it("POST /api/models/refresh succeeds with valid token and respects 60s cooldown", async () => {
    const db = openDb(":memory:"); migrate(db);
    upsertCatalog(db, "fake", [{ id: "m1", displayName: "M1" }], new Date().toISOString());

    let fetchCount = 0;
    const fetchers = {
      fake: {
        id: "fake",
        fetch: async () => {
          fetchCount++;
          return { fake: [{ id: `m-${fetchCount}`, displayName: `M ${fetchCount}` }] };
        },
      },
    };

    let clock = 1_000_000_000;
    const now = () => new Date(clock);

    const app = buildApp(
      testCtx(db, {
        token: "valid-token",
        enabledProviders: ["fake"],
        catalogFetchers: fetchers,
        now,
      }),
    );

    // First call: fresh execution
    const r1 = await app.inject({
      method: "POST",
      url: "/api/models/refresh",
      headers: { "x-quotacap-token": "valid-token" },
    });
    expect(r1.statusCode).toBe(200);
    const b1 = JSON.parse(r1.body);
    expect(b1.cooldown).toBe(false);
    expect(fetchCount).toBe(1);

    // Immediate second call inside 60s cooldown
    clock += 10_000;
    const r2 = await app.inject({
      method: "POST",
      url: "/api/models/refresh",
      headers: { "x-quotacap-token": "valid-token" },
    });
    expect(r2.statusCode).toBe(200);
    const b2 = JSON.parse(r2.body);
    expect(b2.cooldown).toBe(true);
    expect(fetchCount).toBe(1); // fetch not called again

    // Call after 61s: cooldown expired, runs again
    clock += 51_000;
    const r3 = await app.inject({
      method: "POST",
      url: "/api/models/refresh",
      headers: { "x-quotacap-token": "valid-token" },
    });
    expect(r3.statusCode).toBe(200);
    const b3 = JSON.parse(r3.body);
    expect(b3.cooldown).toBe(false);
    expect(fetchCount).toBe(2);
  });

  it("injected fetcher resolving at 22s: HTTP GET /api/models with 30s client returns 200, 20s client aborts", async () => {
    // Simulate a fetcher responding at 22ms scaled test time
    const fakeFetch = vi.fn((_url: any, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve(
            new Response(JSON.stringify([{ id: "fake", catalog: { status: "ok", listed: [] } }]), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }, 22);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch as any;
    try {
      // 30ms client succeeds with 22ms fetcher
      const client30 = createServiceClientForBase("http://127.0.0.1:8787", { timeoutMs: 30 });
      const res30 = await client30.get("/api/models");
      expect(res30[0].id).toBe("fake");

      // 20ms client aborts with 22ms fetcher
      const client20 = createServiceClientForBase("http://127.0.0.1:8787", { timeoutMs: 20 });
      await expect(client20.get("/api/models")).rejects.toThrow(/service unavailable/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("unfiltered GET /api/models includes synthetic agy:3p when agy is enabled", async () => {
    const db = openDb(":memory:"); migrate(db);
    const fetchers = {
      agy: {
        id: "agy",
        fetch: async () => ({
          agy: [{ id: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash" }],
          "agy:3p": [{ id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" }],
        }),
      },
    };
    const app = buildApp(testCtx(db, { enabledProviders: ["agy"], catalogFetchers: fetchers }));
    const res = await app.inject({ method: "GET", url: "/api/models" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const ids = body.map((b: any) => b.id);
    expect(ids).toContain("agy");
    expect(ids).toContain("agy:3p");
  });

  it("POST /api/models/refresh?provider=claude only refreshes the specified provider", async () => {
    const db = openDb(":memory:"); migrate(db);
    let claudeFetched = 0;
    let fakeFetched = 0;
    const fetchers = {
      claude: {
        id: "claude",
        fetch: async () => { claudeFetched++; return { claude: [{ id: "c1", displayName: "C1" }] }; },
      },
      fake: {
        id: "fake",
        fetch: async () => { fakeFetched++; return { fake: [{ id: "f1", displayName: "F1" }] }; },
      },
    };
    const app = buildApp(testCtx(db, { token: "token", enabledProviders: ["claude", "fake"], catalogFetchers: fetchers }));
    const res = await app.inject({
      method: "POST",
      url: "/api/models/refresh?provider=claude",
      headers: { "x-quotacap-token": "token" },
    });
    expect(res.statusCode).toBe(200);
    expect(claudeFetched).toBe(1);
    expect(fakeFetched).toBe(0);
  });
});


