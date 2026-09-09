import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { adapters, pollAll } from "../../src/adapters/index.js";
import { runPty } from "../../src/adapters/pty.js";
import {
  trackedExecFile,
  clearAdapterSignal,
  liveChildCount,
  killAll,
} from "../../src/runtime/spawn.js";
import { createCoordinator, type Coordinator } from "../../src/runtime/poll.js";
import { openDb, migrate } from "../../src/store/db.js";
import { getLatestByProvider } from "../../src/store/quotas.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, "helpers", "fake-provider.mjs");

let ptyAvailable = false;
try {
  createRequire(import.meta.url).resolve("node-pty");
  ptyAvailable = true;
} catch {}

const dirs: string[] = [];
const testIds: string[] = [];
const coords: Coordinator[] = [];

afterEach(() => {
  for (const c of coords.splice(0)) {
    try {
      c.stop();
    } catch {}
  }
  try {
    killAll("SIGKILL");
  } catch {}
  for (const id of testIds.splice(0)) {
    delete adapters[id];
    clearAdapterSignal(id);
  }
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function mkHome(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "qc-cancel-"));
  dirs.push(d);
  return d;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(
  cond: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(25);
  }
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidDead(pid: number, timeoutMs: number): Promise<void> {
  await waitFor(() => !isPidAlive(pid), timeoutMs, `pid ${pid} to die`);
}

function quotaFor(provider: string, usedPct: number): any {
  const now = new Date().toISOString();
  return {
    provider,
    plan: "test",
    usedPct,
    resetsAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    periodStart: new Date(Date.now() - 7 * 86400000).toISOString(),
    source: "cli",
    fetchedAt: now,
  };
}

describe("cancellation reaches children", () => {
  it("(a) registry timeout aborts a hanging exec child", async () => {
    const dir = mkHome();
    const pidFile = path.join(dir, "fake.pid");
    adapters["test-hang"] = {
      id: "test-hang",
      requiresAuth: "none",
      async poll() {
        const { stdout } = await trackedExecFile(
          "test-hang",
          process.execPath,
          [FAKE, "--mode", "hang", "--pidfile", pidFile],
          {},
        );
        return JSON.parse(stdout);
      },
    };
    testIds.push("test-hang");
    const rows = await pollAll(["test-hang"], {
      timeouts: { "test-hang": 500 },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("rejected");
    expect(String((rows[0] as any).reason?.message ?? "")).toMatch(
      /timeout after 500ms/,
    );
    const pid = parseInt(fs.readFileSync(pidFile, "utf8"), 10);
    await waitForPidDead(pid, 2000);
    await waitFor(() => liveChildCount() === 0, 2000, "liveChildCount 0");
  }, 15000);

  it.skipIf(!ptyAvailable)(
    "(b) hanging PTY child with an aborted signal is reaped",
    async () => {
      const dir = mkHome();
      const pidFile = path.join(dir, "pty.pid");
      const controller = new AbortController();
      const p = runPty({
        file: process.execPath,
        args: [FAKE, "--mode", "hang", "--pidfile", pidFile],
        settleDelayMs: 200,
        input: "x",
        completionRegex: /never-matching-completion-xyz/,
        timeoutMs: 30000,
        signal: controller.signal,
        label: "test-pty",
      });
      await waitFor(
        () => fs.existsSync(pidFile),
        5000,
        "fake PTY child to start",
      );
      await sleep(400);
      controller.abort();
      await expect(p).rejects.toThrow(/pty aborted/);
      const pid = parseInt(fs.readFileSync(pidFile, "utf8"), 10);
      await waitForPidDead(pid, 2000);
      await waitFor(() => liveChildCount() === 0, 2000, "liveChildCount 0");
    },
    15000,
  );

  it("(c) slow-but-completing provider is not killed and its result stored", async () => {
    const dir = mkHome();
    const doneFile = path.join(dir, "done");
    const quota = quotaFor("test-slow", 33);
    adapters["test-slow"] = {
      id: "test-slow",
      requiresAuth: "none",
      async poll() {
        const { stdout } = await trackedExecFile(
          "test-slow",
          process.execPath,
          [
            FAKE,
            "--mode",
            "slow",
            "--delay-ms",
            "300",
            "--emit",
            JSON.stringify(quota),
            "--complete-mark",
            doneFile,
          ],
          {},
        );
        return JSON.parse(stdout);
      },
    };
    testIds.push("test-slow");
    const db = openDb(":memory:");
    migrate(db);
    const coord = createCoordinator({
      db,
      enabledProviders: ["test-slow"],
      pollFn: (enabled) =>
        pollAll(enabled, { timeouts: { "test-slow": 10000 } }),
    });
    coords.push(coord);
    const r = await coord.refresh();
    expect(r.fulfilled).toHaveLength(1);
    expect(fs.existsSync(doneFile)).toBe(true);
    expect(getLatestByProvider(db, "test-slow")?.usedPct).toBe(33);
    expect(liveChildCount()).toBe(0);
  }, 15000);

  it("(d) timeout of one adapter does not abort siblings", async () => {
    const dir = mkHome();
    const hangPid = path.join(dir, "hang.pid");
    const fastDone = path.join(dir, "fast.done");
    const fastQuota = quotaFor("test-fasta", 11);
    adapters["test-fasta"] = {
      id: "test-fasta",
      requiresAuth: "none",
      async poll() {
        const { stdout } = await trackedExecFile(
          "test-fasta",
          process.execPath,
          [
            FAKE,
            "--mode",
            "canned",
            "--emit",
            JSON.stringify(fastQuota),
            "--complete-mark",
            fastDone,
          ],
          {},
        );
        return JSON.parse(stdout);
      },
    };
    adapters["test-hangb"] = {
      id: "test-hangb",
      requiresAuth: "none",
      async poll() {
        const { stdout } = await trackedExecFile(
          "test-hangb",
          process.execPath,
          [FAKE, "--mode", "hang", "--pidfile", hangPid],
          {},
        );
        return JSON.parse(stdout);
      },
    };
    testIds.push("test-fasta", "test-hangb");
    const rows = await pollAll(["test-hangb", "test-fasta"], {
      timeouts: { "test-hangb": 400, "test-fasta": 5000 },
    });
    const fast = rows.find((r) => r.provider === "test-fasta")!;
    const hung = rows.find((r) => r.provider === "test-hangb")!;
    expect(fast.status).toBe("fulfilled");
    expect((fast as any).value.usedPct).toBe(11);
    expect(fs.existsSync(fastDone)).toBe(true);
    expect(hung.status).toBe("rejected");
    const pid = parseInt(fs.readFileSync(hangPid, "utf8"), 10);
    await waitForPidDead(pid, 2000);
    await waitFor(() => liveChildCount() === 0, 2000, "liveChildCount 0");
  }, 15000);

  it("killAll escalation never touches children spawned after the call", async () => {
    const dir = mkHome();
    const pidA = path.join(dir, "a.pid");
    const pidB = path.join(dir, "b.pid");
    const pa = trackedExecFile(
      "test-a",
      process.execPath,
      [FAKE, "--mode", "hang", "--pidfile", pidA],
      {},
    );
    pa.catch(() => {});
    await waitFor(() => fs.existsSync(pidA), 5000, "child A to start");
    killAll("SIGTERM", 200); // arms escalation against generation {A}
    // Spawn B after killAll: the sweep at +200ms must not reap it.
    const pb = trackedExecFile(
      "test-b",
      process.execPath,
      [FAKE, "--mode", "hang", "--pidfile", pidB],
      {},
    );
    pb.catch(() => {});
    await waitFor(() => fs.existsSync(pidB), 5000, "child B to start");
    await pa.then(
      () => {
        throw new Error("child A unexpectedly survived SIGTERM");
      },
      () => {},
    );
    await sleep(400); // past the escalation sweep
    const pid = parseInt(fs.readFileSync(pidB, "utf8"), 10);
    expect(isPidAlive(pid)).toBe(true);
    expect(liveChildCount()).toBe(1);
    killAll("SIGKILL", 0);
    await pb.then(
      () => {
        throw new Error("child B unexpectedly survived SIGKILL");
      },
      () => {},
    );
    expect(liveChildCount()).toBe(0);
  }, 15000);

  it("(e) killAll settles every adapter with no live children", async () => {
    const dir = mkHome();
    const pid1 = path.join(dir, "k1.pid");
    const pid2 = path.join(dir, "k2.pid");
    for (const [id, pidf] of [
      ["test-k1", pid1],
      ["test-k2", pid2],
    ] as const) {
      adapters[id] = {
        id,
        requiresAuth: "none",
        async poll() {
          const { stdout } = await trackedExecFile(
            id,
            process.execPath,
            [FAKE, "--mode", "hang", "--pidfile", pidf],
            {},
          );
          return JSON.parse(stdout);
        },
      };
      testIds.push(id);
    }
    const p = pollAll(["test-k1", "test-k2"], {
      timeouts: { "test-k1": 30000, "test-k2": 30000 },
    });
    await waitFor(
      () => fs.existsSync(pid1) && fs.existsSync(pid2),
      5000,
      "both fake children to start",
    );
    expect(liveChildCount()).toBe(2);
    killAll();
    const rows = await p;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "rejected")).toBe(true);
    expect(liveChildCount()).toBe(0);
    await waitForPidDead(parseInt(fs.readFileSync(pid1, "utf8"), 10), 2000);
    await waitForPidDead(parseInt(fs.readFileSync(pid2, "utf8"), 10), 2000);
  }, 15000);
});
