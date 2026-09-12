// Linux login-service lifecycle: systemd user unit install, start, stop,
// restart, uninstall. systemctl/which are injectable so tests never touch
// the real user manager. Mirrors the macOS module's shape; shared helpers
// (exec resolution, provider PATH, plist-agnostic status formatting) are
// reused from macos.ts.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VERSION } from "../version.js";
import {
  getDbPath,
  readServiceMetadata,
  writeServiceMetadata,
} from "../config.js";
import { ensureConfig, readConfig } from "../config.js";
import { createServiceClient } from "../runtime/client.js";
import {
  SERVICE_LABEL,
  PROVIDER_BINS,
  buildChildPath,
  defaultWaitReady,
  defaultWaitReleased,
  defaultWhich,
  formatMissingProviders,
  formatStatus,
  foregroundGuidance,
  resolveProviderPaths,
  resolveServiceExec,
  type ServiceStatus,
} from "./macos.js";

export const SERVICE_UNIT = `${SERVICE_LABEL}.service`;

export function serviceSupported(platform: string = process.platform): boolean {
  return platform === "linux";
}

export interface SystemdDeps {
  platform?: string;
  home?: string;
  uid?: number;
  dataDir?: string;
  port?: number;
  execPath?: string;
  argv1?: string | undefined;
  quotacapHome?: string | null;
  runSystemctl?: (args: string[]) => string;
  which?: (bin: string) => string | null;
  waitReady?: (port: number) => Promise<boolean>;
  waitReleased?: (port: number) => Promise<boolean>;
  print?: (msg: string) => void;
  error?: (msg: string) => void;
  now?: () => Date;
}

export function formatSystemctlError(args: string[], detail: string): Error {
  if (/failed to connect to bus/i.test(detail)) {
    return new Error(
      `systemd user manager is not reachable (Failed to connect to bus): no active login session or lingering for this user; ` +
        `run from an active login session (or enable lingering) and retry — systemctl --user ${args.join(" ")} failed: ${detail}`,
    );
  }
  return new Error(`systemctl --user ${args.join(" ")} failed: ${detail}`);
}

