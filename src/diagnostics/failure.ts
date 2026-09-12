import type { FailureCategory } from "../store/attempts.js";

export type DiagnosticCode =
  | "terminal_error"
  | "auth"
  | "command_not_found"
  | "trust_prompt"
  | "parse_error"
  | "rate_limit"
  | "timeout"
  | "network"
  | "unknown";

export interface FailureEvidence {
  source: "pty" | "exec";
  checkpoint?:
    | "spawn"
    | "before ready"
    | "during settle"
    | "before input"
    | "before completion"
    | "ready timeout"
    | "completion timeout"
    | "abort"
    | "trust prompt"
    | "write"
    | "transcript overflow";
  exitCode?: number;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
}

export interface SafeDiagnostic {
  diagnosticCode: DiagnosticCode;
  errorDetail: string;
}

export interface ClassifiedFailure extends SafeDiagnostic {
  category: Exclude<FailureCategory, null | "skipped">;
  summary: string;
  action: string;
}

export class DiagnosticError extends Error {
  readonly diagnostic: SafeDiagnostic;
  constructor(diagnostic: SafeDiagnostic) {
    super(diagnostic.errorDetail);
    this.name = "DiagnosticError";
    this.diagnostic = Object.freeze({ ...diagnostic });
  }
}

export function formatProviderName(provider: string): string {
  switch (provider) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "grok":
      return "Grok";
    case "kimi":
      return "Kimi";
    case "agy":
      return "Antigravity";
    case "agy:3p":
      return "Antigravity (3rd-party)";
    case "all":
      return "QuotaCap service";
    default:
      return "Provider";
  }
}

