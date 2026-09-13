// Self-update channels, latest-release resolution, and the passive daily
// update cache shared by the CLI writers and the daemon schedule.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareVersions, parseVersion } from "./versions.js";

export type Channel =
  | "npx"
  | "brew"
  | "source"
  | "pnpm"
  | "yarn"
  | "npm"
  | "standalone"
  | "unknown";

export interface ChannelEnv {
  execPath?: string;
  argv1?: string | undefined;
  brewPrefix?: () => string | null;
  npmPrefix?: () => string | null;
}

export function defaultBrewPrefix(): string | null {
  try {
    const out = execFileSync("brew", ["--prefix"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out ? out : null;
  } catch {
    return null;
  }
}

export function defaultNpmPrefix(): string | null {
  try {
    const out = execFileSync("npm", ["prefix", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out ? out : null;
  } catch {
    return null;
  }
}

function resolvePath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function underDir(candidate: string, dir: string): boolean {
  const base = dir.endsWith(path.sep) ? dir : dir + path.sep;
  return candidate === dir || candidate.startsWith(base);
}

// True when argv[1] is a real file inside a source checkout (a tree with
// src/cli/index.ts or a .git entry). Bare subcommand words never qualify:
// running an installed binary from inside a checkout must not read as source.
function isSourceCheckout(argv1: string): boolean {
  if (!argv1.includes("/") && !argv1.includes(path.sep) && !path.isAbsolute(argv1)) {
    return false;
  }
  let resolved: string;
  try {
    resolved = fs.realpathSync(argv1);
  } catch {
    return false;
  }
  if (!fs.existsSync(resolved)) return false;
  let dir = path.dirname(resolved);
  for (let i = 0; i < 25; i++) {
    try {
      if (fs.existsSync(path.join(dir, "src", "cli", "index.ts"))) return true;
      if (fs.existsSync(path.join(dir, ".git"))) return true;
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

// Detection order is the contract (design 5.1): npx, brew, source, pnpm,
// yarn, npm, standalone, unknown. First match wins.
export function detectChannel(env: ChannelEnv = {}): Channel {
  const execPath = env.execPath ?? process.execPath;
  const argv1 = "argv1" in env ? env.argv1 : process.argv[1];
  const brewPrefix = env.brewPrefix ?? defaultBrewPrefix;
  const npmPrefix = env.npmPrefix ?? defaultNpmPrefix;

  for (const cand of [execPath, argv1]) {
    if (
      typeof cand === "string" &&
      (cand.includes("/_npx/") || cand.includes("/.npm/_npx/"))
    ) {
      return "npx";
    }
  }

  const resolvedExec = resolvePath(execPath);
  if (resolvedExec.includes("/Cellar/")) return "brew";
  try {
    const prefix = brewPrefix();
    if (prefix && underDir(resolvedExec, prefix)) return "brew";
  } catch {}

  if (typeof argv1 === "string" && isSourceCheckout(argv1)) return "source";

  const resolvedArgv1 = typeof argv1 === "string" ? resolvePath(argv1) : "";
  if (
    resolvedArgv1.includes("/pnpm/") ||
    /\/global\/\d+\/node_modules\//.test(resolvedArgv1)
  ) {
    return "pnpm";
  }
  if (resolvedArgv1.includes("/yarn/global/") || resolvedArgv1.includes("/.yarn/")) {
    return "yarn";
  }
  if (typeof argv1 === "string" && /\.[cm]?js$/.test(argv1)) {
    try {
      const prefix = npmPrefix();
      if (prefix && underDir(resolvedArgv1, prefix)) return "npm";
    } catch {}
    // A JS launcher outside any global prefix is unknown, never npm: the
    // updater must not `npm install -g` from a guess.
    return "unknown";
  }
  if (path.basename(execPath) === "quotacap") return "standalone";
  return "unknown";
}

export interface ReleaseInfo {
  version: string;
  url: string;
}

// QUOTACAP_RELEASE_BASE_URL overrides both endpoints for hermetic update
// simulations (tests and offline mirrors); unset means GitHub.
export function releasesApiUrl(): string {
  const base = process.env.QUOTACAP_RELEASE_BASE_URL?.replace(/\/+$/, "");
  if (base) return `${base}/api/releases/latest`;
  return "https://api.github.com/repos/carlosboeing/quotacap/releases/latest";
}

// Default version endpoint: the releases page answers 302 to the latest tag
// and sits outside the anonymous API rate-limit bucket shared with every
// other API consumer on the machine.
export function releasesPageUrl(): string {
  return "https://github.com/carlosboeing/quotacap/releases/latest";
}

// Header read that tolerates real Headers and the plain-object headers that
// hermetic fetch mocks use.
function responseHeader(res: Response, name: string): string | null {
  const headers = (res as { headers?: unknown }).headers;
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name);
  }
  if (typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === name && typeof v === "string") return v;
    }
  }
  return null;
}

function tagFromReleaseUrl(location: string): string {
  const m = /\/releases\/tag\/([^/?#]+)/.exec(location);
  return m ? m[1] : "";
}

export function releaseDownloadBase(version: string): string {
  const base = process.env.QUOTACAP_RELEASE_BASE_URL?.replace(/\/+$/, "");
  if (base) return `${base}/download`;
  return version === "latest"
    ? "https://github.com/carlosboeing/quotacap/releases/latest/download"
    : `https://github.com/carlosboeing/quotacap/releases/download/v${version}`;
}

export type LatestVersionResolution =
  | { status: "ok"; release: ReleaseInfo }
  | { status: "rate-limited"; resetsAtMs: number | null }
  | { status: "unavailable" };

function rateLimitOrUnavailable(res: Response): LatestVersionResolution {
  if (responseHeader(res, "x-ratelimit-remaining") === "0") {
    const reset = responseHeader(res, "x-ratelimit-reset");
    const secs = reset !== null && reset.trim() !== "" ? Number(reset) : NaN;
    return {
      status: "rate-limited",
      resetsAtMs: Number.isFinite(secs) ? secs * 1000 : null,
    };
  }
  return { status: "unavailable" };
}

// Full resolution outcome: the release, a rate-limited response carrying its
// reset time, or an undifferentiated failure. Never throws.
export async function resolveLatestVersionDetailed(
  opts: { fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<LatestVersionResolution> {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10000;
  const base = process.env.QUOTACAP_RELEASE_BASE_URL?.replace(/\/+$/, "");
  try {
    if (base) {
      const res = await fetchFn(releasesApiUrl(), {
        headers: { accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        const body = (await res.json()) as any;
        const tag = typeof body?.tag_name === "string" ? body.tag_name : "";
        const version = tag.startsWith("v") ? tag.slice(1) : tag;
        if (parseVersion(version)) {
          const url =
            typeof body?.html_url === "string" && body.html_url
              ? body.html_url
              : "https://github.com/carlosboeing/quotacap/releases/latest";
          return { status: "ok", release: { version, url } };
        }
      }
      return rateLimitOrUnavailable(res);
    }
    const res = await fetchFn(releasesPageUrl(), {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400) {
      const location = responseHeader(res, "location") ?? "";
      const tag = tagFromReleaseUrl(location);
      const version = tag.startsWith("v") ? tag.slice(1) : tag;
      if (tag && parseVersion(version)) {
        return { status: "ok", release: { version, url: location } };
      }
    }
    return rateLimitOrUnavailable(res);
  } catch {
    return { status: "unavailable" };
  }
}

// Latest published version, or null when the release cannot be resolved
// (network failure, non-redirect, bad JSON, unparseable tag). Never throws.
export async function resolveLatestVersion(
  opts: { fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<ReleaseInfo | null> {
  const r = await resolveLatestVersionDetailed(opts);
  return r.status === "ok" ? r.release : null;
}

export interface UpdateCache {
  checkedAt: string;
  latest: string;
  channel: string;
  current: string;
  // Last failed refresh attempt, for negative caching. Optional so caches
  // written before it existed keep loading.
  lastFailureAt?: string;
}

export function updatesCachePath(): string {
  return path.join(
    process.env.QUOTACAP_HOME ?? os.homedir(),
    ".quotacap",
    "updates.json",
  );
}

export function readUpdateCache(p: string = updatesCachePath()): UpdateCache | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    if (
      typeof parsed.checkedAt !== "string" ||
      Number.isNaN(new Date(parsed.checkedAt).getTime())
    ) {
      return null;
    }
    if (typeof parsed.latest !== "string" || !parseVersion(parsed.latest)) return null;
    if (typeof parsed.channel !== "string" || typeof parsed.current !== "string") {
      return null;
    }
    if (
      parsed.lastFailureAt !== undefined &&
      (typeof parsed.lastFailureAt !== "string" ||
        Number.isNaN(new Date(parsed.lastFailureAt).getTime()))
    ) {
      return null;
    }
    return parsed as UpdateCache;
  } catch {
    return null;
  }
}

// Atomic (temp file plus rename) and best-effort: cache writes never fail a command.
export function writeUpdateCache(cache: UpdateCache, p: string = updatesCachePath()): void {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600, encoding: "utf8" });
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {}
    fs.renameSync(tmp, p);
  } catch {}
}

export const UPDATE_CACHE_TTL_MS = 24 * 3600 * 1000;

// Negative-cache floor: a failed refresh suppresses further network attempts
// for this long. Short against the daily TTL so a recovered endpoint is
// re-probed soon, long enough that status/advise/poll storms back off.
export const UPDATE_FAILURE_RETRY_MS = 30 * 60 * 1000;

export function updateCacheStale(cache: UpdateCache | null, nowMs: number = Date.now()): boolean {
  if (!cache) return true;
  return nowMs - new Date(cache.checkedAt).getTime() >= UPDATE_CACHE_TTL_MS;
}

// Refresh the daily cache when older than 24 hours or absent. A failure
// inside the retry floor performs no network call and keeps serving the
// previously cached latest; a fresh failure stamps lastFailureAt so the next
// attempt backs off. checkedAt is never stamped on failure, so the daily
// check is unaffected. The result is the cache to read from.
export async function refreshUpdateCache(
  opts: {
    channel: string;
    current: string;
    cachePath?: string;
    fetchFn?: typeof fetch;
    timeoutMs?: number;
    now?: () => Date;
  },
): Promise<UpdateCache | null> {
  const cachePath = opts.cachePath ?? updatesCachePath();
  const existing = readUpdateCache(cachePath);
  const now = opts.now?.() ?? new Date();
  if (!updateCacheStale(existing, now.getTime())) return existing;
  if (
    existing?.lastFailureAt &&
    now.getTime() - new Date(existing.lastFailureAt).getTime() < UPDATE_FAILURE_RETRY_MS
  ) {
    return existing;
  }
  const latest = await resolveLatestVersion({
    fetchFn: opts.fetchFn,
    timeoutMs: opts.timeoutMs ?? 3000,
  });
  if (!latest) {
    if (!existing) return existing;
    // Re-read before stamping: a concurrent refresh may have succeeded while
    // our request was in flight, and stamping our stale snapshot would
    // clobber its newer write and suppress retries for the floor.
    const current = readUpdateCache(cachePath);
    if (current && JSON.stringify(current) !== JSON.stringify(existing)) {
      return current;
    }
    const stamped: UpdateCache = { ...existing, lastFailureAt: now.toISOString() };
    writeUpdateCache(stamped, cachePath);
    return stamped;
  }
  const fresh: UpdateCache = {
    checkedAt: now.toISOString(),
    latest: latest.version,
    channel: opts.channel,
    current: opts.current,
  };
  writeUpdateCache(fresh, cachePath);
  return fresh;
}

// Staleness footer, or null when up to date or unknown.
export function updateFooter(current: string, latest: string | null): string | null {
  if (!latest) return null;
  if (compareVersions(latest, current) <= 0) return null;
  return `Update available: ${current} -> ${latest}. Run 'quotacap update' to upgrade.`;
}

// The footer goes to stderr only, TTY only, never under --json: piped and
// scripted use stays byte-clean.
export function printUpdateFooter(o: { json?: boolean }, footer: string | null): void {
  if (!footer || o.json || !process.stderr.isTTY) return;
  console.error(footer);
}

// Version identity line, printed next to the update footer under the same
// stderr/TTY rules, plus never under --compact (prompt renderers must not
// see per-render noise). The daemon part appears only when the reachable
// daemon reports a version that differs from the CLI.
export function printVersionLine(
  o: { json?: boolean; compact?: boolean },
  cliVersion: string,
  daemonVersion: unknown,
): void {
  if (o.json || o.compact || !process.stderr.isTTY) return;
  const daemon =
    typeof daemonVersion === "string" && daemonVersion ? daemonVersion : null;
  const suffix = daemon && daemon !== cliVersion ? ` · daemon ${daemon}` : "";
  console.error(`quotacap ${cliVersion}${suffix}`);
}

export function platformAssetName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  const a = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  if (!os || !a) {
    throw new Error(`unsupported platform for standalone update: ${platform}-${arch}`);
  }
  return `quotacap-${os}-${a}.tar.gz`;
}

// Same algorithm as install.sh: find the asset's hex digest in SHA256SUMS
// (tolerating CRLF, uppercase, and the `*` binary marker) and compare.
export function verifyChecksum(data: Buffer, sumsText: string, name: string): boolean {
  const lines = sumsText.replace(/\r/g, "").split("\n");
  let expected: string | null = null;
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const file = parts[1].startsWith("*") ? parts[1].slice(1) : parts[1];
    if (file === name) {
      expected = parts[0].toLowerCase();
      break;
    }
  }
  if (!expected) return false;
  const actual = crypto.createHash("sha256").update(data).digest("hex").toLowerCase();
  return actual === expected;
}

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d);
    else fs.copyFileSync(s, d);
  }
}

function chmodSpawnHelpers(ptyDir: string): void {
  const prebuilds = path.join(ptyDir, "node-pty", "prebuilds");
  let entries: string[];
  try {
    entries = fs.readdirSync(prebuilds);
  } catch {
    return;
  }
  for (const entry of entries) {
    try {
      fs.chmodSync(path.join(prebuilds, entry, "spawn-helper"), 0o755);
    } catch {}
  }
}

export function defaultExtractTar(tarball: string, destDir: string): void {
  execFileSync("tar", ["-xzf", tarball, "-C", destDir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export interface StandaloneUpdateOpts {
  target: string;
  execPath?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  extractTar?: (tarball: string, destDir: string) => void;
}

export interface StandaloneUpdateResult {
  ok: boolean;
  error?: string;
}

// In-place standalone upgrade: download SHA256SUMS plus the platform tarball
// to temp, verify, chmod, atomically rename over the running binary, and
// replace the alongside and XDG-share sidecars exactly as install.sh does.
// Checksum failure aborts before touching the installed binary.
export async function updateStandalone(
  opts: StandaloneUpdateOpts,
): Promise<StandaloneUpdateResult> {
  const execPath = opts.execPath ?? process.execPath;
  const homeDir = opts.homeDir ?? os.homedir();
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 60000;
  const extractTar = opts.extractTar ?? defaultExtractTar;
  // Never swap a binary that is not named quotacap: the standalone channel
  // guarantees this in production, and the guard turns a wrong-target bug
  // into a loud refusal instead of a clobbered executable.
  if (path.basename(execPath) !== "quotacap") {
    return { ok: false, error: `refusing to update ${execPath}: not a quotacap binary` };
  }
  let asset: string;
  try {
    asset = platformAssetName(opts.platform, opts.arch);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const dir = path.dirname(execPath);
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    return {
      ok: false,
      error:
        `install directory ${dir} is not writable; re-run the installer to upgrade ` +
        `(curl -fsSL https://raw.githubusercontent.com/carlosboeing/quotacap/main/install.sh | sh)`,
    };
  }
  const base = releaseDownloadBase(opts.target);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quotacap-update-"));
  try {
    let sumsText: string;
    let tarball: Buffer;
    try {
      const sumsRes = await fetchFn(`${base}/SHA256SUMS`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!sumsRes.ok) {
        return { ok: false, error: `download failed: SHA256SUMS (HTTP ${sumsRes.status})` };
      }
      sumsText = await sumsRes.text();
      const tarRes = await fetchFn(`${base}/${asset}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!tarRes.ok) {
        return { ok: false, error: `download failed: ${asset} (HTTP ${tarRes.status})` };
      }
      tarball = Buffer.from(await tarRes.arrayBuffer());
    } catch (e) {
      return { ok: false, error: `download failed: ${(e as Error)?.message ?? String(e)}` };
    }
    if (!verifyChecksum(tarball, sumsText, asset)) {
      return { ok: false, error: `checksum mismatch for ${asset}; installed binary left untouched` };
    }
    const extractDir = path.join(tmp, "extract");
    fs.mkdirSync(extractDir, { recursive: true });
    const tarballPath = path.join(tmp, asset);
    fs.writeFileSync(tarballPath, tarball);
    try {
      extractTar(tarballPath, extractDir);
    } catch (e) {
      return { ok: false, error: `could not extract ${asset}: ${(e as Error)?.message ?? String(e)}` };
    }
    const newBin = path.join(extractDir, "quotacap");
    if (!fs.existsSync(newBin)) {
      return { ok: false, error: `release tarball did not contain the quotacap binary` };
    }
    try {
      fs.chmodSync(newBin, 0o755);
      fs.renameSync(newBin, execPath);
    } catch (e) {
      return { ok: false, error: `could not replace ${execPath}: ${(e as Error)?.message ?? String(e)}` };
    }
    const sidecar = path.join(extractDir, "pty");
    if (fs.existsSync(sidecar) && fs.statSync(sidecar).isDirectory()) {
      for (const dest of [
        path.join(dir, "pty"),
        path.join(homeDir, ".local", "share", "quotacap", "pty"),
      ]) {
        try {
          fs.rmSync(dest, { recursive: true, force: true });
          copyDirSync(sidecar, dest);
          chmodSpawnHelpers(dest);
        } catch {}
      }
    }
    return { ok: true };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export interface NpmUpdateOpts {
  target: string;
  execPath?: string;
  homeDir?: string;
  spawnNpm?: (args: string[]) => Promise<number>;
}

export interface NpmUpdateResult {
  ok: boolean;
  error?: string;
  shadowWarning?: string;
}

export async function defaultSpawnNpm(args: string[]): Promise<number> {
  try {
    execFileSync("npm", args, { stdio: "inherit" });
    return 0;
  } catch (e: any) {
    return typeof e?.status === "number" ? e.status : 1;
  }
}

// npm global upgrade: warn loudly when a standalone binary may shadow the
// npm install, then spawn `npm install -g` with inherited stdio.
export async function updateNpm(opts: NpmUpdateOpts): Promise<NpmUpdateResult> {
  const execPath = opts.execPath ?? process.execPath;
  const homeDir = opts.homeDir ?? os.homedir();
  const spawnNpm = opts.spawnNpm ?? defaultSpawnNpm;
  let shadowWarning: string | undefined;
  const shadow = path.join(homeDir, ".local", "bin", "quotacap");
  try {
    if (fs.existsSync(shadow) && resolvePath(shadow) !== resolvePath(execPath)) {
      shadowWarning =
        `warning: standalone binary at ${shadow} may shadow this npm install; ` +
        `remove one of them to avoid version confusion`;
    }
  } catch {}
  const code = await spawnNpm(["install", "-g", `quotacap@${opts.target}`]);
  if (code !== 0) {
    return {
      ok: false,
      error: `npm install -g quotacap@${opts.target} exited ${code}`,
      shadowWarning,
    };
  }
  return { ok: true, shadowWarning };
}

