// Heartbeat-lock ownership of the data directory (decision D1).
// Pure fs + crypto: no sqlite import, so this module loads identically
// under Node and Bun. The claim file's PID is diagnostics only; lastBeat
// is liveness. The takeover mutex file's PID is liveness of that short
// critical section: steal it only when the writer is dead, never because
// the file is old.
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
   * Test seam. `beforeStaleUnlink` is awaited after the identity check and
   * before the unlink, so a test can drive release+create in that window
   * or hold the mutex past staleMs. Creation, release and recovery share
   * the takeover mutex; a live holder (including a paused one) keeps it.
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

// Creation, release and stale recovery share this mutex, so the unlink of a
// stale claim cannot land on a lock that another process just created.
// Ownership is the creating process, not mtime: a live holder that pauses
// past staleMs (debugger, SIGSTOP, machine sleep) must still exclude
// stealers. A holder that dies leaves the file behind; the next acquirer
// removes it only when that pid is gone.
function takeoverPath(dataDir: string): string {
  return path.join(dataDir, "service.lock.takeover");
}

// Same-process reentry: claimWith's failed verify calls release() while
// acquireClaim still holds the mutex, and that release must still unlink.
const heldTakeovers = new Set<string>();

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
  staleMs: number,
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
        const takeover = acquireTakeover(dataDir, staleMs);
        if (takeover) {
          try {
            if (stillMine()) {
              try {
                fs.rmSync(file, { force: true });
              } catch {}
            }
          } finally {
            takeover.unlock();
          }
        }
      }
    },
  };
}

interface TakeoverLock {
  unlock(): void;
  owns(): boolean;
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err.code === "ESRCH") return false;
    // EPERM: the process exists but we cannot signal it.
    return true;
  }
}

function takeoverPid(file: string): number | null {
  try {
    const n = parseInt(fs.readFileSync(file, "utf8"), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function acquireTakeover(dataDir: string, staleMs: number): TakeoverLock | null {
  const file = takeoverPath(dataDir);
  if (heldTakeovers.has(file)) {
    return { unlock() {}, owns: () => true };
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(
        file,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o644,
      );
      let ino: number;
      try {
        fs.writeSync(fd, `${process.pid}\n`);
        ino = fs.fstatSync(fd).ino;
      } catch (err) {
        try {
          fs.closeSync(fd);
        } catch {}
        try {
          fs.rmSync(file, { force: true });
        } catch {}
        throw err;
      }
      try {
        fs.closeSync(fd);
      } catch {}
      heldTakeovers.add(file);
      return {
        unlock() {
          heldTakeovers.delete(file);
          try {
            if (inodeOf(file) === ino) {
              fs.rmSync(file, { force: true });
            }
          } catch {}
        },
        owns() {
          return inodeOf(file) === ino;
        },
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
    const pid = takeoverPid(file);
    // A live writer keeps the mutex even when the file is older than
    // staleMs. Age only recovers a crash between create and write, where
    // there is no pid to probe.
    const writerGone = pid !== null ? !pidIsAlive(pid) : age >= staleMs;
    if (!writerGone) return null;
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
    const claim = startHeartbeat(file, fd, mine, beatIntervalMs, staleMs);
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
    // Wait for the mutex without burning a round: a live owner finishes
    // acquire in microseconds, and a recovery that holds it through grace
    // still refreshes the claim we will see on the next try.
    let takeover: TakeoverLock | null = null;
    for (;;) {
      takeover = acquireTakeover(dataDir, staleMs);
      if (takeover !== null) break;
      const holder = readClaim(dataDir);
      const age = holder ? Date.now() - new Date(holder.lastBeat).getTime() : Infinity;
      if (holder && age < staleMs) {
        throw new AlreadyRunningError(holder);
      }
      await delay(Math.min(50, graceMs));
    }
    if (!takeover) throw new AlreadyRunningError(readClaim(dataDir));
    const { unlock, owns } = takeover;
    try {
      const fresh = create();
      if (fresh !== null) return claimWith(fresh);

      const holder = readClaim(dataDir);
      const age = holder ? Date.now() - new Date(holder.lastBeat).getTime() : Infinity;
      if (holder && age < staleMs) {
        throw new AlreadyRunningError(holder);
      }

      // Stale or unreadable. Grace wait, re-read, unlink and create stay
      // one critical section: a contender must wait for the mutex and then
      // sees this process's fresh claim. Release takes the same mutex, so
      // the old owner cannot unlink between the identity check and this
      // unlink and open a hole for a third process to create into. A live
      // holder that pauses past staleMs still owns the mutex, so resume
      // cannot unlink a claim another process created in that gap.
      await delay(graceMs);
      const recheck = readClaim(dataDir);
      const reAge = recheck
        ? Date.now() - new Date(recheck.lastBeat).getTime()
        : Infinity;
      if (recheck && reAge < staleMs) {
        throw new AlreadyRunningError(recheck);
      }
      const observedIno = inodeOf(file);
      const observedNonce = recheck?.nonce ?? null;
      if (
        inodeOf(file) !== observedIno ||
        (readClaim(dataDir)?.nonce ?? null) !== observedNonce
      ) {
        const current = readClaim(dataDir);
        if (current) throw new AlreadyRunningError(current);
        continue;
      }
      if (opts?.hooks?.beforeStaleUnlink) {
        await opts.hooks.beforeStaleUnlink();
      }
      if (!owns()) continue;
      try {
        fs.rmSync(file, { force: true });
      } catch (err: any) {
        if (err.code !== "ENOENT") throw err;
      }
      const stolen = create();
      if (stolen !== null) return claimWith(stolen);
    } finally {
      unlock();
    }
  }
  throw new AlreadyRunningError(readClaim(dataDir));
}
