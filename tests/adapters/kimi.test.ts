import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseKimiUsage, kimiAdapter } from "../../src/adapters/kimi.js";

const usageFixture = {
  user: { userId: "u-1", region: "REGION_OVERSEA", membership: { level: "LEVEL_INTERMEDIATE" } },
  usage: { limit: "100", used: "17", remaining: "83", resetTime: "2026-09-01T00:25:17.281509Z" },
  limits: [
    { window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "100", remaining: "85", resetTime: "2026-08-30T00:25:17Z" } },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.KIMI_CODE_HOME;
  process.env.HOME = originalHome;
});

async function writeCreds(home: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const f = path.join(home, "credentials", "kimi-code.json");
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(
    f,
    JSON.stringify({
      access_token: "valid-tok",
      refresh_token: "prf-tok",
      expires_at: Math.floor(Date.now() / 1000) + 600,
      scope: "kimi-code",
      token_type: "Bearer",
      ...overrides,
    })
  );
  return f;
}

describe("parseKimiUsage", () => {
  it("maps usage to usedPct, reset and tier plan", () => {
    const q = parseKimiUsage(usageFixture, new Date("2026-08-29T00:00:00Z"));
    expect(q.usedPct).toBe(17);
    expect(q.plan).toBe("intermediate");
    expect(q.source).toBe("api");
    expect(q.resetsAt).toBe("2026-09-01T00:25:17.281509Z");
    expect(q.periodStart).toBe(new Date(new Date("2026-09-01T00:25:17.281509Z").getTime() - 7 * 86400000).toISOString());
    expect(q.provider).toBe("kimi");
  });

  it("plan is unknown when membership is absent", () => {
    const body = { ...usageFixture, user: { userId: "u-1" } };
    expect(parseKimiUsage(body, new Date()).plan).toBe("unknown");
  });

  it("throws when usage is absent (fail-closed)", () => {
    expect(() => parseKimiUsage({ user: {} }, new Date())).toThrow();
  });
});

describe("kimiAdapter poll", () => {
  it("uses the stored token directly when it is fresh", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "qc-kimi-"));
    await writeCreds(home);
    process.env.KIMI_CODE_HOME = home;
    let authHeader = "";
    let calls = 0;
    globalThis.fetch = ((url: string, init: RequestInit) => {
      calls++;
      authHeader = (init.headers as Record<string, string>).Authorization ?? "";
      expect(url).toBe("https://api.kimi.com/coding/v1/usages");
      return Promise.resolve(jsonResponse(200, usageFixture));
    }) as typeof fetch;

    const q = await kimiAdapter.poll();
    expect(calls).toBe(1);
    expect(authHeader).toBe("Bearer valid-tok");
    expect(q.usedPct).toBe(17);
  });

  it("refreshes an expired token and persists the rotated pair in CLI seconds", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "qc-kimi-"));
    const credsFile = await writeCreds(home, { expires_at: Math.floor(Date.now() / 1000) - 1000 });
    process.env.KIMI_CODE_HOME = home;
    const calls: string[] = [];
    globalThis.fetch = ((url: string, init: RequestInit) => {
      calls.push(url);
      if (url.includes("auth.kimi.com")) {
        const body = init.body as string;
        return Promise.resolve(body.includes("prf-tok") ? jsonResponse(200, { access_token: "fresh-tok", refresh_token: "rf2", expires_in: 3600 }) : jsonResponse(400, { error: "bad" }));
      }
      const authHeader = (init.headers as Record<string, string>).Authorization ?? "";
      return Promise.resolve(jsonResponse(200, authHeader === "Bearer fresh-tok" ? usageFixture : jsonResponse(401, { error: "expired" })));
    }) as typeof fetch;

    const q = await kimiAdapter.poll();
    expect(calls[0]).toContain("auth.kimi.com");
    expect(q.usedPct).toBe(17);
    const persisted = JSON.parse(await fs.readFile(credsFile, "utf8"));
    expect(persisted.access_token).toBe("fresh-tok");
    expect(persisted.refresh_token).toBe("rf2");
    expect(persisted.expires_at).toBeLessThan(1e12);
    expect(persisted.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
    const bak = JSON.parse(await fs.readFile(credsFile + ".qc-bak", "utf8"));
    expect(bak.access_token).toBe("valid-tok");
  });

  it("treats an ms-scale expires_at as fresh (legacy quotacap rows)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "qc-kimi-"));
    await writeCreds(home, { expires_at: Date.now() + 600000 });
    process.env.KIMI_CODE_HOME = home;
    let calls = 0;
    const urls: string[] = [];
    globalThis.fetch = ((url: string) => {
      calls++;
      urls.push(url);
      return Promise.resolve(jsonResponse(200, usageFixture));
    }) as typeof fetch;
    await kimiAdapter.poll();
    expect(calls).toBe(1);
    expect(urls[0]).toContain("api.kimi.com");
  });

  it("throws when the credentials file is missing", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "qc-kimi-"));
    process.env.KIMI_CODE_HOME = home;
    await expect(kimiAdapter.poll()).rejects.toThrow();
  });
});
