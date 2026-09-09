import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../src/store/db.js";
import { getAttempts } from "../../src/store/attempts.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, "helpers", "fake-provider.mjs");

const procs: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const p of procs.splice(0)) {
    try {
      p.kill("SIGKILL");
    } catch {}
  }
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function mkHome(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "qc-life-"));
  dirs.push(d);
  return d;
}

function dataDir(home: string): string {
  return path.join(home, ".quotacap");
}

function writeConfig(
  home: string,
  cfg: { port: number; pollMinutes?: number; enabledProviders?: string[] },
): void {
  fs.mkdirSync(dataDir(home), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir(home), "config.json"),
    JSON.stringify({
      port: cfg.port,
      pollMinutes: cfg.pollMinutes ?? 60,
      enabledProviders: cfg.enabledProviders ?? ["manual"],
    }),
  );
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

interface Spawned {
  child: ChildProcess;
  out: () => { stdout: string; stderr: string };
}

function spawnDaemon(
  home: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Spawned {
  const child = spawn("node", ["dist/cli/index.js", "daemon", ...args], {
    env: { ...process.env, QUOTACAP_HOME: home, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d) => {
    stdout += String(d);
  });
  child.stderr?.on("data", (d) => {
    stderr += String(d);
  });
  return { child, out: () => ({ stdout, stderr }) };
}

function waitExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitHealth(port: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (r.status === 200) return;
    } catch {}
    if (Date.now() >= deadline) throw new Error(`health never came up on ${port}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function healthRefused(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return false;
  } catch {
    return true;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  cond: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
}

function fakeBin(home: string, name: string): string {
  const binDir = path.join(home, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const dest = path.join(binDir, name);
  fs.copyFileSync(FAKE, dest);
  fs.chmodSync(dest, 0o755);
  return binDir;
}

function attemptsOf(home: string): ReturnType<typeof getAttempts> {
  const db = openDb(path.join(dataDir(home), "quotacap.db"));
  try {
    return getAttempts(db);
  } finally {
    db.close();
  }
}

describe("service lifecycle", () => {
  it("(a) two simultaneous starts: one serves, the other exits 1", async () => {
    const home = mkHome();
    const port = await getFreePort();
    writeConfig(home, { port });
    const d1 = spawnDaemon(home, ["--port", String(port)]);
    const d2 = spawnDaemon(home, ["--port", String(port)]);
    const [c1, c2] = await Promise.all([
      waitExit(d1.child, 15000),
      waitExit(d2.child, 15000),
    ]);
    const exited = [
      { code: c1, out: d1.out() },
      { code: c2, out: d2.out() },
    ];
    const losers = exited.filter((e) => e.code !== null);
    const winners = exited.filter((e) => e.code === null);
    expect(losers).toHaveLength(1);
    expect(winners).toHaveLength(1);
    expect(losers[0].code).toBe(1);
    expect(losers[0].out.stderr).toMatch(/already running/);
    // The winner serves.
    await waitHealth(port);
    const winner = c1 === null ? d1 : d2;
    winner.child.kill("SIGTERM");
    expect(await waitExit(winner.child, 10000)).toBe(0);
  }, 30000);

  it("(b) second start with a different --port is refused the same way", async () => {
    const home = mkHome();
    const p1 = await getFreePort();
    const p2 = await getFreePort();
    writeConfig(home, { port: p1 });
    const d1 = spawnDaemon(home, ["--port", String(p1)]);
    try {
      await waitHealth(p1);
      const d2 = spawnDaemon(home, ["--port", String(p2)]);
      expect(await waitExit(d2.child, 15000)).toBe(1);
      expect(d2.out().stderr).toMatch(/already running/);
      // Owner still serves its own port.
      await waitHealth(p1);
    } finally {
      d1.child.kill("SIGTERM");
      expect(await waitExit(d1.child, 10000)).toBe(0);
    }
  }, 30000);

  it("(c) occupied port: bind failure exits non-zero with no claim and no poll", async () => {
    const home = mkHome();
    const port = await getFreePort();
    writeConfig(home, { port });
    const occupant = net.createServer();
    await new Promise<void>((resolve) => occupant.listen(port, "127.0.0.1", resolve));
    try {
      const d = spawnDaemon(home, ["--port", String(port)]);
      const code = await waitExit(d.child, 15000);
      expect(code).not.toBe(0);
      expect(d.out().stderr).toMatch(/EADDRINUSE|already in use/i);
      expect(fs.existsSync(path.join(dataDir(home), "service.lock"))).toBe(false);
      expect(attemptsOf(home)).toEqual([]);
    } finally {
      occupant.close();
    }
  }, 30000);

  it("(d) invalid config exits non-zero with no residue", async () => {
    const home = mkHome();
    fs.mkdirSync(dataDir(home), { recursive: true });
    fs.writeFileSync(path.join(dataDir(home), "config.json"), "{bad json");
    const d = spawnDaemon(home, []);
    const code = await waitExit(d.child, 15000);
    expect(code).not.toBe(0);
    expect(d.out().stderr).toMatch(/invalid config/);
    expect(fs.existsSync(path.join(dataDir(home), "service.lock"))).toBe(false);
    expect(fs.existsSync(path.join(dataDir(home), "quotacap.db"))).toBe(false);
  }, 30000);

  it("(e) SIGTERM during a hanging-provider poll reaps, closes and releases", async () => {
    const home = mkHome();
    const port = await getFreePort();
    writeConfig(home, { port, enabledProviders: ["claude"] });
    const binDir = fakeBin(home, "claude");
    const pidFile = path.join(home, "fake.pid");
    const d = spawnDaemon(home, ["--port", String(port)], {
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      QC_FAKE_MODE: "hang",
      QC_FAKE_PIDFILE: pidFile,
    });
    await waitHealth(port);
    await waitFor(() => fs.existsSync(pidFile), 10000, "hanging provider to spawn");
    const pid = parseInt(fs.readFileSync(pidFile, "utf8"), 10);
    expect(isPidAlive(pid)).toBe(true);
    d.child.kill("SIGTERM");
    expect(await waitExit(d.child, 15000)).toBe(0);
    await waitFor(() => !isPidAlive(pid), 2000, `pid ${pid} to die`);
    expect(fs.existsSync(path.join(dataDir(home), "service.lock"))).toBe(false);
    expect(await healthRefused(port)).toBe(true);
    // The in-flight poll was closed before it could write.
    expect(attemptsOf(home)).toEqual([]);
  }, 30000);

  it("(f) second SIGTERM force-exits a stuck shutdown", async () => {
    const home = mkHome();
    const port = await getFreePort();
    writeConfig(home, { port, enabledProviders: ["claude"] });
    const binDir = fakeBin(home, "claude");
    const pidFile = path.join(home, "fake.pid");
    const d = spawnDaemon(home, ["--port", String(port)], {
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      QC_FAKE_MODE: "hang",
      QC_FAKE_PIDFILE: pidFile,
      QC_FAKE_IGNORE_TERM: "1",
    });
    await waitHealth(port);
    await waitFor(() => fs.existsSync(pidFile), 10000, "hanging provider to spawn");
    const pid = parseInt(fs.readFileSync(pidFile, "utf8"), 10);
    d.child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 250));
    d.child.kill("SIGTERM");
    try {
      expect(await waitExit(d.child, 10000)).toBe(1);
    } finally {
      // Force exit orphans the TERM-ignoring fake; reap it here.
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }, 30000);

  it("(g) stop then start restarts and serves", async () => {
    const home = mkHome();
    const port = await getFreePort();
    writeConfig(home, { port });
    const d1 = spawnDaemon(home, ["--port", String(port)]);
    await waitHealth(port);
    d1.child.kill("SIGTERM");
    expect(await waitExit(d1.child, 10000)).toBe(0);
    const d2 = spawnDaemon(home, ["--port", String(port)]);
    try {
      await waitHealth(port);
    } finally {
      d2.child.kill("SIGTERM");
      expect(await waitExit(d2.child, 10000)).toBe(0);
    }
  }, 30000);

  it("(h) legacy daemon.pid is removed on clean start", async () => {
    const home = mkHome();
    const port = await getFreePort();
    writeConfig(home, { port });
    fs.writeFileSync(path.join(dataDir(home), "daemon.pid"), "12345\n");
    const d = spawnDaemon(home, ["--port", String(port)]);
    try {
      await waitHealth(port);
      expect(fs.existsSync(path.join(dataDir(home), "daemon.pid"))).toBe(false);
    } finally {
      d.child.kill("SIGTERM");
      expect(await waitExit(d.child, 10000)).toBe(0);
    }
  }, 30000);
});
