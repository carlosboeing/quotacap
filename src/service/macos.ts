// macOS login-service lifecycle: LaunchAgent plist build, install, start,
// stop, restart, uninstall. launchctl/plutil/which are injectable so tests
// never touch the real service; only test (a) runs the real `plutil -lint`.
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

export const SERVICE_LABEL = "quotacap";
export const PROVIDER_BINS = ["claude", "codex", "kimi", "grok", "agy", "muse"];

export function serviceSupported(platform: string = process.platform): boolean {
  return platform === "darwin";
}

export interface ServiceDeps {
  platform?: string;
  home?: string;
  uid?: number;
  dataDir?: string;
  port?: number;
  execPath?: string;
  argv1?: string | undefined;
  quotacapHome?: string | null;
  runLaunchctl?: (args: string[]) => string;
  which?: (bin: string) => string | null;
  lintPlist?: (plistFile: string) => void;
  waitReady?: (port: number) => Promise<boolean>;
  waitReleased?: (port: number) => Promise<boolean>;
  print?: (msg: string) => void;
  error?: (msg: string) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  bootstrapTimeoutMs?: number;
  // Expected version for the idempotency comparison and recorded metadata.
  // Defaults to the in-process VERSION; the post-update path passes the
  // target version because it runs in the old binary.
  version?: string;
}

export function foregroundGuidance(verb: string, platform: string): string {
  return (
    `service ${verb} is only supported on macOS and Linux (this platform: ${platform}); ` +
    `run 'quotacap daemon' in the foreground instead`
  );
}

