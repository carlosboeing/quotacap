// Runtime command registration (daemon, web, service). D-owned commands
// register on the same program without touching this file.
import type { Command } from "commander";
import path from "node:path";
import { spawn } from "node:child_process";
import { VERSION } from "../version.js";
import { ensureConfig, getDbPath } from "../config.js";
import { readClaim } from "../runtime/owner.js";
import { startService, type StartServiceOptions } from "../runtime/service.js";
import {
  createServiceClient,
  ServiceError,
  ServiceUnavailable,
  type ServiceClient,
} from "../runtime/client.js";
import {
  isServiceInstalled,
  isServiceManaged,
  runServiceCommand,
  serviceSupported,
} from "../service/index.js";
import { detectChannel, refreshUpdateCache } from "../runtime/updates.js";
import {
  checkSkew,
  execSkewWarning,
  formatWedged,
  olderCliWarning,
  takeoverManaged,
  takeoverUnmanaged,
  upgradedMessage,
  waitForHealthy,
  WedgedError,
  type SleepFn,
} from "./takeover.js";

export type StartServiceFn = (opts?: StartServiceOptions) => ReturnType<
  typeof startService
>;
export type OpenBrowserFn = (url: string) => Promise<void> | void;
export type ExecServiceFn = (
  args: string[],
  opts?: Record<string, any>,
) => Promise<number>;

export interface RuntimeCommandDeps {
  startService?: StartServiceFn;
  openBrowser?: OpenBrowserFn;
  execService?: ExecServiceFn;
  exit?: (code: number) => void;
  createClient?: (opts: { port: number; token?: string; timeoutMs: number }) => ServiceClient;
  isManaged?: () => Promise<boolean>;
  takeoverOpts?: {
    sleep?: SleepFn;
    timeoutMs?: number;
    readToken?: () => string | undefined;
  };
  checkUpdates?: () => Promise<unknown>;
  isInstalled?: () => Promise<boolean>;
  serviceSupported?: () => boolean;
}

export interface WebLaunchOptions {
  port?: string;
  foreground?: boolean;
}

// Shared `web` launcher handler: the `web` command and the bare `quotacap`
// invocation both run this. Decision order: healthy daemons open (with the
// skew matrix), registered-but-down services start, and only the last resort
// foreground-starts. Explicit `--foreground` and non-config `--port`
// overrides skip service management entirely.
export async function launchWeb(
  o: WebLaunchOptions,
  deps: RuntimeCommandDeps = {},
): Promise<void> {
  const start = deps.startService ?? startService;
  const openBrowser = deps.openBrowser ?? defaultOpenBrowser;
  const exit = deps.exit ?? process.exit;
  const execService: ExecServiceFn =
    deps.execService ?? ((args, opts) => runServiceCommand(args, opts ?? {}, {}));
  const createClient = deps.createClient ?? ((c) => createServiceClient(c));
  const isManaged = deps.isManaged ?? isServiceManaged;
  const isInstalled = deps.isInstalled ?? isServiceInstalled;
  const supported = deps.serviceSupported ?? serviceSupported;
  const takeoverOpts = deps.takeoverOpts ?? {};
  const checkUpdates =
    deps.checkUpdates ??
    (() => refreshUpdateCache({ channel: detectChannel(), current: VERSION }));
  const sleep = takeoverOpts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const readyTimeoutMs = takeoverOpts.timeoutMs ?? 15000;

  const { config: cfg } = await ensureConfig();
  const port = o.port ? parseInt(o.port, 10) : cfg.port;
  const dataDir = path.dirname(getDbPath());

  // Passive daily update signal (writer only; the dashboard badge reads it).
  await checkUpdates().catch(() => null);

  // Services only ever bind the config port, so an explicit override names
  // an ad-hoc listener: skip service management like --foreground does.
  const foregroundOnly = !!o.foreground || (!!o.port && port !== cfg.port);

  // 1. A healthy service answers: compare skew, take over when newer.
  let health: any = null;
  try {
    health = await createClient({ port, timeoutMs: 2000 }).get("/health");
  } catch (e) {
    if (!(e instanceof ServiceUnavailable) && !(e instanceof ServiceError)) {
      throw e;
    }
    health = null;
  }
  if (health?.ok) {
    const skew = checkSkew(health, VERSION, process.execPath);
    if (skew === "match") {
      await openDashboard(`http://127.0.0.1:${port}`, openBrowser);
      return;
    }
    if (skew === "exec-only") {
      console.error(execSkewWarning(String(health.exec)));
      await openDashboard(`http://127.0.0.1:${port}`, openBrowser);
      return;
    }
    if (skew === "cli-older") {
      console.error(olderCliWarning(String(health.version ?? "unknown")));
      await openDashboard(`http://127.0.0.1:${port}`, openBrowser);
      return;
    }
    // CLI newer than daemon: take over, then open.
    const managed = await isManaged().catch(() => false);
    if (managed) {
      try {
        const r = await takeoverManaged({
          port,
          health,
          createClient,
          execService,
          ...takeoverOpts,
        });
        console.error(r.message);
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        exit(1);
        return;
      }
      await openDashboard(`http://127.0.0.1:${port}`, openBrowser);
      return;
    }
    try {
      const r = await takeoverUnmanaged({
        port,
        health,
        dataDir,
        createClient,
        ...takeoverOpts,
      });
      console.error(upgradedMessage(r.oldVersion, VERSION, "daemon"));
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      exit(e instanceof WedgedError ? 2 : 1);
      return;
    }
    // Unmanaged successor: foreground-start the new daemon and open it.
    const started = await start(o.port ? { port } : undefined);
    await openDashboard(`http://127.0.0.1:${started.port}`, openBrowser);
    return;
  }

  // 2. Nothing healthy on the target port, but another owner holds the
  // installation: wedged — print recovery, never create a second poller.
  const claim = readClaim(dataDir);
  const fresh =
    !!claim && Date.now() - new Date(claim.lastBeat).getTime() < 30000;
  if (fresh && claim) {
    const managed = await isManaged().catch(() => false);
    console.error(formatWedged({ claim, port, managed }));
    exit(2);
    return;
  }

  // 3. Unhealthy but registered: start the login service and open it.
  let attemptedServiceStart = false;
  if (!foregroundOnly) {
    const installed = await isInstalled().catch(() => false);
    if (installed) {
      attemptedServiceStart = true;
      let detail: string | null = null;
      try {
        const code = await execService(["start"]);
        if (code !== 0) detail = `exit ${code}`;
      } catch (e) {
        detail = (e as Error)?.message ?? String(e);
      }
      if (!detail) {
        const healthy = await waitForHealthy(port, VERSION, {
          createClient,
          sleep,
          timeoutMs: readyTimeoutMs,
        });
        if (!healthy) detail = `not ready within ${Math.round(readyTimeoutMs / 1000)}s`;
      }
      if (!detail) {
        await openDashboard(`http://127.0.0.1:${port}`, openBrowser);
        return;
      }
      console.error(`service start failed (${detail}); starting in the foreground instead`);
    }
  }

  // 4. Foreground fallback: start, open, and suggest the login service.
  const started = await start(o.port ? { port } : undefined);
  if (!foregroundOnly && !attemptedServiceStart && supported()) {
    console.error("for a background service that survives terminal closes, run 'quotacap service install'");
  }
  await openDashboard(`http://127.0.0.1:${started.port}`, openBrowser);
}

