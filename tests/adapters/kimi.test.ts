import { describe, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseKimiTui,
  parseKimiApiUsage,
  kimiProbeDir,
  resolveKimiAuth,
  ensureFreshKimiToken,
  pollKimiApi,
  pollKimiPty,
  readKimiProviderConfig,
  KimiCredentialWriteError,
} from "../../src/adapters/kimi.js";
import { runPty, stripAnsi } from "../../src/adapters/pty.js";

function kimiFixture(overrides?: { weeklyPct?: number; weeklyReset?: string; fivePct?: number; fiveReset?: string; extra?: string }): string {
  const wPct = overrides?.weeklyPct ?? 7;
  const wReset = overrides?.weeklyReset ?? "in 6d 19h 57m";
  const fPct = overrides?.fivePct ?? 33;
  const fReset = overrides?.fiveReset ?? "in 57m";
  const extra = overrides?.extra ?? "";
  return `
  Welcome to Kimi Code
  context: 0% (0/1M)
  ╭ Usage ──────────────────────────╮
  │ Plan usage                      │
  │   Weekly limit  █░░░░  ${wPct}% used   resets ${wReset} │
  │   5h limit      ██░░  ${fPct}% used  resets ${fReset}        │
  ${extra}
  ╰─────────────────────────────────╯
  > `;
}

describe("parseKimiTui", () => {
  it("maps weekly 7% and 5h 33% with relative resets", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const txt = kimiFixture();
    const q = parseKimiTui(txt, now);
    expect(q.provider).toBe("kimi");
    expect(q.weeklyPct).toBe(7);
    expect(q.fiveHourPct).toBe(33);
    expect(q.plan).toBe("unknown");
    // source is tui (cast)
    expect((q as unknown as { source: string }).source).toBe("tui");
    expect(Number.isNaN(new Date(q.resetsAt).getTime())).toBe(false);
    expect(Number.isNaN(new Date(q.periodStart).getTime())).toBe(false);
    expect(new Date(q.periodStart).getTime()).toBe(new Date(q.resetsAt).getTime() - 7 * 86400000);
    // weekly reset should be ~6d 19h 57m after now
    const diff = new Date(q.resetsAt).getTime() - now.getTime();
    expect(diff).toBeGreaterThan(6 * 86400000);
    expect(diff).toBeLessThan(7 * 86400000);
    expect(q.fetchedAt).toBe(now.toISOString());
  });

  it("strips ANSI before parsing", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const txt = `\x1b[31mWelcome to Kimi Code\x1b[0m\ncontext: 0% (0/1M)\nWeekly limit  \x1b[38;5;244m█\x1b[0m 12% used   resets in 2d 1h 5m\n5h limit      45% used  resets in 1h 10m\n`;
    const q = parseKimiTui(txt, now);
    expect(q.weeklyPct).toBe(12);
    expect(q.fiveHourPct).toBe(45);
  });

  it("parses with bar characters and unicode box drawing", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const raw = stripAnsi(kimiFixture({ weeklyPct: 7, fivePct: 33 }));
    expect(raw).toMatch(/Weekly limit/);
    const q = parseKimiTui(kimiFixture({ weeklyPct: 7, fivePct: 33 }), now);
    expect(q.weeklyPct).toBe(7);
  });

  it("parses 5h limit via fallback when reset duration is omitted", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const txt = `Weekly limit  10% used   resets in 5d 1h\n5h limit      0% used\n`;
    const q = parseKimiTui(txt, now);
    expect(q.weeklyPct).toBe(10);
    expect(q.fiveHourPct).toBe(0);
  });

  it("throws when weekly limit is absent (fail-closed)", () => {
    const txt = `5h limit      33% used  resets in 57m\n`;
    expect(() => parseKimiTui(txt, new Date())).toThrow(/weekly limit/i);
  });

  it("throws when 5h limit is absent (fail-closed)", () => {
    const txt = `Weekly limit  7% used   resets in 6d 19h 57m\n`;
    expect(() => parseKimiTui(txt, new Date())).toThrow(/5h limit/i);
  });

  it("throws when reset duration is malformed (fail-closed)", () => {
    const txt = kimiFixture({ weeklyReset: "in ???", fiveReset: "in 57m" });
    expect(() => parseKimiTui(txt, new Date())).toThrow(/bad weekly reset/i);
  });

  it("takes plan from Weekly limit (Tier) when present", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const txt = kimiFixture({ extra: "" }) + "\nWeekly limit (Pro)  7% used resets in 6d 19h 57m\n5h limit 33% used resets in 57m";
    // inject paren into first line via replacement: we already have generic, override with custom text
    const custom = `Welcome to Kimi Code\nWeekly limit (Pro)  █ 7% used   resets in 6d 19h 57m\n5h limit      33% used  resets in 57m\n`;
    const q = parseKimiTui(custom, now);
    expect(q.plan).toBe("pro");
  });

  it("raw is capped and contains cleaned transcript", () => {
    const q = parseKimiTui(kimiFixture(), new Date());
    expect((q as any).raw.length).toBeGreaterThan(0);
    expect((q as any).raw.length).toBeLessThanOrEqual(4096);
    expect((q as any).raw).toMatch(/Weekly limit/);
  });

  it("parses monthly limit when present in TUI output", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const txt = `Welcome to Kimi Code\nWeekly limit  █ 7% used   resets in 6d 19h 57m\n5h limit      33% used  resets in 57m\nMonthly limit █ 73% used resets in 5d 10m\n`;
    const q = parseKimiTui(txt, now);
    expect(q.monthlyPct).toBe(73);
    expect(q.monthlyKind).toBe("included");
    expect(q.monthlyStatus).toBe("ok");
    expect(q.monthlyResetsAt).toBeDefined();
  });

  it("leaves the monthly reset undefined when the TUI shows none", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const txt = `Welcome to Kimi Code\nWeekly limit  █ 7% used   resets in 6d 19h 57m\n5h limit      33% used  resets in 57m\nMonthly limit █ 73% used\n`;
    const q = parseKimiTui(txt, now);
    expect(q.monthlyPct).toBe(73);
    expect(q.resetsAt).toBeDefined();
    expect(q.monthlyResetsAt).toBeUndefined();
  });

  it("leaves monthly fields undefined when absent in TUI output", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const q = parseKimiTui(kimiFixture(), now);
    expect(q.monthlyPct).toBeUndefined();
    expect(q.monthlyResetsAt).toBeUndefined();
    expect(q.monthlyKind).toBeUndefined();
  });
});

