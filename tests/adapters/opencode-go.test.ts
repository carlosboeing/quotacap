import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OPENCODE_GO_CONSENT_NOTICE,
  openCodeGoConsentNotice,
  openCodeLoginCommandForVersion,
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
    expect(q.fiveHourResetsAt).toBe("2026-09-17T10:54:52.662Z");
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

  const W = { status: "ok", percent: 8, resetsAt: "2026-09-21T00:00:00.662Z" };
  const R = { status: "ok", percent: 5, resetsAt: "2026-09-17T10:54:52.662Z" };
  const withMonthly = (monthly: unknown) => ({ usage: { weekly: W, rolling: R, monthly } });

  it("maps an ok monthly to included/ok with its percent and reset", () => {
    const q = parseOpencodeGoUsage(LIVE_BODY, now);
    expect(q.monthlyKind).toBe("included");
    expect(q.monthlyStatus).toBe("ok");
    expect(q.monthlyPct).toBe(82);
    expect(q.monthlyResetsAt).toBe("2026-09-22T13:05:15.662Z");
  });

  it("maps rate-limited to exhausted at 100 without requiring the percent to read 100", () => {
    const q = parseOpencodeGoUsage(withMonthly({ status: "rate-limited", percent: 97, resetsAt: "2026-09-22T13:05:15Z" }), now);
    expect(q.monthlyStatus).toBe("exhausted");
    expect(q.monthlyPct).toBe(100);
  });

  it("omits all four fields when monthly is absent or not an object, and the poll succeeds", () => {
    for (const body of [{ usage: { weekly: W, rolling: R } }, withMonthly(null), withMonthly("x")]) {
      const q = parseOpencodeGoUsage(body, now);
      for (const k of ["monthlyPct", "monthlyResetsAt", "monthlyStatus", "monthlyKind"]) expect(k in q).toBe(false);
      expect(q.weeklyPct).toBe(8);
    }
  });

  it("clamps a percent over 100 to 100 and marks it exhausted", () => {
    const q = parseOpencodeGoUsage(withMonthly({ status: "ok", percent: 100.3, resetsAt: "2026-09-22T13:05:15Z" }), now);
    expect(q.monthlyPct).toBe(100);
    expect(q.monthlyStatus).toBe("exhausted");
  });

  it("throws fixed subjects on a bad monthly percent, reset, or status", () => {
    for (const percent of [-1, "82", null]) {
      expect(() => parseOpencodeGoUsage(withMonthly({ status: "ok", percent, resetsAt: "2026-09-22T13:05:15Z" }), now))
        .toThrow("opencode-go: bad monthly pct");
    }
    expect(() => parseOpencodeGoUsage(withMonthly({ status: "ok", percent: 50 }), now))
      .toThrow("opencode-go: bad monthly reset");
    expect(() => parseOpencodeGoUsage(withMonthly({ status: "rate-limited", percent: 100 }), now))
      .toThrow("opencode-go: bad monthly reset");
    expect(() => parseOpencodeGoUsage(withMonthly({ status: "queued", percent: 50, resetsAt: "2026-09-22T13:05:15Z" }), now))
      .toThrow("opencode-go: unknown monthly status");
  });

  it("parses the live 2026-09-19 issue-109 body to weekly 44 beside an exhausted month", () => {
    const q = parseOpencodeGoUsage({ usage: {
      rolling: { status: "ok", percent: 0, resetsAt: "2026-09-19T12:00:00Z" },
      weekly: { status: "ok", percent: 44, resetsAt: "2026-09-21T00:00:00.904Z" },
      monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-09-22T13:05:15.904Z" },
    } }, now);
    expect(q.weeklyPct).toBe(44);
    expect(q.monthlyStatus).toBe("exhausted");
    expect(q.monthlyPct).toBe(100);
  });
});