export function defaultRunLaunchctl(args: string[]): string {
  try {
    return execFileSync("launchctl", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e: any) {
    throw new Error(
      `launchctl ${args.join(" ")} failed: ${String(e?.stderr ?? e?.message ?? e).trim()}`,
    );
  }
}

export function defaultWhich(bin: string): string | null {
  try {
    const out = execFileSync("which", [bin], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export function defaultLintPlist(plistFile: string): void {
  try {
    execFileSync("plutil", ["-lint", plistFile], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e: any) {
    throw new Error(
      `plist failed plutil -lint: ${String(e?.stderr ?? e?.message ?? e).trim()}`,
    );
  }
}

export async function defaultWaitReady(port: number, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const client = createServiceClient({ port, timeoutMs: 1000 });
  while (Date.now() < deadline) {
    try {
      const h = await client.get("/health");
      if (h?.ok && h?.ready) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * `launchctl bootout` and `systemctl --user stop` both return before the job
 * has actually gone, so a restart that starts immediately races the dying
 * process for the port: the replacement fails to bind and the restart reports
 * "did not become ready". Wait until nothing answers on the port.
 *
 * Resolves true as soon as the port is free, false if it never frees.
 */
export async function defaultWaitReleased(port: number, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const client = createServiceClient({ port, timeoutMs: 500 });
  while (Date.now() < deadline) {
    try {
      await client.get("/health");
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

export interface ServiceExec {
  argv: string[];
  entry: string;
}

const TRANSIENT_PATTERNS = ["/_npx/", "/.npm/_npx/", "/.worktrees/"];

export function resolveServiceExec(deps?: ServiceDeps): ServiceExec {
  const execPath = deps?.execPath ?? process.execPath;
  // Explicit undefined means "absent" (compiled binary); only fall back to
  // the live argv when the key is not provided at all.
  const argv1 = deps && "argv1" in deps ? deps.argv1 : process.argv[1];
  for (const cand of [execPath, argv1]) {
    if (typeof cand === "string" && TRANSIENT_PATTERNS.some((p) => cand.includes(p))) {
      throw new Error(
        `refusing to register a transient path as a login service: ${cand} — ` +
          `install quotacap via 'npm i -g quotacap' (or the GitHub release binary) for a stable install, then re-run service install from there`,
      );
    }
  }
  if (argv1 === undefined || !/\.[cm]?js$/.test(argv1)) {
    // Compiled binary: argv[0] is quotacap itself.
    if (/^node(\.exe)?$/.test(path.basename(execPath))) {
      throw new Error(
        `cannot register ${execPath} as a login service: not a stable install`,
      );
    }
    return { argv: [execPath, "daemon", "--foreground"], entry: "" };
  }
  const entry = path.resolve(argv1);
  return { argv: [execPath, entry, "daemon", "--foreground"], entry };
}

export function resolveProviderPaths(
  deps?: ServiceDeps,
): Record<string, string | null> {
  const which = deps?.which ?? defaultWhich;
  const out: Record<string, string | null> = {};
  for (const bin of PROVIDER_BINS) {
    let resolved: string | null = null;
    try {
      resolved = which(bin);
    } catch {
      resolved = null;
    }
    out[bin] = resolved && path.isAbsolute(resolved) ? resolved : null;
  }
  return out;
}

export function formatMissingProviders(paths: Record<string, string | null>): string[] {
  return Object.entries(paths)
    .filter(([, p]) => p === null)
    .map(
      ([bin]) =>
        `provider ${bin} not found on PATH — install the ${bin} CLI, then re-run 'quotacap service install' to refresh`,
    );
}

export function buildChildPath(paths: Record<string, string | null>): string {
  const dirs = new Set<string>();
  for (const p of Object.values(paths)) {
    if (p) dirs.add(path.dirname(p));
  }
  for (const d of ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]) dirs.add(d);
  return [...dirs].join(":");
}

export interface PlistOptions {
  label: string;
  argv: string[];
  workingDirectory: string;
  path: string;
  logFile: string;
  quotacapHome?: string | null;
  stdoutPath: string;
  stderrPath: string;
  throttleInterval?: number;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function buildPlist(opts: PlistOptions): string {
  const args = opts.argv
    .map((a) => `        <string>${escapeXml(a)}</string>`)
    .join("\n");
  const env = [
    `        <key>PATH</key>`,
    `        <string>${escapeXml(opts.path)}</string>`,
    `        <key>QUOTACAP_LOG_FILE</key>`,
    `        <string>${escapeXml(opts.logFile)}</string>`,
  ];
  if (opts.quotacapHome !== undefined && opts.quotacapHome !== null) {
    env.push(
      `        <key>QUOTACAP_HOME</key>`,
      `        <string>${escapeXml(opts.quotacapHome)}</string>`,
    );
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(opts.label)}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>${opts.throttleInterval ?? 30}</integer>
    <key>WorkingDirectory</key>
    <string>${escapeXml(opts.workingDirectory)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${env.join("\n")}
    </dict>
    <key>StandardOutPath</key>
    <string>${escapeXml(opts.stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(opts.stderrPath)}</string>
</dict>
</plist>
`;
}

export function parsePlistIdentity(
  xml: string,
): { label: string | null; argv: string[] | null } {
  const labelMatch = xml.match(
    /<key>\s*Label\s*<\/key>\s*<string>([^<]*)<\/string>/,
  );
  const label = labelMatch ? unescapeXml(labelMatch[1]) : null;
  const argsSection = xml.match(
    /<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/,
  );
  let argv: string[] | null = null;
  if (argsSection) {
    argv = [...argsSection[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) =>
      unescapeXml(m[1]),
    );
  }
  return { label, argv };
}

function plistFileFor(home: string): string {
  return path.join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

function bootoutTarget(uid: number): string {
  // Full service-target only: a bare domain bootout evicts every agent (D7).
  return `gui/${uid}/${SERVICE_LABEL}`;
}

// Bootstrap retries across launchd's teardown window. `launchctl bootout`
// returns before the service record clears, so an immediate bootstrap fails
// with "Bootstrap failed: 5" — the same error an already-loaded job gives.
// On error 5 we ask launchd which case it is: a loaded job the caller did
// not just stop means the goal is already met (idempotent start), while a
// missing record after a bootout means teardown is still in flight, so we
// wait and retry until the deadline instead of failing the install.
async function bootstrapWithRetry(
  run: (args: string[]) => string,
  uid: number,
  plistFile: string,
  opts: {
    expectReplace: boolean;
    sleep: (ms: number) => Promise<void>;
    timeoutMs: number;
  },
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    try {
      run(["bootstrap", `gui/${uid}`, plistFile]);
      return;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (!/Bootstrap failed:\s*5\b/.test(msg) || Date.now() >= deadline) {
        throw e;
      }
      let loaded = false;
      try {
        run(["print", `gui/${uid}/${SERVICE_LABEL}`]);
        loaded = true;
      } catch {
        loaded = false;
      }
      if (loaded && !opts.expectReplace) return;
      await opts.sleep(500);
    }
  }
}

function bootoutQuiet(
  run: (args: string[]) => string,
  uid: number,
  print: (msg: string) => void,
): void {
  try {
    run(["bootout", bootoutTarget(uid)]);
  } catch (e: any) {
    if (/could not find service/i.test(String(e?.message ?? e))) {
      print("service job is not loaded; nothing to stop");
      return;
    }
    throw e;
  }
}

function resolved(deps: ServiceDeps = {}) {
  return {
    home: deps.home ?? os.homedir(),
    uid: deps.uid ?? process.getuid?.() ?? 0,
    dataDir: deps.dataDir ?? path.dirname(getDbPath()),
    print: deps.print ?? console.log,
    run: deps.runLaunchctl ?? defaultRunLaunchctl,
    lint: deps.lintPlist ?? defaultLintPlist,
    sleep: deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))),
    bootstrapTimeoutMs: deps.bootstrapTimeoutMs ?? 10000,
  };
}

export async function install(deps: ServiceDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  if (!serviceSupported(platform)) {
    (deps.print ?? console.log)(foregroundGuidance("install", platform));
    return;
  }
  const { home, uid, dataDir, print, run, lint, sleep, bootstrapTimeoutMs } = resolved(deps);
  const version = deps.version ?? VERSION;
  // Provision beside the data dir the service will use (identical to the
  // QUOTACAP_HOME path in production; hermetic under injected test dirs).
  await ensureConfig(path.join(dataDir, "config.json"));

  const { argv, entry } = resolveServiceExec(deps);
  const providerPaths = resolveProviderPaths(deps);
  const plistFile = plistFileFor(home);
  const logFile = path.join(dataDir, "logs", "service.log");
  const plist = buildPlist({
    label: SERVICE_LABEL,
    argv,
    workingDirectory: dataDir,
    path: buildChildPath(providerPaths),
    logFile,
    quotacapHome: deps.quotacapHome ?? process.env.QUOTACAP_HOME ?? undefined,
    stdoutPath: logFile,
    stderrPath: logFile,
  });

  print(`quotacap service install (label ${SERVICE_LABEL})`);
  print(`  executable: ${argv.join(" ")}`);
  print(`  plist: ${plistFile}`);
  print(`  logs: ${logFile}`);
  for (const [bin, p] of Object.entries(providerPaths)) {
    print(`  provider ${bin}: ${p ?? "not found"}`);
  }
  for (const m of formatMissingProviders(providerPaths)) print(`  ${m}`);

  const existing = fs.existsSync(plistFile)
    ? fs.readFileSync(plistFile, "utf8")
    : null;
  if (existing !== null) {
    const { label } = parsePlistIdentity(existing);
    if (label !== SERVICE_LABEL) {
      throw new Error(
        `refusing to overwrite foreign plist at ${plistFile} (label ${label ?? "unknown"} is not ${SERVICE_LABEL})`,
      );
    }
    const meta = readServiceMetadata(dataDir);
    // Compare the whole generated plist, not just argv: the environment block
    // carries the provider PATH, so a provider that appeared since the last
    // install changes it. Recorded provider paths are compared too, so status
    // stops reporting a provider as missing after a rerun.
    const samePlist = existing === plist;
    const samePaths =
      !!meta &&
      PROVIDER_BINS.every(
        (bin) => (meta.providerPaths?.[bin] ?? null) === providerPaths[bin],
      );
    if (samePlist && samePaths && meta?.version === version) {
      await bootstrapWithRetry(run, uid, plistFile, {
        expectReplace: false,
        sleep,
        timeoutMs: bootstrapTimeoutMs,
      });
      run(["enable", `gui/${uid}/${SERVICE_LABEL}`]);
      print("service already installed and up to date; ensured loaded");
      return;
    }
    // Upgrade: refresh metadata, stop the old job, replace, load.
    writeServiceMetadata(
      {
        version,
        exec: argv[0],
        ...(entry ? { entry } : {}),
        providerPaths,
        installedAt: (deps.now?.() ?? new Date()).toISOString(),
      },
      dataDir,
    );
    bootoutQuiet(run, uid, print);
    // bootout is asynchronous: without this the replacement races the dying
    // process for the port, the same race restart() guards against.
    // deps.port keeps tests off the real daemon's port.
    const upgradePort = deps.port ?? (await readConfig()).port;
    const waitReleased = deps.waitReleased ?? defaultWaitReleased;
    if (!(await waitReleased(upgradePort))) {
      print(`port ${upgradePort} is still in use after stopping; starting anyway`);
    }
  } else {
    writeServiceMetadata(
      {
        version,
        exec: argv[0],
        ...(entry ? { entry } : {}),
        providerPaths,
        installedAt: (deps.now?.() ?? new Date()).toISOString(),
      },
      dataDir,
    );
  }

  fs.mkdirSync(path.dirname(plistFile), { recursive: true });
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(plistFile, plist, "utf8");
  lint(plistFile);
  await bootstrapWithRetry(run, uid, plistFile, {
    expectReplace: existing !== null,
    sleep,
    timeoutMs: bootstrapTimeoutMs,
  });
  run(["enable", `gui/${uid}/${SERVICE_LABEL}`]);
  print(existing !== null ? "service upgraded and loaded" : "service installed and loaded");
}

export async function uninstall(deps: ServiceDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  if (!serviceSupported(platform)) {
    (deps.print ?? console.log)(foregroundGuidance("uninstall", platform));
    return;
  }
  const { home, uid, dataDir, print, run } = resolved(deps);
  const plistFile = plistFileFor(home);
  try {
    const { label } = parsePlistIdentity(fs.readFileSync(plistFile, "utf8"));
    if (label !== SERVICE_LABEL) {
      throw new Error(
        `refusing to remove foreign plist at ${plistFile} (label ${label ?? "unknown"} is not ${SERVICE_LABEL})`,
      );
    }
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
  bootoutQuiet(run, uid, print);
  try {
    fs.rmSync(plistFile, { force: true });
  } catch {}
  print(`service registration removed; quota data and config preserved in ${dataDir}`);
}

export async function stop(deps: ServiceDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  if (!serviceSupported(platform)) {
    (deps.print ?? console.log)(foregroundGuidance("stop", platform));
    return;
  }
  const { uid, print, run } = resolved(deps);
  bootoutQuiet(run, uid, print);
  print("service stopped for this login session; registration kept for next login");
}

export async function start(deps: ServiceDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  if (!serviceSupported(platform)) {
    (deps.print ?? console.log)(foregroundGuidance("start", platform));
    return;
  }
  const { home, uid, dataDir, print, run, sleep, bootstrapTimeoutMs } = resolved(deps);
  const plistFile = plistFileFor(home);
  await bootstrapWithRetry(run, uid, plistFile, {
    expectReplace: false,
    sleep,
    timeoutMs: bootstrapTimeoutMs,
  });
  run(["enable", `gui/${uid}/${SERVICE_LABEL}`]);
  const waitReady = deps.waitReady ?? defaultWaitReady;
  const cfg = await readConfig();
  const ready = await waitReady(cfg.port);
  if (!ready) {
    throw new Error(
      `service did not become ready on port ${cfg.port}; check ${path.join(dataDir, "logs", "service.log")}`,
    );
  }
  print(`service started and ready on port ${cfg.port}`);
}

export async function restart(deps: ServiceDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  if (!serviceSupported(platform)) {
    (deps.print ?? console.log)(foregroundGuidance("restart", platform));
    return;
  }
  await stop(deps);
  // bootout is asynchronous: without this the replacement races the dying
  // process for the port and start() fails its readiness check.
  // deps.port keeps tests off the real daemon's port.
  const port = deps.port ?? (await readConfig()).port;
  const waitReleased = deps.waitReleased ?? defaultWaitReleased;
  if (!(await waitReleased(port))) {
    (deps.print ?? console.log)(
      `port ${port} is still in use after stopping; starting anyway`,
    );
  }
  await start(deps);
}

export interface ServiceStatus {
  backend: "launchd" | "systemd";
  registration: {
    installed: boolean;
    loaded: boolean;
    pid: number | null;
    lastExitStatus: number | null;
    plist: string | null;
    error: string | null;
  };
  readiness: {
    ok: boolean;
    ready: boolean;
    version: string | null;
    exec: string | null;
    polling: string | null;
    error: string | null;
  };
  version: { service: string | null; cli: string; skew: boolean };
  endpoint: { port: number | null; url: string | null; error: string | null };
  lastPoll: { at: string | null; ageMs: number | null; error: string | null };
  providers: {
    paths: Record<string, string | null> | null;
    missing: string[];
    error: string | null;
  };
}

function parsePrintOutput(out: string): {
  pid: number | null;
  lastExitStatus: number | null;
} {
  const pidMatch = out.match(/^\s*pid\s*=\s*(\d+)/m);
  const exitMatch = out.match(/^\s*last exit code\s*=\s*(-?\d+)/m);
  return {
    pid: pidMatch ? parseInt(pidMatch[1], 10) : null,
    lastExitStatus: exitMatch ? parseInt(exitMatch[1], 10) : null,
  };
}

// Each section is attempted independently: a failing section records its
// error without hiding the others. Read-only: never bootstraps or installs.
export async function collectStatus(deps: ServiceDeps = {}): Promise<ServiceStatus> {
  const home = deps.home ?? os.homedir();
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  const dataDir = deps.dataDir ?? path.dirname(getDbPath());
  const run = deps.runLaunchctl ?? defaultRunLaunchctl;
  const nowMs = (deps.now?.() ?? new Date()).getTime();
  const plistFile = plistFileFor(home);

  const status: ServiceStatus = {
    backend: "launchd",
    registration: {
      installed: false,
      loaded: false,
      pid: null,
      lastExitStatus: null,
      plist: plistFile,
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
    status.registration.installed = fs.existsSync(plistFile);
  } catch (e: any) {
    status.registration.error = String(e?.message ?? e);
  }
  try {
    const out = run(["print", `gui/${uid}/${SERVICE_LABEL}`]);
    const { pid, lastExitStatus } = parsePrintOutput(out);
    status.registration.loaded = true;
    status.registration.pid = pid;
    status.registration.lastExitStatus = lastExitStatus;
  } catch (e: any) {
    if (!/could not find service/i.test(String(e?.message ?? e))) {
      status.registration.error = String(e?.message ?? e);
    }
  }

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

function formatAge(ageMs: number | null): string {
  if (ageMs === null) return "unknown age";
  const s = Math.floor(ageMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function formatStatus(st: ServiceStatus): string {
  const lines: string[] = [];
  const r = st.registration;
  if (!r.installed && !r.loaded) {
    lines.push("Registration: not installed — run 'quotacap service install'");
  } else if (!r.loaded) {
    lines.push("Registration: installed but not loaded — run 'quotacap service start'");
  } else if (r.pid === null) {
    lines.push(
      `Registration: loaded but not running${r.lastExitStatus !== null ? ` (last exit ${r.lastExitStatus})` : ""}`,
    );
  } else {
    lines.push(`Registration: loaded (pid ${r.pid}, last exit ${r.lastExitStatus ?? "n/a"})`);
  }
  if (r.error) lines.push(`  error: ${r.error}`);
  lines.push(`  ${st.backend === "systemd" ? "unit" : "plist"}: ${r.plist ?? "(unknown)"}`);

  const h = st.readiness;
  if (h.ok) {
    lines.push(
      `Readiness: ${h.ready ? "ready" : "not ready"} (version ${h.version ?? "unknown"}, polling ${h.polling ?? "unknown"})`,
    );
  } else {
    lines.push(`Readiness: unavailable (${h.error ?? "unknown error"})`);
  }
  if (st.version.skew) {
    lines.push(
      `  version skew: service ${st.version.service} differs from CLI ${st.version.cli} — commands auto-restart the service on next use (or run 'quotacap service restart' now)`,
    );
  }

  lines.push(
    st.endpoint.url
      ? `Endpoint: ${st.endpoint.url}`
      : `Endpoint: unknown (${st.endpoint.error ?? "no port"})`,
  );

  lines.push(
    st.lastPoll.at
      ? `Last poll: ${st.lastPoll.at} (${formatAge(st.lastPoll.ageMs)})`
      : `Last poll: unknown${st.lastPoll.error ? ` (${st.lastPoll.error})` : ""}`,
  );

  const p = st.providers;
  if (p.paths) {
    lines.push("Providers:");
    for (const [bin, binPath] of Object.entries(p.paths)) {
      lines.push(
        binPath
          ? `  ${bin}: ${binPath}`
          : `  ${bin}: missing — install the ${bin} CLI, then re-run 'quotacap service install' to refresh`,
      );
    }
  } else {
    lines.push(
      `Providers: ${p.error ?? "unknown"} — run 'quotacap service install'`,
    );
  }
  return lines.join("\n");
}

export async function status(
  deps: ServiceDeps = {},
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
