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
} from "../runtime/client.js";
import { runServiceCommand } from "../service/index.js";

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

      // 1. A healthy service answers: open it, never replace it.
      let health: any = null;
      try {
        health = await createServiceClient({ port }).get("/health");
      } catch (e) {
        if (!(e instanceof ServiceUnavailable) && !(e instanceof ServiceError)) {
          throw e;
        }
        health = null;
      }
      if (health?.ok) {
        if (
          health.version !== VERSION ||
          (typeof health.exec === "string" &&
            health.exec !== process.execPath)
        ) {
          console.error(
            `existing service mismatch: ${health.exec ?? "unknown executable"} version ${health.version ?? "unknown"} on port ${port} (this CLI: ${process.execPath} version ${VERSION})`,
          );
          exit(2);
          return;
        }
        await openDashboard(`http://127.0.0.1:${port}`, openBrowser);
        return;
      }

      // 2. Nothing healthy on the target port, but another owner holds the
      // installation: report, never create a second poller.
      const claim = readClaim(dataDir);
      const fresh =
        !!claim && Date.now() - new Date(claim.lastBeat).getTime() < 30000;
      if (fresh && claim) {
        console.error(
          `existing service mismatch: installation owned by ${claim.exec} version ${claim.version} (pid ${claim.pid}, started ${claim.startedAt}); no healthy service on port ${port}`,
        );
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