describe("opencodeGoAdapter.poll", () => {
  let mockHome = "";
  const origHome = process.env.HOME;
  const origEnvKey = process.env.OPENCODE_API_KEY;
  const origDb = process.env.OPENCODE_DB;
  const origXdg = process.env.XDG_DATA_HOME;
  let fetchSpy: any;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env.HOME = origHome;
    if (origEnvKey === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = origEnvKey;
    if (origDb === undefined) delete process.env.OPENCODE_DB;
    else process.env.OPENCODE_DB = origDb;
    if (origXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = origXdg;
    if (mockHome) fs.rmSync(mockHome, { recursive: true, force: true });
    mockHome = "";
  });

  function useMockHome(): string {
    mockHome = fs.mkdtempSync(path.join(os.tmpdir(), "qc-ocgo-"));
    delete process.env.OPENCODE_DB;
    delete process.env.XDG_DATA_HOME;
    process.env.HOME = mockHome;
    vi.spyOn(os, "homedir").mockReturnValue(mockHome);
    return path.join(mockHome, ".local", "share", "opencode");
  }

  function authHome(entries: Record<string, unknown>): void {
    const dir = useMockHome();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify(entries));
  }

  function seedDb(rows: Array<{ integration: string; active: number; value: unknown }>): void {
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (p: string) => {
        exec: (sql: string) => void;
        prepare: (sql: string) => { run: (...args: unknown[]) => void };
        close: () => void;
      };
    };
    const dir = path.join(mockHome, ".local", "share", "opencode");
    fs.mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(path.join(dir, "opencode.db"));
    db.exec(`CREATE TABLE credential (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      integration_id TEXT NOT NULL,
      value TEXT NOT NULL,
      active INTEGER
    )`);
    const insert = db.prepare("INSERT INTO credential (integration_id, value, active) VALUES (?, ?, ?)");
    for (const row of rows) insert.run(row.integration, JSON.stringify(row.value), row.active);
    db.close();
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

  it("env OPENCODE_API_KEY wins over the file and the v2 database", async () => {
    authHome({ "opencode-go": { type: "api", key: "sk-file" } });
    seedDb([{ integration: "opencode", active: 1, value: { type: "oauth", access: "db-access" } }]);
    process.env.OPENCODE_API_KEY = "sk-env";
    stubFetch(200, LIVE_BODY);
    await opencodeGoAdapter.poll();
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe("Bearer sk-env");
  });

  it("uses the v2 database access token ahead of a stale auth.json key", async () => {
    authHome({ "opencode-go": { type: "api", key: "sk-stale" } });
    seedDb([{
      integration: "opencode",
      active: 1,
      value: { type: "oauth", access: "session-access", refresh: "do-not-send" },
    }]);
    stubFetch(200, LIVE_BODY);
    await opencodeGoAdapter.poll();
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe("Bearer session-access");
  });

  it("prefers an active opencode-go API key over the console session", async () => {
    authHome({});
    seedDb([
      { integration: "opencode", active: 1, value: { type: "oauth", access: "session-access" } },
      { integration: "opencode-go", active: 1, value: { type: "api", key: "oc_sk_go" } },
    ]);
    stubFetch(200, LIVE_BODY);
    await opencodeGoAdapter.poll();
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe("Bearer oc_sk_go");
  });

  it("ignores an inactive credential and a legacy key that does not start with sk-", async () => {
    authHome({ "opencode": { type: "api", key: "oc_sk_legacy" } });
    seedDb([
      { integration: "opencode-go", active: 0, value: { type: "api", key: "oc_sk_inactive" } },
      { integration: "opencode", active: 1, value: { type: "oauth", access: "session-access" } },
    ]);
    stubFetch(200, LIVE_BODY);
    await opencodeGoAdapter.poll();
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe("Bearer session-access");
  });

  it("accepts a legacy oc_sk_ key when v2 has no usable credential", async () => {
    authHome({ "opencode-go": { type: "api", key: "oc_sk_legacy" } });
    stubFetch(200, LIVE_BODY);
    await opencodeGoAdapter.poll();
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe("Bearer oc_sk_legacy");
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
    useMockHome();
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
  it("is true when the auth file or the v2 database exists, without reading either", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "qc-ocgo-det-"));
    const origHome = process.env.HOME;
    const origDb = process.env.OPENCODE_DB;
    const origXdg = process.env.XDG_DATA_HOME;
    delete process.env.OPENCODE_DB;
    delete process.env.XDG_DATA_HOME;
    process.env.HOME = home;
    vi.spyOn(os, "homedir").mockReturnValue(home);
    const readSpy = vi.spyOn(fs, "readFileSync");
    try {
      expect(opencodeGoDetected()).toBe(false);
      const dir = path.join(home, ".local", "share", "opencode");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "opencode.db"), "");
      expect(opencodeGoDetected()).toBe(true);
      fs.rmSync(path.join(dir, "opencode.db"));
      expect(opencodeGoDetected()).toBe(false);
      fs.writeFileSync(path.join(dir, "auth.json"), "{}");
      expect(opencodeGoDetected()).toBe(true);
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      process.env.HOME = origHome;
      if (origDb === undefined) delete process.env.OPENCODE_DB;
      else process.env.OPENCODE_DB = origDb;
      if (origXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = origXdg;
      vi.restoreAllMocks();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("OpenCode CLI login command", () => {
  it("selects the command for the detected CLI major version", () => {
    expect(openCodeLoginCommandForVersion("opencode v2.0.15")).toBe("opencode auth login opencode");
    expect(openCodeLoginCommandForVersion("opencode 1.4.2")).toBe("opencode console login");
    expect(openCodeLoginCommandForVersion("opencode unknown")).toBeNull();
    expect(openCodeLoginCommandForVersion(null)).toBeNull();
  });

  it("renders a version-specific consent notice when the command is known", () => {
    expect(openCodeGoConsentNotice("opencode console login")).toContain("`opencode console login`");
    expect(openCodeGoConsentNotice("opencode console login")).not.toContain("opencode auth login opencode");
  });
});

describe("OPENCODE_GO_CONSENT_NOTICE", () => {
  it("carries the consent contract", () => {
    expect(OPENCODE_GO_CONSENT_NOTICE).toContain("opencode auth login opencode");
    expect(OPENCODE_GO_CONSENT_NOTICE).toContain("opencode console login");
    expect(OPENCODE_GO_CONSENT_NOTICE).not.toContain("opencode auth login -p opencode-go");
    expect(OPENCODE_GO_CONSENT_NOTICE).toContain("opencode.db");
    expect(OPENCODE_GO_CONSENT_NOTICE).toContain("auth.json");
    expect(OPENCODE_GO_CONSENT_NOTICE).toContain("https://opencode.ai/zen/go/v1/usage");
    expect(OPENCODE_GO_CONSENT_NOTICE).toContain("quotacap providers disable opencode-go");
    expect(OPENCODE_GO_CONSENT_NOTICE).toContain("OPENCODE_API_KEY");
  });

  it("formats as short structured lines covering the consent areas", () => {
    const lines = OPENCODE_GO_CONSENT_NOTICE.split("\n");
    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatch(/^• What is read: /);
    expect(lines[1]).toMatch(/^• Read frequency: /);
    expect(lines[2]).toMatch(/^• Request destination: /);
    expect(lines[3]).toMatch(/^• Never-list: /);
    expect(lines[4]).toMatch(/^• Revocation instructions: /);
    expect(lines[5]).toMatch(/^• Optional environment override: /);
  });
});
