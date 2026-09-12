// `quotacap update`: channel-aware self-update with machine-readable JSON.
// Standalone swaps the binary and sidecars in place with checksum
// verification; npm upgrades the global package; every other channel prints
// its instruction or refusal. After an applied upgrade the takeover protocol
// restarts the running daemon onto the new version.
import type { Command } from "commander";
import path from "node:path";
import { VERSION } from "../version.js";
import { ensureConfig, getDbPath } from "../config.js";
import {
  createServiceClient,
  ServiceError,
  ServiceUnavailable,
  type ServiceClient,
} from "../runtime/client.js";
import { readClaim } from "../runtime/owner.js";
import { compareVersions } from "../runtime/versions.js";
import {
  detectChannel,
  resolveLatestVersionDetailed,
  updateNpm,
  updateStandalone,
  writeUpdateCache,
  type Channel,
  type ChannelEnv,
  type ReleaseInfo,
} from "../runtime/updates.js";
import { isServiceManaged, runServiceCommand } from "../service/index.js";
import {
  checkSkew,
  formatWedged,
  olderCliWarning,
  takeoverManaged,
  takeoverUnmanaged,
  WedgedError,
  type SleepFn,
} from "./takeover.js";

export interface UpdateJson {
  channel: string;
  current: string;
  latest: string | null;
  upToDate: boolean | null;
  updated: boolean;
  instruction: string | null;
  error: string | null;
}

export interface UpdateCommandDeps {
  exit?: (code: number) => void;
  channelEnv?: ChannelEnv;
  execPath?: string;
  homeDir?: string;
  fetchFn?: typeof fetch;
  createClient?: (opts: { port: number; token?: string; timeoutMs: number }) => ServiceClient;
  isManaged?: () => Promise<boolean>;
  execService?: (args: string[], opts?: Record<string, any>) => Promise<number>;
  takeoverOpts?: {
    sleep?: SleepFn;
    timeoutMs?: number;
    readToken?: () => string | undefined;
  };
  spawnNpm?: (args: string[]) => Promise<number>;
  extractTar?: (tarball: string, destDir: string) => void;
}

export function stoppedDaemonMessage(oldVersion: string, newVersion: string): string {
  return (
    `Stopped old daemon (${oldVersion}); no background service is registered. ` +
    `Run 'quotacap web' to start ${newVersion}, or 'quotacap service install' to run it in the background.`
  );
}

function instructionFor(channel: Channel): string | null {
  switch (channel) {
    case "brew":
      return "Run: brew upgrade quotacap";
    case "pnpm":
      return "Run: pnpm add -g quotacap@latest";
    case "yarn":
      return "Run: yarn global add quotacap@latest";
    case "npx":
      return "Running via npx, which always resolves the latest published version; nothing to update.";
    default:
      return null;
  }
}

function sourceRefusal(execPath: string, argv1: string | undefined): string {
  const where = argv1 ?? execPath;
  return `cannot update a source checkout (running from ${where}); pull the latest changes and rebuild instead`;
}

function unknownRefusal(): string {
  return (
    "unknown install channel; reinstall manually with the installer " +
    "(curl -fsSL https://raw.githubusercontent.com/carlosboeing/quotacap/main/install.sh | sh) " +
    "or 'npm install -g quotacap@latest'"
  );
}

export interface PostUpdateTakeoverOpts {
  target: string;
  port: number;
  dataDir?: string;
  execPath?: string;
  createClient?: (opts: { port: number; token?: string; timeoutMs: number }) => ServiceClient;
  isManaged?: () => Promise<boolean>;
  execService?: (args: string[], opts?: Record<string, any>) => Promise<number>;
  takeoverOpts?: {
    sleep?: SleepFn;
    timeoutMs?: number;
    readToken?: () => string | undefined;
  };
}

export interface PostUpdateTakeoverResult {
  notes: string[];
  warnings: string[];
  error: string | null;
  exitCode: 0 | 1 | 2;
}

