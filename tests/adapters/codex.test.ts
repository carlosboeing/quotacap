import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseCodexUsage, codexAdapter } from "../../src/adapters/codex.js";

const usageFixture = {
  user_id: "user-12345",
  account_id: "acct-001",
  email: "user@example.com",
  plan_type: "plus",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 12,
      limit_window_seconds: 18000,
      reset_after_seconds: 9000,
      reset_at: 1760000000,
    },
    secondary_window: {
      used_percent: 22,
      limit_window_seconds: 604800,
      reset_after_seconds: 172800,
      reset_at: 1760001000,
    },
  },
  credits: { has_credits: true, unlimited: false, balance: "150.0" },
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
  delete process.env.CODEX_HOME;
  delete process.env.QUOTACAP_HOME;
});

const tmpHome = () => fs.mkdtemp(path.join(os.tmpdir(), "qc-codex-"));

describe("parseCodexUsage", () => {
  it("uses the secondary (weekly) window as the cap", () => {
    const q = parseCodexUsage(usageFixture, new Date(1760000000000));
    expect(q.usedPct).toBe(22);
    expect(q.plan).toBe("plus");
    expect(q.source).toBe("api");
    expect(q.resetsAt).toBe(new Date(1760001000 * 1000).toISOString());
    expect(q.periodStart).toBe(new Date((1760001000 - 604800) * 1000).toISOString());
    expect(q.provider).toBe("codex");
  });

  it("falls back to the primary (5h) window when secondary is absent", () => {
    const body = { ...usageFixture, rate_limit: { allowed: true, limit_reached: false, primary_window: usageFixture.rate_limit.primary_window } };
    const q = parseCodexUsage(body, new Date(1760000000000));
    expect(q.usedPct).toBe(12);
  });

  it("throws when no window is available (fail-closed)", () => {
    expect(() => parseCodexUsage({ plan_type: "plus", rate_limit: {} }, new Date())).toThrow();
  });
});

describe("codexAdapter poll", () => {
  it("fetches usage with the stored bearer + account-id headers", async () => {
    const home = await tmpHome();
    await fs.writeFile(
      path.join(home, "auth.json"),
      JSON.stringify({ tokens: { access_token: "valid-token", account_id: "acct-001" }, last_refresh: "none" })
    );
    process.env.CODEX_HOME = home;
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    globalThis.fetch = ((url: string, init: RequestInit) => {
      seenUrl = url;
      seenHeaders = init.headers as Record<string, string>;
      return Promise.resolve(jsonResponse(200, usageFixture));
    }) as typeof fetch;

    const q = await codexAdapter.poll();
    expect(seenUrl).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(seenHeaders.Authorization).toBe("Bearer valid-token");
    expect(seenHeaders["ChatGPT-Account-Id"]).toBe("acct-001");
    expect(q.usedPct).toBe(22);
  });

  it("refreshes on 401, persists rotated tokens, and retries once", async () => {
    const home = await tmpHome();
    const authFile = path.join(home, "auth.json");
    await fs.writeFile(authFile, JSON.stringify({ tokens: { access_token: "stale", refresh_token: "prf", account_id: "acct-001" } }));
    process.env.CODEX_HOME = home;
    let calls = 0;
    globalThis.fetch = ((url: string, init: RequestInit) => {
      calls++;
      if (url.includes("wham/usage")) {
        return Promise.resolve(calls === 1 ? jsonResponse(401, { error: "expired" }) : jsonResponse(200, usageFixture));
      }
      const body = init.body as string;
      return Promise.resolve(body.includes("prf") ? jsonResponse(200, { access_token: "fresh-tok", refresh_token: "rf2", expires_in: 604800 }) : jsonResponse(400, { error: "bad" }));
    }) as typeof fetch;

    const q = await codexAdapter.poll();
    expect(q.usedPct).toBe(22);
    const persisted = JSON.parse(await fs.readFile(authFile, "utf8"));
    expect(persisted.tokens.access_token).toBe("fresh-tok");
    expect(persisted.tokens.refresh_token).toBe("rf2");
    const bak = JSON.parse(await fs.readFile(authFile + ".qc-bak", "utf8"));
    expect(bak.tokens.access_token).toBe("stale");
  });

  it("throws when auth.json is missing", async () => {
    const home = await tmpHome();
    process.env.CODEX_HOME = home;
    await expect(codexAdapter.poll()).rejects.toThrow();
  });
});
