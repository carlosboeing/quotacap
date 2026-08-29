import { describe, it, expect, afterEach } from "vitest";
import { isDaemonRunning, startDaemon } from "../src/daemon.js";
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

  it("refuses a second instance when a real daemon holds the pidfile", async () => {
    isolatedHome();
    const env = { ...process.env, QUOTACAP_HOME: home };
    const first = spawn("node", ["dist/cli/index.js", "daemon"], { env, stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 1500));
      const { stdout } = await exec("node", ["dist/cli/index.js", "daemon"], { env });
      expect(stdout).toMatch(/already running/);
      expect(fs.existsSync(path.join(home, ".quotacap", "daemon.pid"))).toBe(true);
    } finally {
      first.kill("SIGINT");
      await new Promise((r) => first.on("exit", r));
    }
  }, 15000);

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
});