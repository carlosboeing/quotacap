// Heartbeat-lock ownership of the data directory (decision D1).
// Pure fs + crypto: no sqlite import, so this module loads identically
// under Node and Bun. PID is diagnostics only, never proof of liveness.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { VERSION } from "../version.js";

export interface ClaimInfo {
  nonce: string;
  pid: number;
  startedAt: string;
  version: string;
  exec: string;
  lastBeat: string;
}

export interface AcquireOptions {
  beatIntervalMs?: number;
  staleMs?: number;
  graceMs?: number;
  rounds?: number;
}

export class AlreadyRunningError extends Error {
  holder: ClaimInfo | null;
  constructor(holder: ClaimInfo | null) {
    super(
      holder
        ? `already running (pid ${holder.pid}, started ${holder.startedAt})`
        : "already running",
    );
    this.name = "AlreadyRunningError";
    this.holder = holder;
  }
}

export interface Claim {
  info: ClaimInfo;
  verify(): boolean;
  release(): void;
}

export function lockPath(dataDir: string): string {
  return path.join(dataDir, "service.lock");
}

export function readClaim(dataDir: string): ClaimInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath(dataDir), "utf8"));
    if (typeof parsed?.nonce !== "string" || !parsed.nonce) return null;
    if (!Number.isInteger(parsed.pid)) return null;
    if (
      typeof parsed.lastBeat !== "string" ||
      Number.isNaN(new Date(parsed.lastBeat).getTime())
    ) {
      return null;
    }
    return parsed as ClaimInfo;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function startHeartbeat(
  file: string,
  mine: ClaimInfo,
  beatIntervalMs: number,
): Claim {
  const dataDir = path.dirname(file);
  let timer: ReturnType<typeof setInterval> | null = null;
  let lost = false;
  const beat = () => {
    const current = readClaim(dataDir);
    if (!current || current.nonce !== mine.nonce) {
      // Stolen or removed: stop beating; verify() reports the loss.
      lost = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      return;
    }
    mine.lastBeat = new Date().toISOString();
    try {
      fs.writeFileSync(file, JSON.stringify(mine) + "\n", { encoding: "utf8" });
    } catch {}
  };
  timer = setInterval(beat, beatIntervalMs);
  return {
    info: mine,
    verify() {
      if (lost) return false;
      const current = readClaim(dataDir);
      return !!current && current.nonce === mine.nonce;
    },
    release() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      const current = readClaim(dataDir);
      if (current && current.nonce === mine.nonce) {
        try {
          fs.rmSync(file, { force: true });
        } catch {}
      }
    },
  };
}

export async function acquireClaim(
  dataDir: string,
  opts?: AcquireOptions,
): Promise<Claim> {
  const beatIntervalMs = opts?.beatIntervalMs ?? 5000;
  const staleMs = opts?.staleMs ?? 30000;
  const graceMs = opts?.graceMs ?? 10000;
  const rounds = opts?.rounds ?? 3;

  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dataDir, 0o700);
    } catch {}
  } catch {}

  const file = lockPath(dataDir);
  const startedAt = new Date().toISOString();
  const mine: ClaimInfo = {
    nonce: crypto.randomUUID(),
    pid: process.pid,
    startedAt,
    version: VERSION,
    exec: process.execPath,
    lastBeat: startedAt,
  };

  for (let round = 0; round < rounds; round++) {
    try {
      const fd = fs.openSync(
        file,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o644,
      );
      try {
        fs.writeSync(fd, JSON.stringify(mine) + "\n");
      } finally {
        fs.closeSync(fd);
      }
      return startHeartbeat(file, mine, beatIntervalMs);
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;
    }

    const holder = readClaim(dataDir);
    const age = holder ? Date.now() - new Date(holder.lastBeat).getTime() : Infinity;
    if (holder && age < staleMs) {
      throw new AlreadyRunningError(holder);
    }
    // Stale or unreadable: grace wait, re-read, only then unlink-and-retry.
    // The re-read protects an owner mid-beat whose file we caught half-written.
    await delay(graceMs);
    const recheck = readClaim(dataDir);
    const reAge = recheck
      ? Date.now() - new Date(recheck.lastBeat).getTime()
      : Infinity;
    if (recheck && reAge < staleMs) {
      throw new AlreadyRunningError(recheck);
    }
    try {
      fs.rmSync(file, { force: true });
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
    }
    mine.lastBeat = new Date().toISOString();
  }
  throw new AlreadyRunningError(readClaim(dataDir));
}