// Restart the running daemon onto the just-installed target version. Unlike
// the skew paths in web/status/advise, the comparison version is the target
// (the running CLI is still the old binary), the managed path refreshes the
// service registration instead of only restarting (regenerating the
// supervisor PATH), and the unmanaged path leaves the daemon stopped with
// guidance instead of foreground-starting.
export async function postUpdateTakeover(
  opts: PostUpdateTakeoverOpts,
): Promise<PostUpdateTakeoverResult> {
  const { target, port } = opts;
  const dataDir = opts.dataDir ?? path.dirname(getDbPath());
  const execPath = opts.execPath ?? process.execPath;
  const createClient = opts.createClient ?? ((o) => createServiceClient(o));
  const isManaged = opts.isManaged ?? isServiceManaged;
  const execService =
    opts.execService ?? ((args, o) => runServiceCommand(args, o ?? {}, {}));
  const takeoverOpts = opts.takeoverOpts ?? {};

  let health: any = null;
  try {
    health = await createClient({ port, timeoutMs: 2000 }).get("/health");
  } catch (e) {
    if (!(e instanceof ServiceUnavailable) && !(e instanceof ServiceError)) throw e;
    health = null;
  }
  if (!health?.ok) {
    const claim = readClaim(dataDir);
    const fresh =
      !!claim && Date.now() - new Date(claim.lastBeat).getTime() < 30000;
    if (fresh && claim) {
      const managed = await isManaged().catch(() => false);
      return {
        notes: [],
        warnings: [],
        error: formatWedged({ claim, port, managed }),
        exitCode: 2,
      };
    }
    return { notes: [], warnings: [], error: null, exitCode: 0 };
  }

  const daemonVersion =
    typeof health.version === "string" && health.version ? health.version : "unknown";
  const skew = checkSkew(health, target, execPath);
  if (skew === "match" || skew === "exec-only") {
    return { notes: [], warnings: [], error: null, exitCode: 0 };
  }
  if (skew === "cli-older") {
    return { notes: [], warnings: [olderCliWarning(daemonVersion)], error: null, exitCode: 0 };
  }
  const managed = await isManaged().catch(() => false);
  if (managed) {
    try {
      const r = await takeoverManaged({
        port,
        health,
        cliVersion: target,
        cliExec: execPath,
        createClient,
        execService,
        refreshRegistration: true,
        ...takeoverOpts,
      });
      return { notes: [r.message], warnings: [], error: null, exitCode: 0 };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        notes: [],
        warnings: [],
        error: `${msg}; run 'quotacap web' to retry the restart`,
        exitCode: 1,
      };
    }
  }
  try {
    const r = await takeoverUnmanaged({
      port,
      health,
      dataDir,
      cliVersion: target,
      cliExec: execPath,
      createClient,
      ...takeoverOpts,
    });
    return {
      notes: [stoppedDaemonMessage(r.oldVersion, target)],
      warnings: [],
      error: null,
      exitCode: 0,
    };
  } catch (e) {
    if (e instanceof WedgedError) {
      return { notes: [], warnings: [], error: e.message, exitCode: 2 };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return {
      notes: [],
      warnings: [],
      error: `${msg}; run 'quotacap web' to retry the restart`,
      exitCode: 1,
    };
  }
}

function stripV(v: string): string {
  return v.startsWith("v") ? v.slice(1) : v;
}

// A rate-limited response names its reset (local HH:MM) and the pin escape
// hatch; every other failure keeps the generic network message.
function rateLimitError(resetsAtMs: number | null): string {
  const hint = "or run 'quotacap update --to <version>'";
  if (resetsAtMs === null) {
    return `GitHub's anonymous API rate limit is exhausted; retry later, ${hint}`;
  }
  const d = new Date(resetsAtMs);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `GitHub's anonymous API rate limit is exhausted (resets ${hhmm}); retry then, ${hint}`;
}