function stripAnsiAndControls(s: string): string {
  return s
    .replace(/\x1b\[[^A-Za-z]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b\][^\x1b]*\x1b\\/g, "")
    .replace(/\x1b\([A-B0-2]/g, "")
    .replace(/\x1b[=>]|\x1b7|\x1b8|\x1bD|\x1bM/g, "")
    .replace(/[\r\n\t]+/g, " ");
}

const UNRECOGNIZED_OMITTED = "Unrecognized diagnostic text omitted";

interface MatchResult {
  code: DiagnosticCode;
  phrase?: string;
}

function matchPrecedence(
  evidence: FailureEvidence | undefined,
  errorName: string,
  errorCode: string | undefined,
  text: string,
): MatchResult {
  // Order 1: timeout — Structured AbortError or an explicit QuotaCap abort/timeout checkpoint
  const isAbort =
    errorName === "AbortError" ||
    errorCode === "ABORT_ERR" ||
    evidence?.checkpoint === "abort" ||
    evidence?.checkpoint === "ready timeout" ||
    evidence?.checkpoint === "completion timeout" ||
    /\bpty aborted\b/i.test(text);

  if (isAbort) {
    return { code: "timeout", phrase: "timed out" };
  }

  // Order 2: command_not_found — Spawn ENOENT, command not found, is not recognized, or explicit executable-not-found
  // Bare "not found" is insufficient!
  if (
    errorCode === "ENOENT" ||
    /\bENOENT\b/i.test(text) ||
    /\bcommand not found\b/i.test(text) ||
    /\bis not recognized\b/i.test(text) ||
    /\bexecutable not found\b/i.test(text)
  ) {
    return { code: "command_not_found", phrase: "command not found" };
  }

  // Order 3: terminal_error — stdin is not a terminal, device not configured, not a tty, inappropriate ioctl,
  // Bun lacks terminal (PTY) support, node-pty not available
  if (/\bstdin is not a terminal\b/i.test(text)) {
    return { code: "terminal_error", phrase: "stdin is not a terminal" };
  }
  if (/\bdevice not configured\b/i.test(text)) {
    return { code: "terminal_error", phrase: "device not configured" };
  }
  if (/\bnot a tty\b/i.test(text)) {
    return { code: "terminal_error", phrase: "not a tty" };
  }
  if (/\binappropriate ioctl\b/i.test(text)) {
    return { code: "terminal_error", phrase: "inappropriate ioctl" };
  }
  if (/lacks terminal \(PTY\) support/i.test(text)) {
    return { code: "terminal_error", phrase: "Bun runtime lacks terminal (PTY) support" };
  }
  if (/\bnode-pty not available\b/i.test(text)) {
    return { code: "terminal_error", phrase: "node-pty not available" };
  }

  // Order 4: trust_prompt — untrusted workspace, trust prompt, trust this folder
  if (/\buntrusted workspace\b/i.test(text)) {
    return { code: "trust_prompt", phrase: "untrusted workspace" };
  }
  if (/\btrust prompt\b/i.test(text)) {
    return { code: "trust_prompt", phrase: "trust prompt" };
  }
  if (/\btrust this folder\b/i.test(text)) {
    return { code: "trust_prompt", phrase: "trust prompt" };
  }

  // Order 5: rate_limit — rate limit, rate_limit, too many requests, quota exceeded, or explicit HTTP status 429
  // A bare number 429 is insufficient
  if (/\brate[ _]limit\b/i.test(text)) {
    return { code: "rate_limit", phrase: "rate limit" };
  }
  if (/\btoo many requests\b/i.test(text)) {
    return { code: "rate_limit", phrase: "too many requests" };
  }
  if (/\bquota exceeded\b/i.test(text)) {
    return { code: "rate_limit", phrase: "quota exceeded" };
  }
  if (/\b(?:status|code|http)\s*:?\s*429\b/i.test(text) || /\b429\s+too many requests\b/i.test(text)) {
    return { code: "rate_limit", phrase: "HTTP 429" };
  }

  // Order 6: auth — login required, not logged in, logged out, unauthorized, unauthorised, forbidden,
  // run <provider> login to continue, or error indicating missing, invalid, or expired credentials, authentication, or API key
  if (/\brun\s+[a-z0-9_:-]+\s+login\s+to\s+continue\b/i.test(text)) {
    return { code: "auth", phrase: "run <provider> login to continue" };
  }
  if (/\blogin required\b/i.test(text)) {
    return { code: "auth", phrase: "login required" };
  }
  if (/\bnot logged in\b/i.test(text)) {
    return { code: "auth", phrase: "not logged in" };
  }
  if (/\blogged out\b/i.test(text)) {
    return { code: "auth", phrase: "logged out" };
  }
  if (/\bunauthorized\b/i.test(text) || /\bunauthorised\b/i.test(text)) {
    return { code: "auth", phrase: "unauthorized" };
  }
  if (/\bforbidden\b/i.test(text)) {
    return { code: "auth", phrase: "forbidden" };
  }
  if (/\bcredentials?\s+(?:file\s+)?not found\b/i.test(text)) {
    return { code: "auth", phrase: "credential not found" };
  }
  if (
    /\b(?:missing|no)\s+credentials?(?:\s+file)?\b/i.test(text) ||
    /\bmissing api key\b/i.test(text) ||
    /\bcredentials?\s+missing\b/i.test(text)
  ) {
    return { code: "auth", phrase: "missing credentials" };
  }
  if (/\binvalid credentials?\b/i.test(text) || /\binvalid api key\b/i.test(text)) {
    return { code: "auth", phrase: "invalid credentials" };
  }
  if (/\bexpired credentials?\b/i.test(text) || /\bexpired token\b/i.test(text) || /\bexpired api key\b/i.test(text)) {
    return { code: "auth", phrase: "expired credentials" };
  }
  if (
    /\bauthentication failed\b/i.test(text) ||
    /\bauthentication required\b/i.test(text) ||
    /\bmissing authentication\b/i.test(text)
  ) {
    return { code: "auth", phrase: "authentication failed" };
  }

  // Order 7: network — ENOTFOUND, ECONNREFUSED, ETIMEDOUT, EAI_AGAIN, fetch failed
  if (errorCode === "ENOTFOUND" || /\bENOTFOUND\b/i.test(text)) {
    return { code: "network", phrase: "ENOTFOUND" };
  }
  if (errorCode === "ECONNREFUSED" || /\bECONNREFUSED\b/i.test(text)) {
    return { code: "network", phrase: "ECONNREFUSED" };
  }
  if (errorCode === "ETIMEDOUT" || /\bETIMEDOUT\b/i.test(text)) {
    return { code: "network", phrase: "ETIMEDOUT" };
  }
  if (errorCode === "EAI_AGAIN" || /\bEAI_AGAIN\b/i.test(text)) {
    return { code: "network", phrase: "EAI_AGAIN" };
  }
  if (/\bfetch failed\b/i.test(text)) {
    return { code: "network", phrase: "fetch failed" };
  }

  // Order 8: parse_error — Structured SyntaxError, bad resets timestamp, bad timestamp, invalid date, or explicit parse/syntax failure
  if (errorName === "SyntaxError" || /\bSyntaxError\b/i.test(text)) {
    return { code: "parse_error", phrase: "SyntaxError" };
  }
  if (/\bbad resets timestamp\b/i.test(text)) {
    return { code: "parse_error", phrase: "bad resets timestamp" };
  }
  if (/\bbad timestamp\b/i.test(text)) {
    return { code: "parse_error", phrase: "bad timestamp" };
  }
  if (/\binvalid date\b/i.test(text)) {
    return { code: "parse_error", phrase: "invalid date" };
  }
  if (/\bparse error\b/i.test(text) || /\bsyntax error\b/i.test(text) || /\bfailed to parse\b/i.test(text)) {
    return { code: "parse_error", phrase: "parse error" };
  }

  // Order 9: timeout — Remaining explicit timeout or timed out errors
  if (/\btimed out\b/i.test(text) || /\btimeout\b/i.test(text)) {
    return { code: "timeout", phrase: "timed out" };
  }

  // Order 10: unknown — Everything else
  return { code: "unknown" };
}

function parseWrapperMetadata(msg: string): {
  checkpoint?: FailureEvidence["checkpoint"];
  exitCode?: number;
  durationMs?: number;
} {
  const matchExit = msg.match(
    /^pty exited (?:(spawn|before ready|during settle|before input|before completion)\s+)?\(code (-?\d+)\)/,
  );
  if (matchExit) {
    const cp = matchExit[1] as FailureEvidence["checkpoint"] | undefined;
    const code = parseInt(matchExit[2], 10);
    return {
      checkpoint: cp ?? "during settle",
      exitCode: isNaN(code) ? undefined : code,
    };
  }
  const matchReadyTimeout = msg.match(/^pty ready timeout after (\d+)ms/);
  if (matchReadyTimeout) {
    return {
      checkpoint: "ready timeout",
      durationMs: parseInt(matchReadyTimeout[1], 10),
    };
  }
  const matchCompletionTimeout = msg.match(/^pty completion timeout after (\d+)ms/);
  if (matchCompletionTimeout) {
    return {
      checkpoint: "completion timeout",
      durationMs: parseInt(matchCompletionTimeout[1], 10),
    };
  }
  if (/^pty transcript exceeds/.test(msg)) {
    return { checkpoint: "transcript overflow" };
  }
  if (/^pty write failed/.test(msg)) {
    return { checkpoint: "write" };
  }
  if (/^pty aborted/.test(msg)) {
    return { checkpoint: "abort" };
  }
  return {};
}

function buildPrefix(
  source: "pty" | "exec" | undefined,
  checkpoint: FailureEvidence["checkpoint"] | undefined,
  exitCode: number | undefined,
  durationMs: number | undefined,
): string | null {
  if (source === "pty" || checkpoint) {
    if (checkpoint === "ready timeout") {
      return `pty ready timeout${durationMs !== undefined ? ` after ${durationMs}ms` : ""}`;
    }
    if (checkpoint === "completion timeout") {
      return `pty completion timeout${durationMs !== undefined ? ` after ${durationMs}ms` : ""}`;
    }
    if (checkpoint === "transcript overflow") {
      return "pty transcript exceeds limit";
    }
    if (checkpoint === "write") {
      return "pty write failed";
    }
    if (checkpoint === "abort") {
      return "pty aborted";
    }
    if (checkpoint === "spawn") {
      return "pty spawn failed";
    }
    const cpStr = checkpoint ? `${checkpoint} ` : "";
    const codeStr = exitCode !== undefined ? ` (code ${exitCode})` : "";
    if (cpStr || codeStr) {
      return `pty exited ${cpStr.trim()}${codeStr}`.replace(/\s+/g, " ");
    }
    return "pty exited";
  }
  if (source === "exec") {
    if (exitCode !== undefined) {
      return `exec exited (code ${exitCode})`;
    }
    return "exec failed";
  }
  return null;
}

export function diagnosticError(reason: unknown, evidence?: FailureEvidence): DiagnosticError {
  if (reason instanceof DiagnosticError) {
    return reason;
  }

  let errorName = "";
  let errorCode: string | undefined;
  let reasonMsg = "";

  if (reason instanceof Error) {
    errorName = reason.name;
    errorCode = (reason as any).code;
    reasonMsg = reason.message;
  } else if (typeof reason === "string") {
    reasonMsg = reason;
  }

  let checkpoint = evidence?.checkpoint;
  let exitCode = typeof evidence?.exitCode === "number" && Number.isInteger(evidence.exitCode) ? evidence.exitCode : undefined;
  let durationMs = typeof evidence?.durationMs === "number" && Number.isInteger(evidence.durationMs) ? evidence.durationMs : undefined;

  // If evidence didn't supply metadata, check if reasonMsg has standard wrapper metadata
  if (!checkpoint && exitCode === undefined) {
    const parsed = parseWrapperMetadata(reasonMsg);
    checkpoint = parsed.checkpoint;
    if (parsed.exitCode !== undefined) exitCode = parsed.exitCode;
    if (parsed.durationMs !== undefined) durationMs = parsed.durationMs;
  }

  // Filter stdout to avoid matching non-error screen text (like login menus)
  let safeStdoutText = "";
  if (evidence?.stdout) {
    if (evidence.source === "pty") {
      const lines = evidence.stdout.split(/[\r\n]+/);
      const matchedLines = lines.filter(
        (l) =>
          /\b(error|failed|failure|fatal|unauthorized|unauthorised|denied|forbidden|panic|exception)\b/i.test(l) ||
          /\btrust\b/i.test(l) ||
          /\b(stdin is not a terminal|device not configured|not a tty|inappropriate ioctl|node-pty)\b/i.test(l),
      );
      safeStdoutText = matchedLines.join(" ");
    } else {
      safeStdoutText = evidence.stdout;
    }
  }

  const combinedEvidenceText = [reasonMsg, evidence?.stderr, safeStdoutText]
    .filter(Boolean)
    .join(" ");

  const cleanText = stripAnsiAndControls(combinedEvidenceText);

  const match = matchPrecedence(evidence, errorName, errorCode, cleanText);

  const prefix = buildPrefix(evidence?.source, checkpoint, exitCode, durationMs);

  let detail: string;
  if (match.phrase) {
    if (prefix) {
      if (prefix.toLowerCase().includes(match.phrase.toLowerCase())) {
        detail = prefix;
      } else {
        detail = `${prefix}: ${match.phrase}`;
      }
    } else {
      detail = match.phrase;
    }
  } else {
    if (prefix) {
      detail = `${prefix}: ${UNRECOGNIZED_OMITTED}`;
    } else {
      detail = UNRECOGNIZED_OMITTED;
    }
  }

  // Clean, single-line, maximum 300 characters
  detail = stripAnsiAndControls(detail).trim();
  if (detail.length > 300) {
    detail = detail.slice(0, 300);
  }

  return new DiagnosticError({
    diagnosticCode: match.code,
    errorDetail: detail,
  });
}

function mapCategory(code: DiagnosticCode): Exclude<FailureCategory, null | "skipped"> {
  switch (code) {
    case "auth":
      return "auth";
    case "parse_error":
      return "parse";
    case "timeout":
      return "timeout";
    case "network":
      return "network";
    case "terminal_error":
    case "command_not_found":
    case "trust_prompt":
    case "rate_limit":
    case "unknown":
    default:
      return "unknown";
  }
}

function getSummaryAndAction(
  code: DiagnosticCode,
  providerName: string,
): { summary: string; action: string } {
  switch (code) {
    case "terminal_error":
      return {
        summary: `Unable to open ${providerName} session`,
        action: `Open ${providerName} directly in your terminal to check whether it starts. If it works there, inspect the QuotaCap service log and report the adapter failure. Refresh in the dashboard retries through the same service.`,
      };
    case "auth":
      return {
        summary: `${providerName} login required`,
        action: `Open ${providerName} and follow its sign-in instructions. Then select Refresh in the QuotaCap dashboard.`,
      };
    case "command_not_found":
      return {
        summary: `${providerName} not found`,
        action: `Make sure ${providerName} is installed and available to the QuotaCap service. Check the service's configured executable and PATH if it works in your terminal.`,
      };
    case "trust_prompt":
      return {
        summary: `${providerName} security prompt pending`,
        action: `Open ${providerName} in the workspace used by the QuotaCap adapter and review the folder approval prompt. Approve it only if you trust that workspace, then select Refresh.`,
      };
    case "parse_error":
      return {
        summary: `Unable to read ${providerName} usage`,
        action: `QuotaCap could not read the usage output. Check for a QuotaCap update or report the adapter failure.`,
      };
    case "rate_limit":
      return {
        summary: `${providerName} rate limited`,
        action: `Wait before retrying. While the service is running, QuotaCap will try again on its next scheduled poll.`,
      };
    case "timeout":
      return {
        summary: `${providerName} took too long to respond`,
        action: `Open ${providerName} directly to check whether it is waiting for input or updating. Then select Refresh in the QuotaCap dashboard.`,
      };
    case "network":
      return {
        summary: "Connection failed",
        action:
          "QuotaCap could not reach the network. Check the service's internet connection or proxy settings, then select Refresh.",
      };
    case "unknown":
    default:
      return {
        summary: `${providerName} stopped unexpectedly`,
        action: `Inspect the configured QuotaCap service log for the attempt time and sanitized diagnostics. Report the adapter failure if it continues.`,
      };
  }
}

export function classifyFailure(provider: string, reason: unknown): ClassifiedFailure {
  let diag: SafeDiagnostic;
  if (reason instanceof DiagnosticError) {
    diag = reason.diagnostic;
  } else {
    diag = diagnosticError(reason).diagnostic;
  }

  const category = mapCategory(diag.diagnosticCode);
  const pName = formatProviderName(provider);
  const { summary, action } = getSummaryAndAction(diag.diagnosticCode, pName);

  return {
    diagnosticCode: diag.diagnosticCode,
    errorDetail: diag.errorDetail,
    category,
    summary,
    action,
  };
}