export function defaultRunSystemctl(args: string[]): string {
  try {
    return execFileSync("systemctl", ["--user", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e: any) {
    // State answers (is-active) arrive on stdout even with a nonzero exit.
    const detail = [e?.stdout, e?.stderr, e?.message]
      .filter((v) => typeof v === "string" && v.trim())
      .join(" ")
      .trim();
    throw formatSystemctlError(args, detail || String(e).trim());
  }
}

export interface UnitOptions {
  argv: string[];
  workingDirectory: string;
  path: string;
  logFile: string;
  quotacapHome?: string | null;
}

function escapeExecArg(a: string): string {
  if (!/[\s"\\]/.test(a)) return a;
  return `"${a.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildUnit(opts: UnitOptions): string {
  const lines = [
    "[Unit]",
    "Description=QuotaCap local quota tracker",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${opts.argv.map(escapeExecArg).join(" ")}`,
    `WorkingDirectory=${opts.workingDirectory}`,
    `Environment=PATH=${opts.path}`,
    `Environment=QUOTACAP_LOG_FILE=${opts.logFile}`,
  ];
  if (opts.quotacapHome !== undefined && opts.quotacapHome !== null) {
    lines.push(`Environment=QUOTACAP_HOME=${opts.quotacapHome}`);
  }
  lines.push(
    "Restart=on-failure",
    "RestartSec=30",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  );
  return lines.join("\n");
}

export function isOurUnit(text: string): boolean {
  return text.includes("Description=QuotaCap local quota tracker");
}

function unitFileFor(home: string): string {
  return path.join(home, ".config", "systemd", "user", SERVICE_UNIT);
}

function quietNotFound(e: unknown): boolean {
  return /not loaded|not-found|not found|no such|could not be found/i.test(
    String((e as any)?.message ?? e),
  );
}

function stopQuiet(
  run: (args: string[]) => string,
  print: (msg: string) => void,
): void {
  try {
    run(["stop", SERVICE_UNIT]);
  } catch (e: any) {
    if (quietNotFound(e)) {
      print("service job is not loaded; nothing to stop");
      return;
    }
    throw e;
  }
}

function resolved(deps: SystemdDeps = {}) {
  return {
    home: deps.home ?? os.homedir(),
    dataDir: deps.dataDir ?? path.dirname(getDbPath()),
    print: deps.print ?? console.log,
    run: deps.runSystemctl ?? defaultRunSystemctl,
  };
}

async function waitForReady(deps: SystemdDeps, dataDir: string): Promise<number> {
  const waitReady = deps.waitReady ?? defaultWaitReady;
  const port = deps.port ?? (await readConfig()).port;
  const ready = await waitReady(port);
  if (!ready) {
    throw new Error(
      `service did not become ready on port ${port}; check ${path.join(dataDir, "logs", "service.log")}`,
    );
  }
  return port;
}

export async function install(deps: SystemdDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  if (!serviceSupported(platform)) {
    (deps.print ?? console.log)(foregroundGuidance("install", platform));
    return;
  }
  const { home, dataDir, print, run } = resolved(deps);
  // Provision beside the data dir the service will use (identical to the
  // QUOTACAP_HOME path in production; hermetic under injected test dirs).
  await ensureConfig(path.join(dataDir, "config.json"));

  const { argv, entry } = resolveServiceExec(deps);
  const providerPaths = resolveProviderPaths(deps);
  const unitFile = unitFileFor(home);
  const logFile = path.join(dataDir, "logs", "service.log");
  const unit = buildUnit({
    argv,
    workingDirectory: dataDir,
    path: buildChildPath(providerPaths),
    logFile,
    quotacapHome: deps.quotacapHome ?? process.env.QUOTACAP_HOME ?? undefined,
  });

  print(`quotacap service install (unit ${SERVICE_UNIT})`);
  print(`  executable: ${argv.join(" ")}`);
  print(`  unit: ${unitFile}`);
  print(`  logs: ${logFile}`);
  for (const [bin, p] of Object.entries(providerPaths)) {
    print(`  provider ${bin}: ${p ?? "not found"}`);
  }
  for (const m of formatMissingProviders(providerPaths)) print(`  ${m}`);

  const existing = fs.existsSync(unitFile)
    ? fs.readFileSync(unitFile, "utf8")
    : null;
  if (existing !== null) {
    if (!isOurUnit(existing)) {
      throw new Error(
        `refusing to overwrite foreign unit at ${unitFile} (not a QuotaCap unit)`,
      );
    }
    const meta = readServiceMetadata(dataDir);
    const sameUnit = existing === unit;
    const samePaths =
      !!meta &&
      PROVIDER_BINS.every(
        (bin) => (meta.providerPaths?.[bin] ?? null) === providerPaths[bin],
      );
    if (sameUnit && samePaths && meta?.version === VERSION) {
      run(["enable", "--now", SERVICE_UNIT]);
      const port = await waitForReady(deps, dataDir);
      print(`service already installed and up to date; ready on port ${port}`);
      return;
    }
    // Upgrade: refresh metadata, stop the old job, replace, load.
    writeServiceMetadata(
      {
        version: VERSION,
        exec: argv[0],
        ...(entry ? { entry } : {}),
        providerPaths,
        installedAt: (deps.now?.() ?? new Date()).toISOString(),
      },
      dataDir,
    );
    stopQuiet(run, print);
  } else {
    writeServiceMetadata(
      {
        version: VERSION,
        exec: argv[0],
        ...(entry ? { entry } : {}),
        providerPaths,
        installedAt: (deps.now?.() ?? new Date()).toISOString(),
      },
      dataDir,
    );
  }

  fs.mkdirSync(path.dirname(unitFile), { recursive: true });
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(unitFile, unit, "utf8");
  run(["daemon-reload"]);
  run(["enable", "--now", SERVICE_UNIT]);
  const port = await waitForReady(deps, dataDir);
  print(
    existing !== null
      ? `service upgraded, loaded, and ready on port ${port}`
      : `service installed, loaded, and ready on port ${port}`,
  );
}

export async function uninstall(deps: SystemdDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  if (!serviceSupported(platform)) {
    (deps.print ?? console.log)(foregroundGuidance("uninstall", platform));
    return;
  }
  const { home, dataDir, print, run } = resolved(deps);
  const unitFile = unitFileFor(home);
  try {
    if (!isOurUnit(fs.readFileSync(unitFile, "utf8"))) {
      throw new Error(
        `refusing to remove foreign unit at ${unitFile} (not a QuotaCap unit)`,
      );
    }
  } catch (err: any) {
    if (err?.code !== "ENOENT" && !/refusing to remove foreign unit/.test(String(err?.message ?? ""))) throw err;
    if (/refusing to remove foreign unit/.test(String(err?.message ?? ""))) throw err;
  }
  try {
    run(["disable", "--now", SERVICE_UNIT]);
  } catch (e) {
    if (!quietNotFound(e)) throw e;
  }
  try {
    fs.rmSync(unitFile, { force: true });
  } catch {}
  try {
    run(["daemon-reload"]);
  } catch {}
  print(`service registration removed; quota data and config preserved in ${dataDir}`);
}

export async function stop(deps: SystemdDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  if (!serviceSupported(platform)) {
    (deps.print ?? console.log)(foregroundGuidance("stop", platform));
    return;
  }
  const { print, run } = resolved(deps);
  stopQuiet(run, print);
  print("service stopped for this login session; registration kept for next login");
}

export async function start(deps: SystemdDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  if (!serviceSupported(platform)) {
    (deps.print ?? console.log)(foregroundGuidance("start", platform));
    return;
  }
  const { dataDir, print, run } = resolved(deps);
  run(["enable", "--now", SERVICE_UNIT]);
  const port = await waitForReady(deps, dataDir);
  print(`service started and ready on port ${port}`);
}

export async function restart(deps: SystemdDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  if (!serviceSupported(platform)) {
    (deps.print ?? console.log)(foregroundGuidance("restart", platform));
    return;
  }
  await stop(deps);
  // systemctl stop can return before the port is released; same race as launchd.
  // deps.port mirrors start(): tests must never probe the real daemon's port.
  const port = deps.port ?? (await readConfig()).port;
  const waitReleased = deps.waitReleased ?? defaultWaitReleased;
  if (!(await waitReleased(port))) {
    (deps.print ?? console.log)(
      `port ${port} is still in use after stopping; starting anyway`,
    );
  }
  await start(deps);
}

function parseShowOutput(out: string): {
  pid: number | null;
  lastExitStatus: number | null;
} {
  const pidMatch = out.match(/^MainPID=(\d+)/m);
  const exitMatch = out.match(/^ExecMainStatus=(-?\d+)/m);
  const pid = pidMatch ? parseInt(pidMatch[1], 10) : 0;
  return {
    pid: pid > 0 ? pid : null,
    lastExitStatus: exitMatch ? parseInt(exitMatch[1], 10) : null,
  };
}

// Each section is attempted independently: a failing section records its
// error without hiding the others. Read-only: never enables or installs.
export async function collectStatus(deps: SystemdDeps = {}): Promise<ServiceStatus> {
  const home = deps.home ?? os.homedir();
  const dataDir = deps.dataDir ?? path.dirname(getDbPath());
  const run = deps.runSystemctl ?? defaultRunSystemctl;
  const nowMs = (deps.now?.() ?? new Date()).getTime();
  const unitFile = unitFileFor(home);

  const status: ServiceStatus = {
    backend: "systemd",
    registration: {
      installed: false,
      loaded: false,
      pid: null,
      lastExitStatus: null,
      plist: unitFile,
      error: null,
    },
    readiness: {
      ok: false,
      ready: false,
      version: null,
      exec: null,
      polling: null,
      error: null,
    },
    version: { service: null, cli: VERSION, skew: false },
    endpoint: { port: null, url: null, error: null },
    lastPoll: { at: null, ageMs: null, error: null },
    providers: { paths: null, missing: [], error: null },
  };

  try {
    status.registration.installed = fs.existsSync(unitFile);
  } catch (e: any) {
    status.registration.error = String(e?.message ?? e);
  }
  try {
    const out = run(["is-active", SERVICE_UNIT]);
    status.registration.loaded = out.trim() === "active";
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/failed to connect to bus/i.test(msg)) {
      status.registration.error = msg;
    } else if (!/inactive|activating|not-found|not found|no such|could not be found/i.test(msg)) {
      status.registration.error = msg;
    }
    // else: a stable inactive (or activating) unit — quiet, like launchd's
    // "could not find service". A failed unit keeps its error line above.
  }
  // Main PID is best-effort: a missing or stopped unit simply has no PID.
  try {
    const out = run(["show", SERVICE_UNIT, "-p", "MainPID", "-p", "ExecMainStatus"]);
    const { pid, lastExitStatus } = parseShowOutput(out);
    status.registration.pid = pid;
    status.registration.lastExitStatus = lastExitStatus;
  } catch {}

  let port: number | null = null;
  try {
    port = deps.port ?? (await readConfig()).port;
    status.endpoint.port = port;
    status.endpoint.url = `http://127.0.0.1:${port}`;
  } catch (e: any) {
    status.endpoint.error = String(e?.message ?? e);
  }

  let lastCompletedPollAt: string | null = null;
  if (port !== null) {
    try {
      const health = await createServiceClient({ port, timeoutMs: 2000 }).get(
        "/health",
      );
      status.readiness.ok = !!health?.ok;
      status.readiness.ready = !!health?.ready;
      status.readiness.version =
        typeof health?.version === "string" ? health.version : null;
      status.readiness.exec = typeof health?.exec === "string" ? health.exec : null;
      status.readiness.polling =
        typeof health?.polling === "string" ? health.polling : null;
      if (typeof health?.lastCompletedPollAt === "string") {
        lastCompletedPollAt = health.lastCompletedPollAt;
      }
      if (!health?.ok) {
        status.readiness.error = "service answered but not ok";
      }
    } catch (e: any) {
      status.readiness.error = String(e?.message ?? e);
    }
  } else {
    status.readiness.error = "no endpoint port";
  }

  status.version.service = status.readiness.version;
  status.version.skew =
    status.version.service !== null && status.version.service !== VERSION;

  if (lastCompletedPollAt) {
    status.lastPoll.at = lastCompletedPollAt;
    const age = nowMs - new Date(lastCompletedPollAt).getTime();
    status.lastPoll.ageMs = Number.isFinite(age) && age >= 0 ? age : null;
  } else {
    status.lastPoll.error = status.readiness.ok
      ? "no completed poll yet"
      : "unknown — service not answering";
  }

  try {
    const meta = readServiceMetadata(dataDir);
    if (meta) {
      status.providers.paths = meta.providerPaths;
      status.providers.missing = Object.entries(meta.providerPaths)
        .filter(([, p]) => p === null)
        .map(([bin]) => bin);
    } else {
      status.providers.error = "no install metadata";
    }
  } catch (e: any) {
    status.providers.error = String(e?.message ?? e);
  }

  return status;
}

export async function status(
  deps: SystemdDeps = {},
  opts: { json?: boolean } = {},
): Promise<void> {
  const platform = deps.platform ?? process.platform;
  if (!serviceSupported(platform)) {
    (deps.print ?? console.log)(foregroundGuidance("status", platform));
    return;
  }
  const st = await collectStatus(deps);
  (deps.print ?? console.log)(opts.json ? JSON.stringify(st, null, 2) : formatStatus(st));
}

export { defaultWhich };
