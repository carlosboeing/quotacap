import { describe, it, expect, afterEach, vi } from "vitest";
import {
  isDaemonRunning,
  startDaemon,
  resolveClaudeExecPath,
} from "../src/daemon.js";
import type { ServiceHandle } from "../src/daemon.js";
import { acquireClaim, type Claim } from "../src/runtime/owner.js";
import { AlreadyRunningError } from "../src/runtime/owner.js";
import { claudeAdapter } from "../src/adapters/claude.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const oldQcHome = process.env.QUOTACAP_HOME;
let home: string;
const handles: ServiceHandle[] = [];
const claims: Claim[] = [];

function isolatedHome() {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "qc-daemon-"));
  process.env.QUOTACAP_HOME = home;
  fs.mkdirSync(path.join(home, ".quotacap"), { recursive: true });
  // Manual-only: the async initial poll records `skipped` without children.
  fs.writeFileSync(
    path.join(home, ".quotacap", "config.json"),
    JSON.stringify({ pollMinutes: 60, enabledProviders: ["manual"] }),
  );
}

function dataDir(): string {
  return path.join(home, ".quotacap");
}

afterEach(async () => {
  for (const h of handles.splice(0)) {
    try {
      await h.stop();
    } catch {}
  }
  for (const c of claims.splice(0)) {
    try {
      c.release();
    } catch {}
  }
  process.env.QUOTACAP_HOME = oldQcHome;
  claudeAdapter.execPath = "claude";
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

describe("daemon single-instance", () => {
  it("writes a claim and token, and cleans up on stop", async () => {
    isolatedHome();
    const lockFile = path.join(dataDir(), "service.lock");
    const tokenFile = path.join(dataDir(), "token");
    const started = await startDaemon({ port: 0, signals: false });
    handles.push(started);
    expect(fs.existsSync(lockFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockFile, "utf8")).pid).toBe(process.pid);
    expect(fs.existsSync(tokenFile)).toBe(true);
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    expect(token.length).toBeGreaterThan(0);
    expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(isDaemonRunning()).toBe(true);
    await started.stop();
    expect(fs.existsSync(lockFile)).toBe(false);
    expect(isDaemonRunning()).toBe(false);
  });

  it("calls exit(1) when a second concurrent start is attempted in-process", async () => {
    isolatedHome();
    const first = await startDaemon({ port: 0, signals: false });
    handles.push(first);
    const mockExit = vi.fn();
    await expect(
      startDaemon({ port: 0, signals: false, exit: mockExit }),
    ).rejects.toBeInstanceOf(AlreadyRunningError);
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("steals a stale claim after grace", async () => {
    isolatedHome();
    const lockFile = path.join(dataDir(), "service.lock");
    const dead = await acquireClaim(dataDir(), { beatIntervalMs: 3600_000 });
    claims.push(dead);
    const backdated = {
      ...dead.info,
      lastBeat: new Date(Date.now() - 120_000).toISOString(),
    };
    fs.writeFileSync(lockFile, JSON.stringify(backdated) + "\n");

    const daemon = await startDaemon({
      port: 0,
      signals: false,
      claim: { staleMs: 500, graceMs: 100 },
    });
    handles.push(daemon);
    expect(dead.verify()).toBe(false);
    expect(isDaemonRunning()).toBe(true);
    await daemon.stop();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  // The recycled-pid case is gone with the pidfile: ownership is a heartbeat
  // lockfile whose nonce (not any PID) decides, so a recycled pid can never
  // be mistaken for a running daemon. No PID-liveness checks exist anymore.

  it("treats a stale claim as not running", async () => {
    isolatedHome();
    const dead = await acquireClaim(dataDir(), { beatIntervalMs: 3600_000 });
    claims.push(dead);
    const backdated = {
      ...dead.info,
      lastBeat: new Date(Date.now() - 120_000).toISOString(),
    };
    fs.writeFileSync(
      path.join(dataDir(), "service.lock"),
      JSON.stringify(backdated) + "\n",
    );
    expect(isDaemonRunning()).toBe(false);
  });

  it("pins the absolute path of the claude binary into the adapter via injectable resolver", async () => {
    isolatedHome();
    const customBin = "/pinned/test/claude";
    const daemon = await startDaemon({
      port: 0,
      signals: false,
      resolveClaude: () => customBin,
    });
    handles.push(daemon);
    expect(claudeAdapter.execPath).toBe(customBin);
    await daemon.stop();
  });

  it("resolves claude executable path with default resolver", () => {
    const resolved = resolveClaudeExecPath();
    if (resolved) {
      expect(path.isAbsolute(resolved)).toBe(true);
      expect(resolved).toMatch(/claude$/);
    }
  });
});

describe("pollOnce", () => {
  it("flattens array-valued adapter poll results into the store", async () => {
    const { adapters } = await import("../src/adapters/index.js");
    const { pollOnce } = await import("../src/daemon.js");
    const { openDb, migrate } = await import("../src/store/db.js");
    const { getLatestByProvider } = await import("../src/store/quotas.js");
    const db = openDb(":memory:");
    migrate(db);

    adapters["test-dual"] = {
      id: "test-dual",
      requiresAuth: "none",
      async poll() {
        return [
          { provider: "test-dual:1", plan: "p1", usedPct: 10, resetsAt: new Date().toISOString(), periodStart: new Date().toISOString(), raw: "{}", source: "cli", fetchedAt: new Date().toISOString() },
          { provider: "test-dual:2", plan: "p2", usedPct: 20, resetsAt: new Date().toISOString(), periodStart: new Date().toISOString(), raw: "{}", source: "cli", fetchedAt: new Date().toISOString() },
        ];
      },
    };

    try {
      const results = await pollOnce(db, ["test-dual"]);
      expect(results[0].status).toBe("fulfilled");
      expect(getLatestByProvider(db, "test-dual:1")?.usedPct).toBe(10);
      expect(getLatestByProvider(db, "test-dual:2")?.usedPct).toBe(20);
    } finally {
      delete adapters["test-dual"];
    }
  });
});
