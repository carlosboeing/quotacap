import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
});
