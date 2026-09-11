// Service lifecycle: ordered startup, failed-start cleanup, ordered shutdown.
// Startup order: validate config → acquire claim → open+migrate DB → ensure
// token → bind HTTP → async initial poll → schedule. Readiness is config +
// storage + listener; it never waits for providers.
import fs from "node:fs";
import path from "node:path";
import { format } from "node:util";
import { execFileSync } from "node:child_process";
import {
  acquireClaim,
  AlreadyRunningError,
  type AcquireOptions,
  type Claim,
} from "./owner.js";
import { createCoordinator, type Coordinator } from "./poll.js";
import { killAll } from "./spawn.js";
import { ensureToken } from "./token.js";
import { openDb, migrate } from "../store/db.js";
import { getDbPath, isExperimentalIngestEnabled, readServiceConfig, readServiceMetadata, type Config } from "../config.js";
import { buildApp } from "../http/server.js";
import { VERSION } from "../version.js";
import { claudeAdapter } from "../adapters/claude.js";

export function resolveClaudeExecPath(): string | undefined {
  try {
    const resolved = execFileSync("which", ["claude"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return resolved.length > 0 ? resolved : undefined;
  } catch {
    return undefined;
  }
}

export interface StartServiceOptions {
  port?: number;
  dataDir?: string;
  exit?: (code: number) => void;
  signals?: boolean;
  claim?: AcquireOptions;
  resolveClaude?: () => string | undefined;
}

export interface ServiceState {
  dataDir: string;
  config: Config;
  coordinator: Coordinator;
}

export interface ServiceHandle {
  port: number;
  state: ServiceState;
  stop(): Promise<void>;
}

// QUOTACAP_LOG_FILE passthrough (decision D9): file logging with rotation
// (1MB trigger, 3 generations incl. current) rotated at startup. Foreground
// runs without the variable log to stdio. Log content stays operation
// summaries plus sanitized errors — never raw provider output.
function setupLogFile(): () => void {
  const logFile = process.env.QUOTACAP_LOG_FILE;
  if (!logFile) return () => {};
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
    try {
      const st = fs.statSync(logFile);
      if (st.size > 1024 * 1024) {
        try {
          fs.rmSync(`${logFile}.2`, { force: true });
        } catch {}
        try {
          fs.renameSync(`${logFile}.1`, `${logFile}.2`);
        } catch {}
        try {
          fs.renameSync(logFile, `${logFile}.1`);
        } catch {}
      }
    } catch {}
    const stream = fs.createWriteStream(logFile, { flags: "a", mode: 0o600 });
    try {
      fs.chmodSync(logFile, 0o600);
    } catch {}
    const orig = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    };
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      console.log = orig.log;
      console.info = orig.info;
      console.warn = orig.warn;
      console.error = orig.error;
      console.debug = orig.debug;
      try {
        stream.end();
      } catch {}
    };
    stream.on("error", (err) => {
      const first = !restored;
      restore();
      if (first) {
        orig.error(
          `[quotacap] log file error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
    const write = (...args: any[]) => {
      try {
        stream.write(`${format(...args)}\n`);
      } catch {}
    };
    console.log = write;
    console.info = write;
    console.warn = write;
    console.error = write;
    console.debug = write;
    return restore;
  } catch {
    return () => {};
  }
}

export async function startService(opts?: StartServiceOptions): Promise<ServiceHandle> {
  const exit = opts?.exit ?? process.exit;
  const fail = (err: unknown): never => {
    console.error(`[quotacap] ${err instanceof Error ? err.message : String(err)}`);
    exit(1);
    throw err instanceof Error ? err : new Error(String(err));
  };

  // 1. Strict config first, so invalid config leaves no residue.
  const config: Config = await readServiceConfig().catch((e) => fail(e));
  const port = opts?.port ?? config.port;
  const dataDir = opts?.dataDir ?? path.dirname(getDbPath());
  const restoreLog = setupLogFile();

  // 2. Exclusive ownership of the data directory.
  const claim: Claim = await acquireClaim(dataDir, opts?.claim).catch((e) => {
    restoreLog();
    return fail(e);
  });

  // Every step after the claim unwinds through one path, so a throw anywhere
  // in startup releases the claim and closes the database instead of leaving
  // a live claim behind for a caller that catches the rejection.
  let db: any = null;
  let app: ReturnType<typeof buildApp> | null = null;
  const unwind = async (): Promise<void> => {
    if (app) {
      try {
        await app.close();
      } catch {}
    }
    if (db) {
      try {
        db.close();
      } catch {}
    }
    claim.release();
    restoreLog();
  };
  const failStartup = async (e: unknown): Promise<never> => {
    await unwind();
    return fail(e);
  };

  let coordinator!: Coordinator;
  let actualPort = port;
  try {
    // 3. Storage.
    db = openDb(path.join(dataDir, "quotacap.db"));
    migrate(db);

    // Pin the claude binary: explicit resolver first, then the install-time
    // recorded path from service metadata, then live PATH resolution.
    try {
      const recorded = readServiceMetadata(dataDir)?.providerPaths?.claude;
      const pinned =
        opts?.resolveClaude?.() ?? recorded ?? resolveClaudeExecPath();
      if (pinned) claudeAdapter.execPath = pinned;
    } catch {}

    // 4. Token.
    const token = ensureToken(path.join(dataDir, "token"));

    // 5. Coordinator + HTTP on the runtime context.
    coordinator = createCoordinator({
      db,
      enabledProviders: config.enabledProviders,
      ownershipVerify: () => claim.verify(),
    });
    app = buildApp({
      db,
      token,
      coordinator,
      enabledProviders: config.enabledProviders,
      version: VERSION,
      exec: process.execPath,
      canWrite: () => claim.verify(),
      ingestEnabled: isExperimentalIngestEnabled(config),
      // POST /api/restart follows the normal SIGTERM path (onSignal is a
      // hoisted declaration below; it can only fire after listen, so the
      // shutdown bindings it closes over are initialized by then).
      onRestart: () => onSignal(),
    });

    // 6. Bind; unwind on failure without polling.
    await app.listen({ port, host: "127.0.0.1" });
    const bound = app.server.address();
    actualPort = typeof bound === "object" && bound ? bound.port : port;
  } catch (e) {
    await failStartup(e);
    throw e;
  }
  const listening = app!;

  // Legacy pidfile: best-effort removal on successful start.
  try {
    fs.rmSync(path.join(dataDir, "daemon.pid"), { force: true });
  } catch {}

  // 7. Async initial poll (never blocks readiness) + schedule.
  void coordinator
    .refresh()
    .catch((e) =>
      console.warn("[quotacap] initial poll failed", e?.message ?? String(e)),
    );
  coordinator.start(config.pollMinutes * 60 * 1000);

  let stopping = false;
  let stopped = false;
  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    stopping = true;
    // Handlers stay installed during shutdown so a second signal force-exits
    // via onSignal instead of hitting the default disposition.
    coordinator.setClosing();
    coordinator.stop();
    killAll();
    const deadline = Date.now() + 10000;
    while (
      coordinator.getState().polling === "in-progress" &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }
    try {
      await listening.close();
    } catch {}
    try {
      db.close();
    } catch {}
    claim.release();
    restoreLog();
  }

  function onSignal(): void {
    // A second signal force-exits a stuck shutdown.
    if (stopping) {
      exit(1);
      return;
    }
    stopping = true;
    void stop().then(
      () => exit(0),
      () => exit(1),
    );
  }

  if (opts?.signals !== false) {
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }

  return {
    port: actualPort,
    state: { dataDir, config, coordinator },
    stop,
  };
}

export { AlreadyRunningError };