async function defaultOpenBrowser(url: string): Promise<void> {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", reject);
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function openDashboard(
  url: string,
  openBrowser: OpenBrowserFn,
): Promise<void> {
  try {
    await openBrowser(url);
  } catch {
    // Browser-open failure prints the URL and keeps any running service.
    console.log(url);
  }
}

export function registerRuntimeCommands(
  program: Command,
  deps?: RuntimeCommandDeps,
): void {
  const start = deps?.startService ?? startService;
  const openBrowser = deps?.openBrowser ?? defaultOpenBrowser;
  const exit = deps?.exit ?? process.exit;
  const execService: ExecServiceFn =
    deps?.execService ??
    ((args, opts) => runServiceCommand(args, opts ?? {}, {}));
  const createClient =
    deps?.createClient ?? ((o) => createServiceClient(o));
  const isManaged = deps?.isManaged ?? isServiceManaged;
  const isInstalled = deps?.isInstalled ?? isServiceInstalled;
  const supported = deps?.serviceSupported ?? serviceSupported;
  const takeoverOpts = deps?.takeoverOpts ?? {};
  const checkUpdates =
    deps?.checkUpdates ??
    (() => refreshUpdateCache({ channel: detectChannel(), current: VERSION }));

  program
    .command("daemon")
    .option("--foreground", "keep foreground (default: true)")
    .option("--port <n>")
    .description("run the complete service in the foreground")
    .action(async (o) => {
      await ensureConfig();
      const started = await start(
        o.port ? { port: parseInt(o.port, 10) } : undefined,
      );
      console.log(
        `quotacap service listening on http://127.0.0.1:${started.port}`,
      );
    });

  program
    .command("web")
    .option("--port <n>")
    .option("--foreground", "hold the terminal with a foreground service instead of using the login service")
    .description("open the dashboard, starting the service if needed")
    .action(async (o) =>
      launchWeb(o, {
        startService: start,
        openBrowser,
        exit,
        execService,
        createClient,
        isManaged,
        isInstalled,
        serviceSupported: supported,
        takeoverOpts,
        checkUpdates,
      }),
    );

  const service = program
    .command("service")
    .description("manage the per-user login service");
  const runSvc = async (args: string[], opts: Record<string, any> = {}) => {
    const code = await execService(args, opts);
    if (code !== 0) exit(code);
  };
  service
    .command("install")
    .description("register and start the login service")
    .action(async () => runSvc(["install"]));
  service
    .command("uninstall")
    .description("stop and remove the login service registration")
    .action(async () => runSvc(["uninstall"]));
  service
    .command("start")
    .description("load the registered job and check readiness")
    .action(async () => runSvc(["start"]));
  service
    .command("stop")
    .description("unload the running job for this login session")
    .action(async () => runSvc(["stop"]));
  service
    .command("restart")
    .description("restart the registered job")
    .action(async () => runSvc(["restart"]));
  service
    .command("status")
    .description("show service status")
    .option("--json", "machine-readable output")
    .action(async (o) => runSvc(["status"], o));
}
