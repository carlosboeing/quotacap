// Runtime command registration (daemon, web, service). D-owned commands
// register on the same program without touching this file.
import type { Command } from "commander";
import path from "node:path";
import { spawn } from "node:child_process";
import { VERSION } from "../version.js";
import { getDbPath, readConfig } from "../config.js";
import { readClaim } from "../runtime/owner.js";
import { startService, type StartServiceOptions } from "../runtime/service.js";
import {
  createServiceClient,
  ServiceError,
  ServiceUnavailable,
  type ServiceClient,
} from "../runtime/client.js";
import { runServiceCommand } from "../service/index.js";
import { detectChannel, refreshUpdateCache } from "../runtime/updates.js";
import {
  checkSkew,
  execSkewWarning,
  formatWedged,
  isServiceManaged,
  olderCliWarning,
  takeoverManaged,
  takeoverUnmanaged,
  upgradedMessage,
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
    .description("open the dashboard, starting the foreground service if needed")
    .action(async (o) => {
      const cfg = await readConfig();
      const port = o.port ? parseInt(o.port, 10) : cfg.port;
      const dataDir = path.dirname(getDbPath());

      // Passive daily update signal (writer only; the dashboard badge reads it).
      await checkUpdates().catch(() => null);

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

      // 3. Start the foreground service (never login startup) and open it.
      const started = await start(o.port ? { port } : undefined);
      await openDashboard(`http://127.0.0.1:${started.port}`, openBrowser);
    });

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
