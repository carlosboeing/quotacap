import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OPENCODE_GO_CONSENT_NOTICE,
  opencodeGoAdapter,
  opencodeGoDetected,
  parseOpencodeGoUsage,
} from "../../src/adapters/opencode-go.js";

const LIVE_BODY = {
  usage: {
    rolling: { status: "ok", percent: 5, resetsAt: "2026-09-17T10:54:52.662Z" },
    weekly: { status: "ok", percent: 8, resetsAt: "2026-09-21T00:00:00.662Z" },
    monthly: { status: "ok", percent: 82, resetsAt: "2026-09-22T13:05:15.662Z" },
  },
};

describe("parseOpencodeGoUsage", () => {
  const now = new Date("2026-09-17T06:00:00Z");

  it("maps weekly to weeklyPct and resetsAt, rolling to fiveHourPct", () => {
    const q = parseOpencodeGoUsage(LIVE_BODY, now);
    expect(q.provider).toBe("opencode-go");
    expect(q.plan).toBe("unknown");
    expect(q.weeklyPct).toBe(8);
    expect(q.fiveHourPct).toBe(5);
    expect(q.resetsAt).toBe("2026-09-21T00:00:00.662Z");
    expect(q.periodStart).toBe("2026-09-14T00:00:00.662Z");
    expect(q.source).toBe("api");
    expect(q.fetchedAt).toBe(now.toISOString());
    expect(q.raw).toBeUndefined();
    expect(q.resetsAtEstimated).toBeUndefined();
  });

  it("throws fixed subjects on missing usage, missing weekly, non-ok status, bad percent, bad reset", () => {
    expect(() => parseOpencodeGoUsage({}, now)).toThrow("opencode-go: weekly usage not found");
    expect(() => parseOpencodeGoUsage({ usage: {} }, now)).toThrow("opencode-go: weekly usage not found");
    expect(() => parseOpencodeGoUsage({ usage: { weekly: { status: "invalid", percent: 1, resetsAt: "2026-09-21T00:00:00Z" }, rolling: { status: "ok", percent: 1, resetsAt: "2026-09-17T10:00:00Z" } } }, now))
      .toThrow("opencode-go: usage status not ok");
    expect(() => parseOpencodeGoUsage({ usage: { weekly: { status: "ok", percent: 101, resetsAt: "2026-09-21T00:00:00Z" }, rolling: { status: "ok", percent: 1, resetsAt: "2026-09-17T10:00:00Z" } } }, now))
      .toThrow("opencode-go: bad weekly pct");
    expect(() => parseOpencodeGoUsage({ usage: { weekly: { status: "ok", percent: 8, resetsAt: "not-a-date" }, rolling: { status: "ok", percent: 1, resetsAt: "2026-09-17T10:00:00Z" } } }, now))
      .toThrow("opencode-go: bad weekly reset");
  });

  it("throws fixed subjects on missing rolling and bad rolling percent", () => {
    expect(() => parseOpencodeGoUsage({ usage: { weekly: { status: "ok", percent: 8, resetsAt: "2026-09-21T00:00:00Z" } } }, now))
      .toThrow("opencode-go: rolling usage not found");
    expect(() => parseOpencodeGoUsage({ usage: { weekly: { status: "ok", percent: 8, resetsAt: "2026-09-21T00:00:00Z" }, rolling: { status: "ok", percent: -1, resetsAt: "2026-09-17T10:00:00Z" } } }, now))
      .toThrow("opencode-go: bad rolling pct");
  });
});

