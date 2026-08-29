import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseGrokUsage, grokAdapter } from "../../src/adapters/grok.js";

const creditsFixture = {
  config: {
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-08-24T00:22:20.662354+00:00",
      end: "2026-08-31T00:22:20.662354+00:00",
    },
    creditUsagePercent: 26.0,
    productUsage: [{ product: "PRODUCT_GROK_BUILD", usagePercent: 26.0 }],
    isUnifiedBillingUser: true,
    prepaidBalance: { val: 0 },
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    topUpMethod: "TOP_UP_METHOD_SAVED_PAYMENT_METHOD",
  },
  onDemandEnabled: false,
  subscriptionTier: "SuperGrok Heavy",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.GROK_HOME;
});

async function writeAuth(home: string, refresh = "grok-prf"): Promise<string> {
  const f = path.join(home, "auth.json");
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(
    f,
    JSON.stringify({
      "https://auth.x.ai::11111111-2222-3333-4444-555555555555": {
        key: "11111111-2222-3333-4444-555555555555",
        auth_mode: "oauth",
        user_id: "u-9",
        email: "user@example.com",
        refresh_token: refresh,
        expires_at: "2030-01-01T00:00:00Z",
        oidc_client_id: "grok-code-cli",
      },
    })
  );
  return f;
}

describe("parseGrokUsage", () => {
  it("maps creditUsagePercent and the weekly period", () => {
    const q = parseGrokUsage(creditsFixture, new Date("2026-08-29T00:00:00Z"));
    expect(q.usedPct).toBe(26);
    expect(q.plan).toBe("SuperGrok Heavy");
    expect(q.source).toBe("api");
    expect(q.resetsAt).toBe("2026-08-31T00:22:20.662354+00:00");
    expect(q.periodStart).toBe("2026-08-24T00:22:20.662354+00:00");
    expect(q.provider).toBe("grok");
  });

  it("throws when config is absent (fail-closed)", () => {
    expect(() => parseGrokUsage({}, new Date())).toThrow();
  });

  it("throws when creditUsagePercent is absent", () => {
    const body = { config: { currentPeriod: { start: "2026-08-24T00:00:00+00:00", end: "2026-08-31T00:00:00+00:00" } }, subscriptionTier: "SuperGrok Heavy" };
    expect(() => parseGrokUsage(body, new Date())).toThrow();
  });
});

describe("grokAdapter poll", () => {
  it("refreshes a token, persists the suite, and fetches credits", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "qc-grok-"));
    const authFile = await writeAuth(home);
    process.env.GROK_HOME = home;
    const calls: string[] = [];
    let billingHeaders: Record<string, string> = {};
    globalThis.fetch = ((url: string, init: RequestInit) => {
      calls.push(url);
      if (url.includes("auth.x.ai")) {
        const body = init.body as string;
        return Promise.resolve(body.includes("grok-prf") ? jsonResponse(200, { access_token: "fresh-xai", refresh_token: "rf2", expires_at: "2031-01-01T00:00:00Z" }) : jsonResponse(400, { error: "bad" }));
      }
      billingHeaders = init.headers as Record<string, string>;
      return Promise.resolve(jsonResponse(200, creditsFixture));
    }) as typeof fetch;

    const q = await grokAdapter.poll();
    expect(calls[0]).toContain("auth.x.ai");
    expect(calls[1]).toContain("cli-chat-proxy.grok.com/v1/billing?format=credits");
    expect(billingHeaders.Authorization).toBe("Bearer fresh-xai");
    expect(billingHeaders["x-grok-client-surface"]).toBe("grok-build");
    expect(billingHeaders["X-XAI-Token-Auth"]).toBe("xai-grok-cli");
    expect(q.usedPct).toBe(26);

    const persisted = JSON.parse(await fs.readFile(authFile, "utf8"));
    const entry = Object.values(persisted)[0] as Record<string, string>;
    expect(entry.refresh_token).toBe("rf2");
    const bak = JSON.parse(await fs.readFile(authFile + ".qc-bak", "utf8"));
    expect(Object.values(bak)[0]).toMatchObject({ refresh_token: "grok-prf" });
  });

  it("rotates only the matched entry and persists access_token", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "qc-grok-"));
    const authFile = path.join(home, "auth.json");
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      authFile,
      JSON.stringify({
        "https://auth.x.ai::primary": { key: "primary", auth_mode: "oauth", user_id: "u-1", refresh_token: "prf-1", expires_at: "2030-01-01T00:00:00Z", oidc_client_id: "grok-code-cli" },
        "https://auth.x.ai::secondary": { key: "secondary", auth_mode: "oauth", user_id: "u-2", refresh_token: "prf-2", expires_at: "2030-01-01T00:00:00Z", oidc_client_id: "grok-code-cli" },
      })
    );
    process.env.GROK_HOME = home;
    globalThis.fetch = ((url: string, init: RequestInit) => {
      if (url.includes("auth.x.ai")) {
        const body = init.body as string;
        return Promise.resolve(body.includes("prf-1") ? jsonResponse(200, { access_token: "fresh-xai", refresh_token: "rf2", expires_in: 3600 }) : jsonResponse(400, { error: "bad" }));
      }
      return Promise.resolve(jsonResponse(200, creditsFixture));
    }) as typeof fetch;

    await grokAdapter.poll();
    const persisted = JSON.parse(await fs.readFile(authFile, "utf8")) as Record<string, Record<string, string>>;
    expect(persisted["https://auth.x.ai::primary"].refresh_token).toBe("rf2");
    expect(persisted["https://auth.x.ai::primary"].access_token).toBe("fresh-xai");
    expect(persisted["https://auth.x.ai::secondary"].refresh_token).toBe("prf-2");
    expect(persisted["https://auth.x.ai::secondary"].access_token).toBeUndefined();
  });

  it("reuses a fresh stored access_token instead of refreshing", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "qc-grok-"));
    const authFile = await writeAuth(home);
    const entry = (JSON.parse(await fs.readFile(authFile, "utf8")) as Record<string, Record<string, string>>)["https://auth.x.ai::11111111-2222-3333-4444-555555555555"];
    entry.access_token = "stored-valid";
    entry.expires_at = new Date(Date.now() + 3600000).toISOString();
    await fs.writeFile(authFile, JSON.stringify({ "https://auth.x.ai::11111111-2222-3333-4444-555555555555": entry }));
    process.env.GROK_HOME = home;
    const calls: string[] = [];
    let billingHeader = "";
    globalThis.fetch = ((url: string, init: RequestInit) => {
      calls.push(url);
      billingHeader = (init.headers as Record<string, string>).Authorization ?? "";
      return Promise.resolve(url.includes("billing") ? jsonResponse(200, creditsFixture) : jsonResponse(200, { access_token: "should-not-happen" }));
    }) as typeof fetch;

    await grokAdapter.poll();
    expect(calls.filter((u) => u.includes("auth.x.ai"))).toEqual([]);
    expect(billingHeader).toBe("Bearer stored-valid");
  });

  it("throws when refresh fails with 400", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "qc-grok-"));
    await writeAuth(home);
    process.env.GROK_HOME = home;
    globalThis.fetch = ((url: string) =>
      Promise.resolve(url.includes("auth.x.ai") ? jsonResponse(400, { error: "bad" }) : jsonResponse(200, creditsFixture))) as typeof fetch;
    await expect(grokAdapter.poll()).rejects.toThrow();
  });

  it("throws when auth.json is missing", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "qc-grok-"));
    process.env.GROK_HOME = home;
    await expect(grokAdapter.poll()).rejects.toThrow();
  });
});
