import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const BUN_SQLITE = "bun:sqlite";

function seedTakeoverDb(dir: string): void {
  const file = path.join(dir, "service.lock.takeover");
  let Database: new (path: string) => { exec(sql: string): unknown; close(): unknown };
  try {
    Database = require("node:sqlite").DatabaseSync;
  } catch {
    Database = require(BUN_SQLITE).Database;
  }
  const db = new Database(file);
  db.exec("PRAGMA user_version = 1");
  db.close();
}
import {
  acquireClaim,
  readClaim,
  AlreadyRunningError,
  type Claim,
} from "../../src/runtime/owner.js";
import { VERSION } from "../../src/version.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOLDER = path.join(here, "helpers", "claim-holder.mjs");

const claims: Claim[] = [];
const dirs: string[] = [];
const procs: ChildProcess[] = [];

afterEach(() => {
  for (const c of claims.splice(0)) {
    try {
      c.release();
    } catch {}
  }
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "qc-owner-"));
  dirs.push(d);
  return d;
}

function lockFile(dir: string): string {
  return path.join(dir, "service.lock");
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runHolder(args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [HOLDER, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.push(p);
    let stdout = "";
    let stderr = "";
    p.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    p.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("ownership claim", () => {
  it("(a) acquire creates service.lock with nonce/pid/version", async () => {
    const dir = mkHome();
    const claim = await acquireClaim(dir);
    claims.push(claim);
    const raw = JSON.parse(fs.readFileSync(lockFile(dir), "utf8"));
    expect(raw.nonce).toBe(claim.info.nonce);
    expect(typeof raw.nonce).toBe("string");
    expect(raw.nonce.length).toBeGreaterThan(0);
    expect(raw.pid).toBe(process.pid);
    expect(raw.version).toBe(VERSION);
    expect(raw.exec).toBe(process.execPath);
    expect(Number.isNaN(new Date(raw.startedAt).getTime())).toBe(false);
    expect(Number.isNaN(new Date(raw.lastBeat).getTime())).toBe(false);
    expect(readClaim(dir)?.nonce).toBe(claim.info.nonce);
    expect(claim.verify()).toBe(true);
  });

  it("(b) second in-process acquire throws AlreadyRunningError", async () => {
    const dir = mkHome();
    const first = await acquireClaim(dir);
    claims.push(first);
    const err = await acquireClaim(dir).then(
      () => {
        throw new Error("second acquire unexpectedly succeeded");
      },
      (e) => e,
    );
    expect(err).toBeInstanceOf(AlreadyRunningError);
    expect(err.holder?.nonce).toBe(first.info.nonce);
    expect(first.verify()).toBe(true);
  });

  it("(c) two node processes contend: exactly one holds", async () => {
    const dir = mkHome();
    const [r1, r2] = await Promise.all([
      runHolder(["--dir", dir, "--hold-ms", "2500"]),
      runHolder(["--dir", dir, "--hold-ms", "2500"]),
    ]);
    const held = [r1, r2].filter((r) => r.code === 0 && r.stdout.includes("HELD"));
    const contended = [r1, r2].filter(
      (r) => r.code === 1 && r.stdout.includes("CONTENDED:"),
    );
    if (held.length !== 1 || contended.length !== 1) {
      throw new Error(
        `contention failed: r1=${r1.code} ${JSON.stringify(r1.stdout)} ${JSON.stringify(r1.stderr)} | ` +
          `r2=${r2.code} ${JSON.stringify(r2.stdout)} ${JSON.stringify(r2.stderr)}`,
      );
    }
  }, 15000);

  it("(d) stale claim is stolen after grace by a new process", async () => {
    const dir = mkHome();
    // "dead" holder: heartbeat parked 1h out so it never fires during the test.
    const dead = await acquireClaim(dir, { beatIntervalMs: 3600_000 });
    claims.push(dead);
    const backdated = {
      ...dead.info,
      lastBeat: new Date(Date.now() - 120_000).toISOString(),
    };
    fs.writeFileSync(lockFile(dir), JSON.stringify(backdated) + "\n");
    const r = await runHolder([
      "--dir",
      dir,
      "--hold-ms",
      "500",
      "--stale-ms",
      "1000",
      "--grace-ms",
      "200",
    ]);
    if (r.code !== 0 || !r.stdout.includes("HELD")) {
      throw new Error(
        `steal failed: code=${r.code} ${JSON.stringify(r.stdout)} ${JSON.stringify(r.stderr)}`,
      );
    }
    // The stealer released on exit; the dead holder's claim is gone.
    expect(fs.existsSync(lockFile(dir))).toBe(false);
    expect(dead.verify()).toBe(false);
  }, 15000);

  it("three processes contending for one stale claim: exactly one wins", async () => {
    const dir = mkHome();
    const dead = await acquireClaim(dir, { beatIntervalMs: 3600_000 });
    claims.push(dead);
    fs.writeFileSync(
      lockFile(dir),
      JSON.stringify({
        ...dead.info,
        lastBeat: new Date(Date.now() - 120_000).toISOString(),
      }) + "\n",
    );
    const args = [
      "--dir",
      dir,
      "--hold-ms",
      "3000",
      "--stale-ms",
      "2000",
      "--grace-ms",
      "200",
    ];
    const results = await Promise.all([
      runHolder(args),
      runHolder(args),
      runHolder(args),
    ]);
    const held = results.filter((r) => r.code === 0 && r.stdout.includes("HELD"));
    const contended = results.filter(
      (r) => r.code === 1 && r.stdout.includes("CONTENDED:"),
    );
    if (held.length !== 1 || contended.length !== 2) {
      throw new Error(
        `stale contention failed: ${results
          .map((r) => `code=${r.code} ${JSON.stringify(r.stdout)} ${JSON.stringify(r.stderr)}`)
          .join(" | ")}`,
      );
    }
  }, 20000);

  it("recovery cannot delete a lock created after its final read", async () => {
    const dir = mkHome();
    const old = await acquireClaim(dir, { beatIntervalMs: 3600_000 });
    claims.push(old);
    fs.writeFileSync(
      lockFile(dir),
      JSON.stringify({
        ...old.info,
        lastBeat: new Date(Date.now() - 120_000).toISOString(),
      }) + "\n",
    );
    // The hook fires after the identity check and before unlink. Release and
    // a third-process create in that window must not become the owner: they
    // share the takeover mutex with recovery, so the child waits and then
    // sees the recovered claim. Do not await the child inside the hook —
    // that would deadlock on the mutex recovery still holds.
    let contender: Promise<RunResult> | undefined;
    const recovery = await acquireClaim(dir, {
      staleMs: 1000,
      graceMs: 10,
      rounds: 1,
      hooks: {
        beforeStaleUnlink: () => {
          old.release();
          contender = runHolder([
            "--dir",
            dir,
            "--hold-ms",
            "500",
            "--stale-ms",
            "1000",
            "--grace-ms",
            "50",
          ]);
        },
      },
    });
    claims.push(recovery);
    expect(recovery.verify()).toBe(true);
    expect(contender).toBeDefined();
    const child = await contender!;
    if (child.code !== 1 || !child.stdout.includes("CONTENDED:")) {
      throw new Error(
        `contender in unlink window: code=${child.code} ${JSON.stringify(child.stdout)} ${JSON.stringify(child.stderr)}`,
      );
    }
    expect(readClaim(dir)?.nonce).toBe(recovery.info.nonce);
  }, 15000);

  it("paused recovery past staleMs does not let a contender steal the claim", async () => {
    const dir = mkHome();
    const old = await acquireClaim(dir, { beatIntervalMs: 3600_000 });
    claims.push(old);
    fs.writeFileSync(
      lockFile(dir),
      JSON.stringify({
        ...old.info,
        lastBeat: new Date(Date.now() - 120_000).toISOString(),
      }) + "\n",
    );
    const staleMs = 200;
    let contender: Promise<RunResult> | undefined;
    const recovery = await acquireClaim(dir, {
      staleMs,
      graceMs: 10,
      rounds: 1,
      hooks: {
        beforeStaleUnlink: async () => {
          contender = runHolder([
            "--dir",
            dir,
            "--hold-ms",
            "500",
            "--stale-ms",
            String(staleMs),
            "--grace-ms",
            "50",
          ]);
          // Remain in the critical section longer than staleMs. Age-based
          // steal would drop the mutex here; the child would install a
          // claim that this process then unlinks.
          await new Promise((r) => setTimeout(r, staleMs + 150));
        },
      },
    });
    claims.push(recovery);
    expect(recovery.verify()).toBe(true);
    expect(contender).toBeDefined();
    const child = await contender!;
    if (child.code !== 1 || !child.stdout.includes("CONTENDED:")) {
      throw new Error(
        `contender stole paused recovery: code=${child.code} ${JSON.stringify(child.stdout)} ${JSON.stringify(child.stderr)}`,
      );
    }
    expect(readClaim(dir)?.nonce).toBe(recovery.info.nonce);
  }, 15000);

  it("a leftover takeover file from a dead process does not block acquire", async () => {
    const dir = mkHome();
    // Crash after creating the sidecar: the file remains, the fcntl lock does not.
    seedTakeoverDb(dir);
    const claim = await acquireClaim(dir, { staleMs: 1000, graceMs: 10 });
    claims.push(claim);
    expect(claim.verify()).toBe(true);
  });

  it("two processes recovering a leftover takeover file: exactly one claim", async () => {
    const dir = mkHome();
    seedTakeoverDb(dir);
    const dead = await acquireClaim(dir, { beatIntervalMs: 3600_000 });
    claims.push(dead);
    fs.writeFileSync(
      lockFile(dir),
      JSON.stringify({
        ...dead.info,
        lastBeat: new Date(Date.now() - 120_000).toISOString(),
      }) + "\n",
    );
    const args = [
      "--dir",
      dir,
      "--hold-ms",
      "2000",
      "--stale-ms",
      "1000",
      "--grace-ms",
      "50",
    ];
    const results = await Promise.all([runHolder(args), runHolder(args)]);
    const held = results.filter((r) => r.code === 0 && r.stdout.includes("HELD"));
    const contended = results.filter(
      (r) => r.code === 1 && r.stdout.includes("CONTENDED:"),
    );
    if (held.length !== 1 || contended.length !== 1) {
      throw new Error(
        `leftover takeover contention failed: ${results
          .map((r) => `code=${r.code} ${JSON.stringify(r.stdout)} ${JSON.stringify(r.stderr)}`)
          .join(" | ")}`,
      );
    }
    expect(dead.verify()).toBe(false);
  }, 20000);

  it("(e) release by a non-owner leaves the file", async () => {
    const dir = mkHome();
    const claim = await acquireClaim(dir, { beatIntervalMs: 3600_000 });
    claims.push(claim);
    const foreign = {
      ...claim.info,
      nonce: "foreign-nonce",
      lastBeat: new Date().toISOString(),
    };
    fs.writeFileSync(lockFile(dir), JSON.stringify(foreign) + "\n");
    claim.release();
    expect(fs.existsSync(lockFile(dir))).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockFile(dir), "utf8")).nonce).toBe(
      "foreign-nonce",
    );
  });

  it("(f) verify is false after the file is replaced", async () => {
    const dir = mkHome();
    const claim = await acquireClaim(dir, { beatIntervalMs: 3600_000 });
    claims.push(claim);
    expect(claim.verify()).toBe(true);
    const foreign = {
      ...claim.info,
      nonce: "other-nonce",
      lastBeat: new Date().toISOString(),
    };
    fs.writeFileSync(lockFile(dir), JSON.stringify(foreign) + "\n");
    expect(claim.verify()).toBe(false);
  });

  it("readClaim returns null when no claim exists", () => {
    expect(readClaim(mkHome())).toBeNull();
  });

  it("release waits out brief takeover contention and unlinks claim", async () => {
    const dir = mkHome();
    const claim = await acquireClaim(dir);
    claims.push(claim);

    const child = spawn(process.execPath, [
      "-e",
      `
      const { createRequire } = require("node:module");
      const req = createRequire(process.cwd() + "/");
      let Database;
      try { Database = req("node:sqlite").DatabaseSync; } catch { Database = req("bun:sqlite").Database; }
      const db = new Database("${path.join(dir, "service.lock.takeover")}");
      db.exec("BEGIN EXCLUSIVE;");
      process.stdout.write("LOCKED\\n");
      setTimeout(() => {
        try { db.exec("ROLLBACK;"); } catch {}
        try { db.close(); } catch {}
      }, 150);
      `,
    ]);
    procs.push(child);
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (d) => {
        if (String(d).includes("LOCKED")) resolve();
      });
      child.on("error", reject);
    });

    claim.release();
    expect(fs.existsSync(lockFile(dir))).toBe(false);
  });
});
