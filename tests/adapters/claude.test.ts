import { describe, it, expect } from "vitest";
import { parseClaudeUsage, claudeAdapter } from "../../src/adapters/claude.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sample = `You are currently using your subscription

Current session: 46% used · resets Aug 28 at 4:30pm (Australia/Brisbane)
Current week (all models): 25% used · resets Sep 3 at 9pm (Australia/Brisbane)
`;

describe("parseClaudeUsage", () => {
  it("parses 46% session and 25% weekly with Brisbane tz", () => {
    const q = parseClaudeUsage(sample, new Date("2026-08-28T06:00:00+10:00"));
    expect(q.weeklyPct).toBe(25);
    expect(q.fiveHourPct).toBe(46);
    expect(q.provider).toBe("claude");
    expect(q.resetsAt).toMatch(/2026-09-03/);
    expect(q.periodStart).toMatch(/^2026-08-27/);
  });

  it("fallback resetsAt/periodStart/fetchedAt are deterministic from now", () => {
    const now = new Date("2026-08-20T00:00:00+10:00");
    const q = parseClaudeUsage("no weekly match", now);
    expect(q.resetsAt).toBe(new Date(now.getTime() + 7 * 86400000).toISOString());
    expect(q.periodStart).toBe(new Date(now.getTime() - 7 * 86400000).toISOString());
    expect(q.fetchedAt).toBe(now.toISOString());
  });

  it("parses 0% session usage and handles missing timezone in resets", () => {
    const txt = `Current session: 0% used · resets 1:30pm\nCurrent week (all models): 10% used · resets Sep 17 at 9pm (Australia/Brisbane)\n`;
    const q = parseClaudeUsage(txt, new Date("2026-09-15T00:00:00Z"));
    expect(q.weeklyPct).toBe(10);
    expect(q.fiveHourPct).toBe(0);
  });
});

describe("pollAll isolation", () => {
  it("unknown provider resolves to rejected status without rejecting batch", async () => {
    const { pollAll } = await import("../../src/adapters/index.js");
    const res = await pollAll(["unknown-provider-xyz"]);
    expect(res).toHaveLength(1);
    expect(res[0].provider).toBe("unknown-provider-xyz");
    expect(res[0].status).toBe("rejected");
    expect((res[0] as { reason: Error }).reason).toBeInstanceOf(Error);
  });

  it("batch of unknowns all reject but Promise.all fulfills", async () => {
    const { pollAll } = await import("../../src/adapters/index.js");
    const res = await pollAll(["unknown1", "unknown2"]);
    expect(res).toHaveLength(2);
    expect(res[0].status).toBe("rejected");
    expect(res[1].status).toBe("rejected");
    expect(res[0].provider).toBe("unknown1");
    expect(res[1].provider).toBe("unknown2");
  });
});

describe("claudeAdapter execPath", () => {
  it("defaults execPath to 'claude'", () => {
    expect(claudeAdapter.execPath).toBe("claude");
  });

  it("executes the pinned execPath when polling", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qc-claude-test-"));
    const scriptPath = path.join(tmpDir, "mock-claude");
    const jsonOutput = JSON.stringify({ result: sample });
    fs.writeFileSync(scriptPath, `#!/bin/sh\nprintf '%s' '${jsonOutput}'\n`, { mode: 0o755 });

    const originalExecPath = claudeAdapter.execPath;
    try {
      claudeAdapter.execPath = scriptPath;
      const q = await claudeAdapter.poll();
      expect(q.provider).toBe("claude");
      expect(q.weeklyPct).toBe(25);
      expect(q.fiveHourPct).toBe(46);
    } finally {
      claudeAdapter.execPath = originalExecPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("polls with --strict-mcp-config so the headless claude starts no MCP servers", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qc-claude-test-"));
    const scriptPath = path.join(tmpDir, "mock-claude-args");
    const argsFile = path.join(tmpDir, "args");
    const jsonOutput = JSON.stringify({ result: sample });
    fs.writeFileSync(
      scriptPath,
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nprintf '%s' '${jsonOutput}'\n`,
      { mode: 0o755 },
    );

    try {
      await claudeAdapter.poll(scriptPath);
      const args = fs.readFileSync(argsFile, "utf8").trim().split("\n");
      expect(args).toEqual(["-p", "/usage", "--output-format", "json", "--strict-mcp-config"]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("allows passing an explicit execPath parameter to poll()", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qc-claude-test-"));
    const scriptPath = path.join(tmpDir, "mock-claude-arg");
    const jsonOutput = JSON.stringify({ result: sample });
    fs.writeFileSync(scriptPath, `#!/bin/sh\nprintf '%s' '${jsonOutput}'\n`, { mode: 0o755 });

    try {
      const q = await claudeAdapter.poll(scriptPath);
      expect(q.provider).toBe("claude");
      expect(q.weeklyPct).toBe(25);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
