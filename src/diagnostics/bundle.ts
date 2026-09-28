// Opt-in failure forensics: on a poll failure, persist a redacted evidence
// bundle under <dataDir>/failures/<provider>-<timestamp>-<rand>/. Bundles
// are local-only (never uploaded) and exist so the next "bad resets
// timestamp" arrives with the transcript that explains it. Off by default;
// enabled via config `debugFailureBundles` or env QUOTACAP_DEBUG_FAILURES.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { getErrorEvidence, type DiagnosticCode } from "./failure.js";
import { renderScreen } from "../adapters/vt.js";
import { isGoldenCovered } from "../adapters/goldens.js";

export const BUNDLE_KEEP_PER_PROVIDER = 5;
const RAW_CAP = 64 * 1024;
const RENDERED_CAP = 32 * 1024;
const STDERR_CAP = 8 * 1024;
const MESSAGE_CAP = 2048;

// Emails, URLs, bearer tokens, and long token-like runs. Percents, dates,
// and short identifiers pass through: parse debugging needs them.
export function redactText(s: string): string {
  return s
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[token]")
    .replace(/\b[A-Za-z0-9_~+\/=.-]{32,}\b/g, "[token]");
}

function cap(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n…[truncated, ${s.length} chars total]` : s;
}

// Providers without a version-reporting CLI (credential stores, virtual).
const NO_CLI_PROVIDERS = new Set(["opencode-go", "manual", "all"]);

export function providerBin(
  provider: string,
  providerPaths?: Record<string, string | null>,
): string | null {
  if (NO_CLI_PROVIDERS.has(provider)) return null;
  const recorded = providerPaths?.[provider];
  if (typeof recorded === "string" && recorded.length > 0) return recorded;
  return provider;
}

/** Best-effort `<bin> --version` first line, or null. Never throws. */
export function getCliVersion(bin: string, timeoutMs = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        resolve(null);
        return;
      }
      const first = `${stdout ?? ""}\n${stderr ?? ""}`
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      resolve(first ? first.slice(0, 120) : null);
    });
  });
}

export interface FailureBundleInput {
  dataDir: string;
  provider: string;
  attemptedAt: string;
  reason: unknown;
  diagnosticCode: DiagnosticCode;
  summary: string;
  errorDetail: string;
  attemptDurationMs?: number;
  timeoutMs?: number;
  quotacapVersion?: string;
  cliBin?: string | null;
  cliVersion?: string | null;
}

async function pruneOldBundles(failuresDir: string, provider: string): Promise<void> {
  try {
    const entries = await fs.readdir(failuresDir);
    const ours = entries.filter((e) => e === provider || e.startsWith(`${provider}-`)).sort();
    const stale = ours.slice(0, Math.max(0, ours.length - BUNDLE_KEEP_PER_PROVIDER));
    await Promise.all(
      stale.map((e) => fs.rm(path.join(failuresDir, e), { recursive: true, force: true }).catch(() => {})),
    );
  } catch {}
}

/** Write one bundle. Never throws: returns the dir path, or null. */
export async function writeFailureBundle(input: FailureBundleInput): Promise<string | null> {
  try {
    const stamp = input.attemptedAt.replace(/[:.]/g, "-");
    const rand = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
    const dir = path.join(input.dataDir, "failures", `${input.provider}-${stamp}-${rand}`);
    await fs.mkdir(dir, { recursive: true });

    const evidence = getErrorEvidence(input.reason);
    const raw = typeof evidence?.stdout === "string" ? evidence.stdout : "";
    const message =
      input.reason instanceof Error ? input.reason.message : String((input.reason as any)?.message ?? input.reason);

    const files: Array<[string, string]> = [];
    if (raw) {
      files.push(["transcript-raw.txt", redactText(cap(raw, RAW_CAP))]);
      if (evidence?.source === "pty") {
        files.push(["transcript.txt", redactText(cap(renderScreen(raw), RENDERED_CAP))]);
      }
    }
    const errLines = [
      `summary: ${input.summary}`,
      `code: ${input.diagnosticCode}`,
      `detail: ${input.errorDetail}`,
      `message: ${redactText(cap(message, MESSAGE_CAP))}`,
    ];
    if (evidence?.checkpoint) errLines.push(`checkpoint: ${evidence.checkpoint}`);
    if (evidence?.exitCode !== undefined) errLines.push(`exitCode: ${evidence.exitCode}`);
    if (evidence?.durationMs !== undefined) errLines.push(`durationMs: ${evidence.durationMs}`);
    if (evidence?.timings) errLines.push(`timings: ${JSON.stringify(evidence.timings)}`);
    const stderr = typeof evidence?.stderr === "string" ? evidence.stderr.trim() : "";
    if (stderr) errLines.push(`stderr:\n${redactText(cap(stderr, STDERR_CAP))}`);
    files.push(["error.txt", errLines.join("\n") + "\n"]);

    const meta = {
      provider: input.provider,
      attemptedAt: input.attemptedAt,
      quotacapVersion: input.quotacapVersion ?? null,
      cliBin: input.cliBin ?? null,
      cliVersion: input.cliVersion ?? null,
      goldenCovered: input.cliVersion ? isGoldenCovered(input.provider, input.cliVersion) : null,
      diagnosticCode: input.diagnosticCode,
      summary: input.summary,
      errorDetail: input.errorDetail,
      attemptDurationMs: input.attemptDurationMs ?? null,
      timeoutMs: input.timeoutMs ?? null,
      checkpoint: evidence?.checkpoint ?? null,
      exitCode: evidence?.exitCode ?? null,
      durationMs: evidence?.durationMs ?? null,
      timings: evidence?.timings ?? null,
      hasTranscript: raw.length > 0,
    };
    files.push(["meta.json", JSON.stringify(meta, null, 2) + "\n"]);

    await Promise.all(files.map(([name, content]) => fs.writeFile(path.join(dir, name), content, "utf8")));
    await pruneOldBundles(path.join(input.dataDir, "failures"), input.provider);
    return dir;
  } catch {
    return null;
  }
}
