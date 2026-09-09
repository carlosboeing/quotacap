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
  /**
   * Test seam. `beforeStaleUnlink` is awaited between the last read of a
   * stale claim and the unlink that removes it, so a test can drive the one
   * interleaving that unlink has to survive: the old owner releasing and a
   * new owner creating a lock in that window.
   */
  hooks?: { beforeStaleUnlink?: () => void | Promise<void> };
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

// Stale recovery runs under this mutex, so read-verify-remove-create is one
// critical section across processes. Without it two processes can both read
// the same stale claim and the slower one unlinks the winner's fresh lock.
function takeoverPath(dataDir: string): string {
  return path.join(dataDir, "service.lock.takeover");
}

function inodeOf(target: string | number): number | null {
  try {
    const st =
      typeof target === "number" ? fs.fstatSync(target) : fs.statSync(target);
    return st.ino;
  } catch {
    return null;
  }
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

// The heartbeat writes through the descriptor opened when the lock was
// created, never by path. A process that lost the lock therefore writes to
// the unlinked inode it still owns and can never overwrite the new holder's
// file, which a separate read-then-write-by-path could do.
function startHeartbeat(
  file: string,
  fd: number,
  mine: ClaimInfo,
  beatIntervalMs: number,
): Claim {
  const dataDir = path.dirname(file);
  const myInode = inodeOf(fd);
  let timer: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  let lost = false;

  const stillMine = (): boolean => {
    if (lost) return false;
    const current = readClaim(dataDir);
    if (!current || current.nonce !== mine.nonce) return false;
    // A replaced lock file is a different inode even with a copied nonce.
    if (myInode !== null && inodeOf(file) !== myInode) return false;
    return true;
  };

  const stopTimer = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const beat = () => {
    if (!stillMine()) {
      // Stolen or removed: stop beating; verify() reports the loss.
      lost = true;
      stopTimer();
      return;
    }
    mine.lastBeat = new Date().toISOString();
    const line = `${JSON.stringify(mine)}\n`;
    try {
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, line, 0, "utf8");
    } catch {}
  };
  timer = setInterval(beat, beatIntervalMs);
  return {
    info: mine,
    verify() {
      return stillMine();
    },
    release() {
      stopTimer();
      const mustUnlink = stillMine();
      if (!closed) {
        closed = true;
        try {
          fs.closeSync(fd);
        } catch {}
      }
      if (mustUnlink) {
        try {
          fs.rmSync(file, { force: true });
        } catch {}
      }
    },
  };
}

// Best-effort mutex over stale recovery. A holder that dies leaves the file
// behind, so an entry older than staleMs is removed and retried.
function acquireTakeover(dataDir: string, staleMs: number): (() => void) | null {
  const file = takeoverPath(dataDir);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(
        file,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o644,
      );
      try {
        fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        try {
          fs.rmSync(file, { force: true });
        } catch {}
      };
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;
    }
    let observedIno: number | null = null;
    let age = Infinity;
    try {
      const st = fs.statSync(file);
      observedIno = st.ino;
      age = Date.now() - st.mtimeMs;
    } catch {}
    if (age < staleMs) return null;
    // Remove the entry examined above and no other. A process that took the
    // mutex between the stat and this unlink wrote a different inode, and
    // removing by path alone would drop its mutex while it still holds it.
    try {
      if (observedIno !== null && fs.statSync(file).ino !== observedIno) {
        return null;
      }
      fs.rmSync(file, { force: true });
    } catch {}
  }
  return null;
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

  const create = (): number | null => {
    try {
      return fs.openSync(
        file,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o644,
      );
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;
      return null;
    }
  };
  // A failed first write leaves no lock file behind for anyone to wait out.
  const claimWith = (fd: number): Claim => {
    try {
      mine.lastBeat = new Date().toISOString();
      fs.writeSync(fd, `${JSON.stringify(mine)}\n`, 0, "utf8");
    } catch (err) {
      try {
        fs.closeSync(fd);
      } catch {}
      try {
        fs.rmSync(file, { force: true });
      } catch {}
      throw err;
    }
    const claim = startHeartbeat(file, fd, mine, beatIntervalMs);
    // Confirm the file on disk is still the one just written. Another
    // process recovering a stale claim can unlink between the create and
    // this read, and a claim that was never really held must fail startup
    // rather than run until its first ownership check.
    if (!claim.verify()) {
      claim.release();
      throw new AlreadyRunningError(readClaim(dataDir));
    }
    return claim;
  };

  for (let round = 0; round < rounds; round++) {
    const fresh = create();
    if (fresh !== null) return claimWith(fresh);

    const holder = readClaim(dataDir);
    const age = holder ? Date.now() - new Date(holder.lastBeat).getTime() : Infinity;
    if (holder && age < staleMs) {
      throw new AlreadyRunningError(holder);
    }

    // Stale or unreadable. Take the recovery mutex so the grace wait, the
    // re-read, the unlink and the create are one critical section: a
    // contender must wait for it and then sees this process's fresh claim.
    const releaseTakeover = acquireTakeover(dataDir, staleMs);
    if (releaseTakeover === null) {
      // Another process is recovering. Let it finish, then retry.
      await delay(graceMs);
      continue;
    }
    try {
      // The re-read protects an owner mid-beat whose file we caught
      // half-written, and an owner that started while we queued here.
      await delay(graceMs);
      const recheck = readClaim(dataDir);
      const reAge = recheck
        ? Date.now() - new Date(recheck.lastBeat).getTime()
        : Infinity;
      if (recheck && reAge < staleMs) {
        throw new AlreadyRunningError(recheck);
      }
      // Identity of the file this round decided to remove. Creation and
      // release never take the takeover mutex, so between the read above and
      // the unlink below the old owner can release and a third process can
      // create a fresh lock. Unlinking by path alone would delete that new
      // owner's file, leaving two processes each believing they hold one.
      const observedIno = inodeOf(file);
      const observedNonce = recheck?.nonce ?? null;
      if (opts?.hooks?.beforeStaleUnlink) {
        await opts.hooks.beforeStaleUnlink();
      }
      const current = readClaim(dataDir);
      if (
        inodeOf(file) !== observedIno ||
        (current?.nonce ?? null) !== observedNonce
      ) {
        // Replaced while we waited: not the stale file we examined, so not
        // ours to remove.
        if (current) throw new AlreadyRunningError(current);
        continue;
      }
      try {
        fs.rmSync(file, { force: true });
      } catch (err: any) {
        if (err.code !== "ENOENT") throw err;
      }
      const stolen = create();
      if (stolen !== null) return claimWith(stolen);
    } finally {
      releaseTakeover();
    }
  }
  throw new AlreadyRunningError(readClaim(dataDir));
}