describe("opencodeGoAdapter.poll", () => {
  let mockHome = "";
  const origHome = process.env.HOME;
  const origEnvKey = process.env.OPENCODE_API_KEY;
  let fetchSpy: any;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env.HOME = origHome;
    if (origEnvKey === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = origEnvKey;
    if (mockHome) fs.rmSync(mockHome, { recursive: true, force: true });
    mockHome = "";
  });

  function authHome(entries: Record<string, unknown>): void {
    mockHome = fs.mkdtempSync(path.join(os.tmpdir(), "qc-ocgo-"));
    const dir = path.join(mockHome, ".local", "share", "opencode");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify(entries));
    process.env.HOME = mockHome;
    vi.spyOn(os, "homedir").mockReturnValue(mockHome);
  }

  function stubFetch(status: number, body: unknown): void {
    fetchSpy = vi.fn().mockResolvedValue(
      new Response(body === undefined ? "" : JSON.stringify(body), { status }),
    );
    vi.stubGlobal("fetch", fetchSpy);
  }

  it("prefers the opencode-go entry and parses the usage body", async () => {
    authHome({
      "opencode": { type: "api", key: "sk-other-entry" },
      "opencode-go": { type: "api", key: "sk-go-entry" },
    });
    stubFetch(200, LIVE_BODY);
    const q = await opencodeGoAdapter.poll();
    expect(q.weeklyPct).toBe(8);
    expect(q.fiveHourPct).toBe(5);
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe("Bearer sk-go-entry");
    expect(fetchSpy.mock.calls[0][0]).toBe("https://opencode.ai/zen/go/v1/usage");
  });

  it("falls back to the opencode entry", async () => {
    authHome({ "opencode": { type: "api", key: "sk-shared" } });
    stubFetch(200, LIVE_BODY);
    const q = await opencodeGoAdapter.poll();
    expect(q.weeklyPct).toBe(8);
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe("Bearer sk-shared");
  });

  it("env OPENCODE_API_KEY wins over the file", async () => {
    authHome({ "opencode-go": { type: "api", key: "sk-file" } });
    process.env.OPENCODE_API_KEY = "sk-env";
    stubFetch(200, LIVE_BODY);
    await opencodeGoAdapter.poll();
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe("Bearer sk-env");
  });

  it("missing or malformed entries fail closed without leaking the key", async () => {
    authHome({ "openrouter": { type: "api", key: "sk-openrouter" } });
    stubFetch(200, LIVE_BODY);
    await expect(opencodeGoAdapter.poll()).rejects.toThrow("opencode-go: missing API key in auth file");
    authHome({ "opencode-go": { type: "oauth", key: "sk-wrong-type" } });
    stubFetch(200, LIVE_BODY);
    await expect(opencodeGoAdapter.poll()).rejects.toThrow("opencode-go: missing API key in auth file");
  });

  it("401 and 429 classify as auth and rate limit; fetch failure stays network", async () => {
    authHome({ "opencode-go": { type: "api", key: "sk-go" } });
    stubFetch(401, { error: "AuthError" });
    await expect(opencodeGoAdapter.poll()).rejects.toThrow("opencode-go: unauthorized (401)");
    stubFetch(429, {});
    await expect(opencodeGoAdapter.poll()).rejects.toThrow("opencode-go: rate limit (429)");
    fetchSpy = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(opencodeGoAdapter.poll()).rejects.toThrow("fetch failed");
  });

  it("a malformed auth file and a missing auth file both fail closed with the fixed subject", async () => {
    mockHome = fs.mkdtempSync(path.join(os.tmpdir(), "qc-ocgo-"));
    process.env.HOME = mockHome;
    vi.spyOn(os, "homedir").mockReturnValue(mockHome);
    // no auth file at all:
    stubFetch(200, LIVE_BODY);
    await expect(opencodeGoAdapter.poll()).rejects.toThrow("opencode-go: missing API key in auth file");
    // auth file present but not JSON:
    const dir = path.join(mockHome, ".local", "share", "opencode");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "auth.json"), "{ not json near sk-secretkeymaterial");
    await expect(opencodeGoAdapter.poll()).rejects.toThrow("opencode-go: missing API key in auth file");
    await expect(opencodeGoAdapter.poll()).rejects.not.toThrow(/sk-secretkeymaterial/);
  });

  it("a non-JSON 200 body fails closed with the fixed subject", async () => {
    authHome({ "opencode-go": { type: "api", key: "sk-go" } });
    fetchSpy = vi.fn().mockResolvedValue(new Response("not json {", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(opencodeGoAdapter.poll()).rejects.toThrow("opencode-go: weekly usage not found");
    await expect(opencodeGoAdapter.poll()).rejects.not.toThrow(/not json/);
  });
});

describe("opencodeGoDetected", () => {
  it("is true when the auth file exists and false when it does not, without reading it", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "qc-ocgo-det-"));
    const origHome = process.env.HOME;
    process.env.HOME = home;
    vi.spyOn(os, "homedir").mockReturnValue(home);
    const readSpy = vi.spyOn(fs, "readFileSync");
    try {
      expect(opencodeGoDetected()).toBe(false);
      const dir = path.join(home, ".local", "share", "opencode");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "auth.json"), "{}");
      expect(opencodeGoDetected()).toBe(true);
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      process.env.HOME = origHome;
      vi.restoreAllMocks();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("OPENCODE_GO_CONSENT_NOTICE", () => {
  it("carries the consent contract", () => {
    expect(OPENCODE_GO_CONSENT_NOTICE).toContain("opencode auth login -p opencode-go");
    expect(OPENCODE_GO_CONSENT_NOTICE).toContain("https://opencode.ai/zen/go/v1/usage");
    expect(OPENCODE_GO_CONSENT_NOTICE).toContain("quotacap providers disable opencode-go");
    expect(OPENCODE_GO_CONSENT_NOTICE).toContain("OPENCODE_API_KEY");
  });
});