describe("kimi TUI via fake PTY", () => {
  async function writeFake(content: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qc-kimi-fake-"));
    const file = path.join(dir, "fake.mjs");
    await fs.writeFile(file, content, { mode: 0o755 });
    return file;
  }

  it("happy-path: fake TUI yields correct Quota via runPty + parse", async () => {
    const script = `
process.stdout.write('Welcome to Kimi Code\\n');
process.stdout.write('context: 0% (0/1M)\\n');
let buf='';
process.stdin.on('data', d=>{
  buf+=d.toString();
  if(buf.includes('/usage')){
    setTimeout(()=>{
      process.stdout.write('Weekly limit  \\u2588\\u2591  7% used   resets in 6d 19h 57m\\n');
      process.stdout.write('5h limit      \\u2588\\u2588 33% used  resets in 57m\\n');
    },30);
  }
});
setInterval(()=>{},1000);
`;
    const fake = await writeFake(script);
    const transcript = await runPty({
      file: process.execPath,
      args: [fake],
      readyRegex: /Welcome to Kimi Code|context:/i,
      readyTimeoutMs: 2000,
      input: "/usage\r",
      completionRegex: /Weekly limit[\s\S]*5h limit/,
      timeoutMs: 2000,
      maxBytes: 64 * 1024,
    });
    const q = parseKimiTui(transcript, new Date("2026-09-01T00:00:00Z"));
    expect(q.weeklyPct).toBe(7);
    expect(q.fiveHourPct).toBe(33);
    expect(q.provider).toBe("kimi");
  });

  it("timeout → rejected when fake never emits completion", async () => {
    const script = `
process.stdout.write('Welcome to Kimi Code\\n');
process.stdin.on('data', ()=>{});
setInterval(()=>{},1000);
`;
    const fake = await writeFake(script);
    await expect(
      runPty({
        file: process.execPath,
        args: [fake],
        readyRegex: /Welcome to Kimi Code/,
        readyTimeoutMs: 2000,
        input: "/usage\r",
        completionRegex: /Weekly limit/,
        timeoutMs: 600,
      }),
    ).rejects.toThrow(/completion timeout/i);
  });

  it("malformed text → parse rejects (fail-closed, no partial Quota)", async () => {
    const script = `
process.stdout.write('Welcome to Kimi Code\\n');
let buf='';
process.stdin.on('data', d=>{
  buf+=d.toString();
  if(buf.includes('/usage')){
    setTimeout(()=>{
      process.stdout.write('Weekly limit  ??? no number\\n');
      process.stdout.write('5h limit      also broken\\n');
    },30);
  }
});
setInterval(()=>{},1000);
`;
    const fake = await writeFake(script);
    const transcript = await runPty({
      file: process.execPath,
      args: [fake],
      readyRegex: /Welcome to Kimi Code/,
      readyTimeoutMs: 2000,
      input: "/usage\r",
      completionRegex: /Weekly limit/,
      timeoutMs: 2000,
    });
    expect(() => parseKimiTui(transcript)).toThrow();
  });

  it("clean kill: fake process does not survive after runPty", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qc-kimi-pid-"));
    const pidFile = path.join(dir, "pid");
    const script = `
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdout.write('Welcome to Kimi Code\\n');
let buf='';
process.stdin.on('data', d=>{
  buf+=d.toString();
  if(buf.includes('/usage')){
    setTimeout(()=>{
      process.stdout.write('Weekly limit  7% used   resets in 6d 19h 57m\\n');
      process.stdout.write('5h limit      33% used  resets in 57m\\n');
    },30);
  }
});
setInterval(()=>{},1000);
`;
    const fake = await writeFake(script);
    const transcript = await runPty({
      file: process.execPath,
      args: [fake],
      readyRegex: /Welcome to Kimi Code/,
      readyTimeoutMs: 2000,
      input: "/usage\r",
      completionRegex: /Weekly limit/,
      timeoutMs: 2000,
    });
    expect(stripAnsi(transcript)).toMatch(/Weekly limit/);
    await new Promise((r) => setTimeout(r, 400));
    const pid = parseInt(await fs.readFile(pidFile, "utf8"), 10);
    let alive = true;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });
});

