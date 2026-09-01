import { describe, it, expect, afterEach, vi } from "vitest";
import { isDaemonRunning, startDaemon, resolveClaudeExecPath } from "../src/daemon.js";
import { claudeAdapter } from "../src/adapters/claude.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const exec = promisify(execFile);

const oldHome = process.env.HOME;
const oldQcHome = process.env.QUOTACAP_HOME;
let home: string;

function isolatedHome() {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "qc-daemon-"));
  process.env.QUOTACAP_HOME = home;
}

afterEach(() => {
  process.env.HOME = oldHome;
  process.env.QUOTACAP_HOME = oldQcHome;
  claudeAdapter.execPath = "claude";
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

describe("daemon single-instance", () => {
  it("writes a pidfile and cleans up on stop", async () => {
    isolatedHome();
    const pidFile = path.join(home, ".quotacap", "daemon.pid");
    const first = await startDaemon();
    expect(fs.existsSync(pidFile)).toBe(true);
    expect(parseInt(fs.readFileSync(pidFile, "utf8"), 10)).toBe(process.pid);
    first.stop();
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("refuses a second instance when a real daemon holds the pidfile and exits non-zero", async () => {
    isolatedHome();
    const env = { ...process.env, QUOTACAP_HOME: home };
    const first = spawn("node", ["dist/cli/index.js", "daemon"], { env, stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 1500));
      let exitCode: number | null = null;
      let stderrOutput = "";
      try {
        await exec("node", ["dist/cli/index.js", "daemon"], { env });
      } catch (err: any) {
        exitCode = err.code;
        stderrOutput = err.stderr || "";
      }
      expect(exitCode).toBe(1);
      expect(stderrOutput).toMatch(/already running/);
      expect(fs.existsSync(path.join(home, ".quotacap", "daemon.pid"))).toBe(true);
    } finally {
      first.kill("SIGINT");
      await new Promise((r) => first.on("exit", r));
    }
  }, 15000);

  it("calls exit(1) when a second concurrent start is attempted in-process", async () => {
    isolatedHome();
    const first = await startDaemon();
    const mockExit = vi.fn();
    try {
      const second = await startDaemon({ exit: mockExit });
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(second.alreadyRunning).toBeDefined();
    } finally {
      first.stop();
    }
  });

  it("steals a stale pidfile when the recorded pid is dead", async () => {
    isolatedHome();
    const pidFile = path.join(home, ".quotacap", "daemon.pid");
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, "999999\n");
    expect(fs.existsSync(pidFile)).toBe(true);

    const daemon = await startDaemon();
    try {
      expect(daemon.alreadyRunning).toBeUndefined();
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(parseInt(fs.readFileSync(pidFile, "utf8"), 10)).toBe(process.pid);
    } finally {
      daemon.stop();
    }
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("treats a dead pidfile as not running", () => {
    isolatedHome();
    const pidFile = path.join(home, ".quotacap", "daemon.pid");
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, "999999");
    expect(isDaemonRunning(pidFile)).toBe(false);
  });

  it("does not claim a live non-quotacap pid (recycled pid protection)", () => {
    isolatedHome();
    const pidFile = path.join(home, ".quotacap", "daemon.pid");
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, String(process.pid));
    expect(isDaemonRunning(pidFile)).toBe(false);
  });

  it("pins the absolute path of the claude binary into the adapter via injectable resolver", async () => {
    isolatedHome();
    const customBin = "/pinned/test/claude";
    const daemon = await startDaemon({ resolveClaude: () => customBin });
    try {
      expect(claudeAdapter.execPath).toBe(customBin);
    } finally {
      daemon.stop();
    }
  });

  it("resolves claude executable path with default resolver", () => {
    const resolved = resolveClaudeExecPath();
    if (resolved) {
      expect(path.isAbsolute(resolved)).toBe(true);
      expect(resolved).toMatch(/claude$/);
    }
  });
});