export function registerUpdateCommand(program: Command, deps?: UpdateCommandDeps): void {
  const exit = deps?.exit ?? process.exit;
  const fetchFn = deps?.fetchFn ?? fetch;
  const execPath = deps?.execPath ?? process.execPath;
  const homeDir = deps?.homeDir;

  program
    .command("update")
    .description("check for and apply updates")
    .option("--check", "only check for updates, changing nothing")
    .option("--version <v>", "update to a specific version")
    .option("--json", "machine-readable output")
    .action(async (o) => {
      const current = VERSION;
      const channel = detectChannel(deps?.channelEnv ?? {});
      const asJson = !!o.json;
      const emit = (result: UpdateJson): void => {
        console.log(JSON.stringify(result));
      };

      const channelEnv = deps?.channelEnv ?? {};
      const argv1 =
        "argv1" in channelEnv ? channelEnv.argv1 : process.argv[1];
      if (channel === "source" || channel === "unknown") {
        const error =
          channel === "source" ? sourceRefusal(execPath, argv1) : unknownRefusal();
        if (asJson) {
          emit({
            channel,
            current,
            latest: null,
            upToDate: null,
            updated: false,
            instruction: null,
            error,
          });
        } else {
          console.error(error);
        }
        exit(1);
        return;
      }

      const pin = typeof o.version === "string" && o.version ? stripV(o.version) : null;
      let latest: ReleaseInfo | null = null;
      let rateLimited: { resetsAtMs: number | null } | null = null;
      try {
        const resolved = await resolveLatestVersionDetailed({ fetchFn });
        if (resolved.status === "ok") latest = resolved.release;
        else if (resolved.status === "rate-limited") rateLimited = resolved;
      } catch {
        latest = null;
      }
      const target = pin ?? latest?.version ?? null;
      if (!target) {
        const error = rateLimited
          ? rateLimitError(rateLimited.resetsAtMs)
          : "could not resolve the latest release; check your network and retry";
        if (asJson) {
          emit({
            channel,
            current,
            latest: null,
            upToDate: null,
            updated: false,
            instruction: instructionFor(channel),
            error,
          });
        } else {
          console.error(error);
        }
        exit(1);
        return;
      }

      if (o.check) {
        // Explicit checks write their fresh result to the daily cache.
        try {
          if (latest) {
            writeUpdateCache({
              checkedAt: new Date().toISOString(),
              latest: latest.version,
              channel,
              current,
            });
          }
        } catch {}
        const upToDate = compareVersions(current, target) === 0;
        if (asJson) {
          emit({
            channel,
            current,
            latest: latest?.version ?? null,
            upToDate: latest ? upToDate : null,
            updated: false,
            instruction: instructionFor(channel),
            error: null,
          });
          return;
        }
        console.log(upToDate ? "already at latest" : `${current} -> ${target} available`);
        return;
      }

      const instruction = instructionFor(channel);
      if (instruction) {
        if (asJson) {
          emit({
            channel,
            current,
            latest: latest?.version ?? null,
            upToDate: latest ? compareVersions(current, latest.version) === 0 : null,
            updated: false,
            instruction,
            error: null,
          });
        } else {
          console.log(instruction);
        }
        return;
      }

      if (target === current) {
        if (asJson) {
          emit({
            channel,
            current,
            latest: latest?.version ?? null,
            upToDate: true,
            updated: false,
            instruction: null,
            error: null,
          });
        } else {
          console.log(`already at latest (${target})`);
        }
        return;
      }

      // Applied upgrades below: standalone swaps in place, npm reinstalls.
      const { config: cfg } = await ensureConfig();
      const port = cfg.port;
      const dataDir = path.dirname(getDbPath());
      const postOpts = {
        target,
        port,
        dataDir,
        execPath,
        createClient: deps?.createClient,
        isManaged: deps?.isManaged,
        execService: deps?.execService,
        takeoverOpts: deps?.takeoverOpts,
      };

      if (channel === "standalone") {
        const swap = await updateStandalone({
          target,
          execPath,
          homeDir,
          fetchFn,
          extractTar: deps?.extractTar,
        });
        if (!swap.ok) {
          const error = swap.error ?? "standalone update failed";
          if (asJson) {
            emit({
              channel,
              current,
              latest: latest?.version ?? null,
              upToDate: false,
              updated: false,
              instruction: null,
              error,
            });
          } else {
            console.error(error);
          }
          exit(1);
          return;
        }
        const post = await postUpdateTakeover(postOpts);
        const releaseUrl = latest?.url ?? releaseNotesFallback(target);
        if (asJson) {
          emit({
            channel,
            current,
            latest: latest?.version ?? null,
            upToDate: latest ? compareVersions(target, latest.version) === 0 : null,
            updated: true,
            instruction: null,
            error: post.error,
          });
        } else {
          console.log(`Updated ${current} to ${target}`);
          for (const note of post.notes) console.log(note);
          for (const warning of post.warnings) console.error(warning);
          if (post.error) console.error(post.error);
          console.log(releaseUrl);
        }
        if (post.exitCode !== 0) exit(post.exitCode);
        return;
      }

      // npm global.
      const npmSpec = pin ?? "latest";
      const npm = await updateNpm({
        target: npmSpec,
        execPath,
        homeDir,
        spawnNpm: deps?.spawnNpm,
      });
      if (npm.shadowWarning && !asJson) console.error(npm.shadowWarning);
      if (!npm.ok) {
        const error = npm.error ?? "npm update failed";
        if (asJson) {
          emit({
            channel,
            current,
            latest: latest?.version ?? null,
            upToDate: false,
            updated: false,
            instruction: null,
            error,
          });
        } else {
          console.error(error);
        }
        exit(1);
        return;
      }
      const post = await postUpdateTakeover(postOpts);
      if (asJson) {
        emit({
          channel,
          current,
          latest: latest?.version ?? null,
          upToDate: latest ? compareVersions(target, latest.version) === 0 : null,
          updated: true,
          instruction: null,
          error: post.error,
        });
      } else {
        console.log(`Updated ${current} to ${target}`);
        for (const note of post.notes) console.log(note);
        for (const warning of post.warnings) console.error(warning);
        if (post.error) console.error(post.error);
      }
      if (post.exitCode !== 0) exit(post.exitCode);
    });
}

function releaseNotesFallback(target: string): string {
  return `https://github.com/carlosboeing/quotacap/releases/tag/v${target}`;
}