describe("kimiProbeDir", () => {
  it("resolves under QUOTACAP_HOME when set", () => {
    const orig = process.env.QUOTACAP_HOME;
    try {
      process.env.QUOTACAP_HOME = "/custom/qc-home";
      expect(kimiProbeDir()).toBe("/custom/qc-home/.quotacap/kimi-probe");
    } finally {
      if (orig === undefined) delete process.env.QUOTACAP_HOME;
      else process.env.QUOTACAP_HOME = orig;
    }
  });

  it("falls back to os.homedir() when QUOTACAP_HOME is unset", () => {
    const orig = process.env.QUOTACAP_HOME;
    try {
      delete process.env.QUOTACAP_HOME;
      expect(kimiProbeDir()).toBe(path.join(os.homedir(), ".quotacap", "kimi-probe"));
    } finally {
      if (orig !== undefined) process.env.QUOTACAP_HOME = orig;
    }
  });
});

describe("resolveKimiAuth", () => {
  it("resolves from environment variable when KIMI_CODE_API_KEY is present", () => {
    const ctx = resolveKimiAuth({ KIMI_CODE_API_KEY: "sk-env-key-1" });
    expect(ctx).not.toBeNull();
    expect(ctx?.token).toBe("sk-env-key-1");
    expect(ctx?.baseUrl).toBe("https://api.kimi.ai/coding/v1");
    expect(ctx?.oauthHost).toBe("https://auth.kimi.ai");
  });

  it("resolves from KIMI_API_KEY as fallback environment variable", () => {
    const ctx = resolveKimiAuth({ KIMI_API_KEY: "sk-env-key-2" });
    expect(ctx).not.toBeNull();
    expect(ctx?.token).toBe("sk-env-key-2");
  });

  it("returns null when no env var and custom dir does not exist", () => {
    const ctx = resolveKimiAuth({}, "/nonexistent/kimi-dir-" + Date.now());
    expect(ctx).toBeNull();
  });

  it("resolves credentials file referenced in config.toml and reads device_id", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "qc-auth-test-"));
    try {
      await fs.writeFile(path.join(tmp, "device_id"), "test-device-uuid\n");
      await fs.writeFile(
        path.join(tmp, "config.toml"),
        `
[providers."managed:kimi-code"]
base_url = "https://custom.kimi.internal/v1"

[providers."managed:kimi-code".oauth]
key = "oauth/kimi-code-env-abc123"
oauth_host = "https://auth.custom.kimi.internal"
`,
      );
      const credsDir = path.join(tmp, "credentials");
      await fs.mkdir(credsDir, { recursive: true });
      await fs.writeFile(
        path.join(credsDir, "kimi-code-env-abc123.json"),
        JSON.stringify({
          access_token: "tok-123",
          refresh_token: "rf-456",
          expires_at: 1800000000,
        }),
      );

      const ctx = resolveKimiAuth({}, tmp);
      expect(ctx).not.toBeNull();
      expect(ctx?.token).toBe("tok-123");
      expect(ctx?.deviceId).toBe("test-device-uuid");
      expect(ctx?.oauthHost).toBe("https://auth.custom.kimi.internal");
      expect(ctx?.baseUrl).toBe("https://custom.kimi.internal/v1");
      expect(ctx?.creds?.refresh_token).toBe("rf-456");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("scans credentials directory and selects newest .json file when config.toml has no key match", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "qc-auth-newest-"));
    try {
      const credsDir = path.join(tmp, "credentials");
      await fs.mkdir(credsDir, { recursive: true });

      const oldFile = path.join(credsDir, "old.json");
      await fs.writeFile(oldFile, JSON.stringify({ access_token: "old-tok" }));
      const newFile = path.join(credsDir, "new.json");
      await fs.writeFile(newFile, JSON.stringify({ access_token: "new-tok" }));

      // Give newFile a newer mtime
      const now = Date.now() / 1000;
      await fs.utimes(oldFile, now - 100, now - 100);
      await fs.utimes(newFile, now, now);

      const ctx = resolveKimiAuth({}, tmp);
      expect(ctx).not.toBeNull();
      expect(ctx?.token).toBe("new-tok");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("reads hosts and key only from the Kimi provider table, ignoring comments and other providers", () => {
    const cfg = readKimiProviderConfig(`
# base_url = "https://commented.example/v1"
[providers.openai]
base_url = "https://api.openai.com/v1"
api_key = "sk-other"

[providers."managed:kimi-code"]
base_url = "https://api.kimi.ai/coding/v1" # trailing comment

[providers."managed:kimi-code".oauth]
key = "oauth/kimi-code"
oauth_host = "https://auth.kimi.ai"

[providers.other.oauth]
key = "oauth/other"
oauth_host = "https://auth.other.example"
`);
    expect(cfg).toEqual({ baseUrl: "https://api.kimi.ai/coding/v1", oauthHost: "https://auth.kimi.ai", key: "oauth/kimi-code" });
  });

  it("never pairs a credential with another provider's base_url", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "qc-auth-scope-"));
    try {
      await fs.writeFile(path.join(tmp, "config.toml"), `[providers.openai]\nbase_url = "https://api.openai.com/v1"\n`);
      const credsDir = path.join(tmp, "credentials");
      await fs.mkdir(credsDir, { recursive: true });
      await fs.writeFile(path.join(credsDir, "kimi-code.json"), JSON.stringify({ access_token: "tok" }));
      const ctx = resolveKimiAuth({}, tmp);
      expect(ctx?.baseUrl).toBe("https://api.kimi.ai/coding/v1");
      expect(ctx?.oauthHost).toBe("https://auth.kimi.ai");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("lets environment overrides win over config and refuses a missing referenced credential", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "qc-auth-env-"));
    try {
      await fs.writeFile(
        path.join(tmp, "config.toml"),
        `[providers."managed:kimi-code"]\nbase_url = "https://cfg.example/v1"\n[providers."managed:kimi-code".oauth]\nkey = "oauth/named"\n`,
      );
      const credsDir = path.join(tmp, "credentials");
      await fs.mkdir(credsDir, { recursive: true });
      await fs.writeFile(path.join(credsDir, "other.json"), JSON.stringify({ access_token: "other-tok" }));
      // The named credential is missing: no fallback to an unrelated file.
      expect(resolveKimiAuth({}, tmp)).toBeNull();

      await fs.writeFile(path.join(credsDir, "named.json"), JSON.stringify({ access_token: "named-tok" }));
      const ctx = resolveKimiAuth({ KIMI_CODE_BASE_URL: "https://env.example/v1" }, tmp);
      expect(ctx?.token).toBe("named-tok");
      expect(ctx?.baseUrl).toBe("https://env.example/v1");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns null if credential files only contain empty strings", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "qc-auth-empty-"));
    try {
      const credsDir = path.join(tmp, "credentials");
      await fs.mkdir(credsDir, { recursive: true });
      await fs.writeFile(
        path.join(credsDir, "empty.json"),
        JSON.stringify({
          access_token: "",
          refresh_token: "   ",
          expires_at: 0,
        }),
      );

      const ctx = resolveKimiAuth({}, tmp);
      expect(ctx).toBeNull();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("parseKimiApiUsage", () => {
  const sampleUsages = {
    usage: {
      limit: "100",
      used: "1",
      remaining: "99",
      resetTime: "2026-09-29T00:25:17.281509Z",
    },
    limits: [
      {
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        detail: {
          limit: "100",
          used: "6",
          remaining: "94",
          resetTime: "2026-09-22T11:25:17.281509Z",
        },
      },
    ],
    usages: {
      limit_5h: { used_ratio: 0, reset_time: "2026-09-22T11:25:17Z" },
      limit_7d: { used_ratio: 0, reset_time: "2026-09-29T00:25:17Z" },
    },
  };

  const sampleMe = {
    user_level_name: "Allegretto",
    user_id: "test-user-123",
  };

  it("parses live payload format using limits and usage, capturing plan from meBody", () => {
    const now = new Date("2026-09-22T09:00:00Z");
    const q = parseKimiApiUsage(sampleUsages, sampleMe, now);
    expect(q.provider).toBe("kimi");
    expect(q.source).toBe("api");
    expect(q.plan).toBe("allegretto");
    expect(q.weeklyPct).toBe(1);
    expect(q.fiveHourPct).toBe(6);
    expect(q.resetsAt).toBe("2026-09-29T00:25:17.281Z");
    expect(new Date(q.periodStart).getTime()).toBe(new Date(q.resetsAt).getTime() - 7 * 86400000);
    expect(q.fetchedAt).toBe(now.toISOString());
  });

  it("falls back to legacy usages object when limits and usage are missing", () => {
    const legacyOnly = {
      usages: {
        limit_5h: { used_ratio: 0.42, reset_time: "2026-09-22T14:00:00Z" },
        limit_7d: { used_ratio: 0.15, reset_time: "2026-09-29T10:00:00Z" },
      },
    };
    const q = parseKimiApiUsage(legacyOnly, undefined, new Date("2026-09-22T09:00:00Z"));
    expect(q.plan).toBe("unknown");
    expect(q.weeklyPct).toBe(15);
    expect(q.fiveHourPct).toBe(42);
    expect(q.resetsAt).toBe("2026-09-29T10:00:00.000Z");
  });

  it("throws when weekly window is absent", () => {
    const invalid = { limits: sampleUsages.limits };
    expect(() => parseKimiApiUsage(invalid)).toThrow(/weekly pct not found/i);
  });

  it("throws when 5h window is absent", () => {
    const invalid = { usage: sampleUsages.usage };
    expect(() => parseKimiApiUsage(invalid)).toThrow(/5h pct not found/i);
  });

  it("throws when weekly reset time is missing or unparseable", () => {
    const invalid = {
      usage: { limit: "100", used: "5", resetTime: "not-a-date" },
      limits: sampleUsages.limits,
    };
    expect(() => parseKimiApiUsage(invalid)).toThrow(/weekly reset not found/i);
  });

  it("parses limit_month_total when present in usages object", () => {
    const now = new Date("2026-09-22T09:00:00Z");
    const payload = {
      ...sampleUsages,
      usages: {
        ...sampleUsages.usages,
        limit_month_total: { used_ratio: 0.7335, reset_time: "2026-09-29T00:00:00Z" },
      },
    };
    const q = parseKimiApiUsage(payload, sampleMe, now);
    expect(q.monthlyPct).toBe(73);
    expect(q.monthlyResetsAt).toBe("2026-09-29T00:00:00.000Z");
    expect(q.monthlyStatus).toBe("ok");
    expect(q.monthlyKind).toBe("included");
  });

  it("parses subscriptionBalance when present in API payload", () => {
    const now = new Date("2026-09-22T09:00:00Z");
    const payload = {
      ...sampleUsages,
      subscriptionBalance: {
        amountUsedRatio: 0.7335,
        expireTime: "2026-09-29T00:00:00Z",
      },
    };
    const q = parseKimiApiUsage(payload, sampleMe, now);
    expect(q.monthlyPct).toBe(73);
    expect(q.monthlyResetsAt).toBe("2026-09-29T00:00:00.000Z");
    expect(q.monthlyStatus).toBe("ok");
    expect(q.monthlyKind).toBe("included");
  });

  it("parses monthly duration from limits array when present", () => {
    const now = new Date("2026-09-22T09:00:00Z");
    const payload = {
      ...sampleUsages,
      limits: [
        ...sampleUsages.limits,
        {
          window: { duration: 30, timeUnit: "TIME_UNIT_DAY" },
          detail: { limit: "100", used: "55", remaining: "45", resetTime: "2026-09-29T00:00:00Z" },
        },
      ],
    };
    const q = parseKimiApiUsage(payload, sampleMe, now);
    expect(q.monthlyPct).toBe(55);
    expect(q.monthlyResetsAt).toBe("2026-09-29T00:00:00.000Z");
    expect(q.monthlyStatus).toBe("ok");
    expect(q.monthlyKind).toBe("included");
  });

  it("marks monthly status as exhausted when usage >= 100%", () => {
    const now = new Date("2026-09-22T09:00:00Z");
    const payload = {
      ...sampleUsages,
      usages: {
        ...sampleUsages.usages,
        limit_month_total: { used_ratio: 1.05, reset_time: "2026-09-29T00:00:00Z" },
      },
    };
    const q = parseKimiApiUsage(payload, sampleMe, now);
    expect(q.monthlyPct).toBe(100);
    expect(q.monthlyStatus).toBe("exhausted");
  });

  it("leaves monthly fields undefined when monthly quota is absent", () => {
    const now = new Date("2026-09-22T09:00:00Z");
    const q = parseKimiApiUsage(sampleUsages, sampleMe, now);
    expect(q.monthlyPct).toBeUndefined();
    expect(q.monthlyResetsAt).toBeUndefined();
    expect(q.monthlyKind).toBeUndefined();
  });

  const monthlyShapes: Array<[string, (ratio: number, reset?: string) => Record<string, unknown>]> = [
    [
      "limits",
      (ratio, reset) => ({
        ...sampleUsages,
        limits: [
          ...sampleUsages.limits,
          {
            window: { duration: 30, timeUnit: "TIME_UNIT_DAY" },
            detail: { limit: "1000", used: String(ratio * 1000), resetTime: reset },
          },
        ],
      }),
    ],
    [
      "limit_month_total",
      (ratio, reset) => ({
        ...sampleUsages,
        usages: { ...sampleUsages.usages, limit_month_total: { used_ratio: ratio, reset_time: reset } },
      }),
    ],
    [
      "subscriptionBalance",
      (ratio, reset) => ({ ...sampleUsages, subscriptionBalance: { amountUsedRatio: ratio, expireTime: reset } }),
    ],
  ];

  for (const [name, build] of monthlyShapes) {
    it(`${name}: decides monthly exhaustion from the raw ratio, not the rounded pct`, () => {
      const now = new Date("2026-09-22T09:00:00Z");
      const reset = "2026-09-29T00:00:00Z";
      const below = parseKimiApiUsage(build(0.995, reset), sampleMe, now);
      expect(below.monthlyStatus).toBe("ok");
      expect(below.monthlyPct).toBe(99);
      const at = parseKimiApiUsage(build(1, reset), sampleMe, now);
      expect(at.monthlyStatus).toBe("exhausted");
      expect(at.monthlyPct).toBe(100);
      const above = parseKimiApiUsage(build(1.05, reset), sampleMe, now);
      expect(above.monthlyStatus).toBe("exhausted");
      expect(above.monthlyPct).toBe(100);
    });

    it(`${name}: leaves the monthly reset undefined when omitted or malformed`, () => {
      const now = new Date("2026-09-22T09:00:00Z");
      for (const reset of [undefined, "not-a-date"]) {
        const q = parseKimiApiUsage(build(0.5, reset), sampleMe, now);
        expect(q.monthlyPct).toBe(50);
        expect(q.resetsAt).toBeDefined();
        expect(q.monthlyResetsAt).toBeUndefined();
      }
    });
  }
});

describe("pollKimiApi with mock fetch", () => {
  it("dispatches API requests with correct headers and returns parsed quota", async () => {
    const mockAuthCtx = {
      token: "test-token-123",
      deviceId: "dev-456",
      oauthHost: "https://auth.kimi.ai",
      baseUrl: "https://api.kimi.ai/coding/v1",
    };

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/usages")) {
        return new Response(
          JSON.stringify({
            usage: { limit: "100", used: "3", resetTime: "2026-09-29T00:00:00Z" },
            limits: [
              {
                window: { duration: 300 },
                detail: { limit: "100", used: "12", resetTime: "2026-09-22T12:00:00Z" },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/me")) {
        return new Response(JSON.stringify({ user_level_name: "Allegretto" }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock);
    try {
      const q = await pollKimiApi(mockAuthCtx);
      expect(q.provider).toBe("kimi");
      expect(q.source).toBe("api");
      expect(q.plan).toBe("allegretto");
      expect(q.weeklyPct).toBe(3);
      expect(q.fiveHourPct).toBe(12);

      const usageCall = fetchMock.mock.calls.find((c) => c[0].endsWith("/usages"));
      expect(usageCall).toBeDefined();
      expect(usageCall[1].headers["Authorization"]).toBe("Bearer test-token-123");
      expect(usageCall[1].headers["X-Msh-Device-Id"]).toBe("dev-456");
      expect(usageCall[1].headers["User-Agent"]).toBe("kimi-code-cli/2.0.2");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refreshes expired token and writes rotated token back to disk", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "qc-kimi-rf-"));
    const credPath = path.join(tmpDir, "creds.json");
    await fs.writeFile(
      credPath,
      JSON.stringify({
        access_token: "old-access",
        refresh_token: "valid-rf",
        expires_at: 0, // expired
      }),
      { mode: 0o600 },
    );

    const mockAuthCtx = {
      token: "old-access",
      credPath,
      creds: {
        access_token: "old-access",
        refresh_token: "valid-rf",
        expires_at: 0,
      },
      deviceId: "dev-456",
      oauthHost: "https://auth.kimi.ai",
      baseUrl: "https://api.kimi.ai/coding/v1",
    };

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/api/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token: "new-access-token",
            refresh_token: "new-rotated-rf",
            expires_in: 900,
          }),
          { status: 200 },
        );
      }
      return new Response("Not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock);
    try {
      const freshToken = await ensureFreshKimiToken(mockAuthCtx);
      expect(freshToken).toBe("new-access-token");
      expect(mockAuthCtx.creds.access_token).toBe("new-access-token");
      expect(mockAuthCtx.creds.refresh_token).toBe("new-rotated-rf");

      // Verify written to disk
      const onDisk = JSON.parse(await fs.readFile(credPath, "utf8"));
      expect(onDisk.access_token).toBe("new-access-token");
      expect(onDisk.refresh_token).toBe("new-rotated-rf");
      expect(onDisk.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect((await fs.stat(credPath)).mode & 0o777).toBe(0o600);
      expect(await fs.readdir(tmpDir)).toEqual(["creds.json"]);
    } finally {
      vi.unstubAllGlobals();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("adopts a token the CLI refreshed on disk instead of refreshing again", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "qc-kimi-adopt-"));
    const credPath = path.join(tmpDir, "creds.json");
    const future = Math.floor(Date.now() / 1000) + 3600;
    await fs.writeFile(credPath, JSON.stringify({ access_token: "cli-access", refresh_token: "cli-rf", expires_at: future }));
    const ctx = {
      token: "old-access",
      credPath,
      creds: { access_token: "old-access", refresh_token: "old-rf", expires_at: 0 },
      oauthHost: "https://auth.kimi.ai",
      baseUrl: "https://api.kimi.ai/coding/v1",
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect(await ensureFreshKimiToken(ctx)).toBe("cli-access");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(JSON.parse(await fs.readFile(credPath, "utf8")).refresh_token).toBe("cli-rf");
    } finally {
      vi.unstubAllGlobals();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not overwrite credentials the CLI changed during the refresh", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "qc-kimi-race-"));
    const credPath = path.join(tmpDir, "creds.json");
    await fs.writeFile(credPath, JSON.stringify({ access_token: "old-access", refresh_token: "old-rf", expires_at: 0 }));
    const ctx = {
      token: "old-access",
      credPath,
      creds: { access_token: "old-access", refresh_token: "old-rf", expires_at: 0 },
      oauthHost: "https://auth.kimi.ai",
      baseUrl: "https://api.kimi.ai/coding/v1",
    };
    const cliWrite = JSON.stringify({ access_token: "cli-access", refresh_token: "cli-rf", expires_at: 1 });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        await fs.writeFile(credPath, cliWrite);
        return new Response(JSON.stringify({ access_token: "qc-access", refresh_token: "qc-rf", expires_in: 900 }), { status: 200 });
      }),
    );
    try {
      expect(await ensureFreshKimiToken(ctx)).toBe("qc-access");
      expect(await fs.readFile(credPath, "utf8")).toBe(cliWrite);
    } finally {
      vi.unstubAllGlobals();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.getuid?.() === 0)("throws KimiCredentialWriteError when the rotated token cannot be saved", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "qc-kimi-ro-"));
    const credPath = path.join(tmpDir, "creds.json");
    await fs.writeFile(credPath, JSON.stringify({ access_token: "old-access", refresh_token: "old-rf", expires_at: 0 }));
    const ctx = {
      token: "old-access",
      credPath,
      creds: { access_token: "old-access", refresh_token: "old-rf", expires_at: 0 },
      oauthHost: "https://auth.kimi.ai",
      baseUrl: "https://api.kimi.ai/coding/v1",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: "qc-access", refresh_token: "qc-rf" }), { status: 200 })),
    );
    await fs.chmod(tmpDir, 0o500);
    try {
      await expect(ensureFreshKimiToken(ctx)).rejects.toBeInstanceOf(KimiCredentialWriteError);
    } finally {
      vi.unstubAllGlobals();
      await fs.chmod(tmpDir, 0o700);
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("kimiAdapter live poll", () => {
  it.skipIf(!process.env.QUOTACAP_LIVE_TUI)("polls live kimi TUI and returns correct Quota", async () => {
    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync("which", ["kimi"], { stdio: "ignore", timeout: 2000 });
    } catch {
      console.warn("live kimi poll skipped: kimi not on PATH");
      return;
    }
    // Drive the PTY path directly: kimiAdapter.poll() prefers the API when credentials exist.
    const q = await pollKimiPty();
    expect(q.provider).toBe("kimi");
    expect((q as unknown as { source: string }).source).toBe("tui");
    expect(q.weeklyPct).toBeGreaterThanOrEqual(0);
    expect(q.weeklyPct).toBeLessThanOrEqual(100);
    if (q.fiveHourPct !== undefined) {
      expect(q.fiveHourPct).toBeGreaterThanOrEqual(0);
      expect(q.fiveHourPct).toBeLessThanOrEqual(100);
    }
    expect(Number.isNaN(new Date(q.resetsAt).getTime())).toBe(false);
    expect(Number.isNaN(new Date(q.periodStart).getTime())).toBe(false);
    expect((q as any).raw.length).toBeGreaterThan(0);
    expect(q.fetchedAt).toBeDefined();
  }, 15000);
});
