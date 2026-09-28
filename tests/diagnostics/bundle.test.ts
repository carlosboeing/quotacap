import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  redactText,
  providerBin,
  getCliVersion,
  writeFailureBundle,
  BUNDLE_KEEP_PER_PROVIDER,
} from "../../src/diagnostics/bundle.js";
import {
  attachEvidence,
  getErrorEvidence,
  diagnosticError,
  DiagnosticError,
} from "../../src/diagnostics/failure.js";
import { createCoordinator } from "../../src/runtime/poll.js";
import { openDb, migrate } from "../../src/store/db.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function mkdir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "qc-bundle-"));
  dirs.push(d);
  return d;
}

describe("redactText", () => {
  it("redacts emails, urls, and token-like runs", () => {
    const out = redactText(
      "Account: carlosboeing@gmail.com (Plus) https://example.com/signin?token=abc bearer SECRETVALUE123 Weekly 26%",
    );
    expect(out).toContain("[email]");
    expect(out).toContain("[url]");
    expect(out).toContain("bearer [token]");
    expect(out).not.toContain("carlosboeing@gmail.com");
    expect(out).not.toContain("example.com/signin");
  });

  it("preserves percents, dates, and short identifiers", () => {
    const s = "Weekly limit (SuperGrok)  26% Resets: October 5, 10:22 plan Plus";
    expect(redactText(s)).toBe(s);
  });

  it("redacts long session ids but keeps short ones", () => {
    expect(redactText("id 3994599e-2f76-4a85-8267-0ac517e41664 ok")).toContain("[token]");
    expect(redactText("pid 1234 ok")).toBe("pid 1234 ok");
  });
});

describe("providerBin", () => {
  it("resolves recorded paths, falls back to the id, and skips non-CLIs", () => {
    expect(providerBin("grok", { grok: "/x/grok" })).toBe("/x/grok");
    expect(providerBin("grok", {})).toBe("grok");
    expect(providerBin("grok")).toBe("grok");
    expect(providerBin("opencode-go", { "opencode-go": "/x/oc" })).toBeNull();
    expect(providerBin("manual")).toBeNull();
  });
});

describe("getCliVersion", () => {
  it("reports the first --version line and nulls on failure", async () => {
    const v = await getCliVersion(process.execPath);
    expect(v).toMatch(/^v\d+/);
    await expect(getCliVersion("quotacap-no-such-bin-xyz")).resolves.toBeNull();
  }, 15000);
});

describe("evidence side-channel", () => {
  it("round-trips through attach/get without touching the message", () => {
    const err = new Error("grok: bad resets timestamp");
    attachEvidence(err, { source: "pty", stdout: "transcript here" });
    expect(err.message).toBe("grok: bad resets timestamp");
    expect(getErrorEvidence(err)).toEqual({ source: "pty", stdout: "transcript here" });
    expect(JSON.stringify(err)).not.toContain("transcript here");
  });

  it("ignores non-objects and malformed slots", () => {
    expect(getErrorEvidence(null)).toBeUndefined();
    expect(getErrorEvidence("nope")).toBeUndefined();
    expect(getErrorEvidence(new Error("plain"))).toBeUndefined();
  });

  it("DiagnosticError carries construction evidence", () => {
    const err = diagnosticError(new Error("pty completion timeout after 100ms"), {
      source: "pty",
      checkpoint: "completion timeout",
      stdout: "partial",
    });
    expect(err).toBeInstanceOf(DiagnosticError);
    expect(getErrorEvidence(err)).toMatchObject({ source: "pty", checkpoint: "completion timeout" });
    // Classification still sanitizes: the transcript never leaks into detail.
    expect(err.diagnostic.errorDetail).not.toContain("partial");
  });
});

describe("writeFailureBundle", () => {
  function failingReason(): Error {
    const err = new Error("grok: bad resets timestamp");
    attachEvidence(err, {
      source: "pty",
      checkpoint: "completion timeout",
      durationMs: 14000,
      timings: { start: 0, input: 5010, completion: 14000 },
      stdout: "Weekly limt (SuperGrok)\nResets: October5, 10:22\nAccount: carlosboeing@gmail.com (Plus)\n",
    });
    return err;
  }

  it("writes error, meta, and redacted transcripts", async () => {
    const dataDir = mkdir();
    const dir = await writeFailureBundle({
      dataDir,
      provider: "grok",
      attemptedAt: "2026-09-28T04:20:07.593Z",
      reason: failingReason(),
      diagnosticCode: "parse_error",
      summary: "Unable to read Grok usage",
      errorDetail: "bad resets timestamp",
      attemptDurationMs: 14123,
      timeoutMs: 14000,
      quotacapVersion: "0.0.42",
      cliBin: "grok",
      cliVersion: "grok 1.0.41",
    });
    expect(dir).not.toBeNull();
    const files = fs.readdirSync(dir!);
    expect(files.sort()).toEqual(["error.txt", "meta.json", "transcript-raw.txt", "transcript.txt"]);
    const meta = JSON.parse(fs.readFileSync(path.join(dir!, "meta.json"), "utf8"));
    expect(meta).toMatchObject({
      provider: "grok",
      cliVersion: "grok 1.0.41",
      goldenCovered: true,
      diagnosticCode: "parse_error",
      attemptDurationMs: 14123,
      timeoutMs: 14000,
      checkpoint: "completion timeout",
      hasTranscript: true,
    });
    expect(meta.timings).toMatchObject({ input: 5010 });
    const raw = fs.readFileSync(path.join(dir!, "transcript-raw.txt"), "utf8");
    expect(raw).toContain("October5, 10:22");
    expect(raw).toContain("[email]");
    expect(raw).not.toContain("carlosboeing@gmail.com");
    const rendered = fs.readFileSync(path.join(dir!, "transcript.txt"), "utf8");
    expect(rendered).toContain("October5, 10:22");
    const errTxt = fs.readFileSync(path.join(dir!, "error.txt"), "utf8");
    expect(errTxt).toContain("bad resets timestamp");
  });

  it("writes meta-only bundles when no transcript exists", async () => {
    const dataDir = mkdir();
    const dir = await writeFailureBundle({
      dataDir,
      provider: "claude",
      attemptedAt: "2026-09-28T04:20:07.593Z",
      reason: new Error("timeout after 15000ms"),
      diagnosticCode: "timeout",
      summary: "Claude took too long to respond",
      errorDetail: "timed out",
    });
    expect(dir).not.toBeNull();
    const files = fs.readdirSync(dir!);
    expect(files.sort()).toEqual(["error.txt", "meta.json"]);
    const meta = JSON.parse(fs.readFileSync(path.join(dir!, "meta.json"), "utf8"));
    expect(meta.hasTranscript).toBe(false);
  });

  it(`prunes to ${BUNDLE_KEEP_PER_PROVIDER} bundles per provider`, async () => {
    const dataDir = mkdir();
    for (let i = 0; i < BUNDLE_KEEP_PER_PROVIDER + 3; i++) {
      await writeFailureBundle({
        dataDir,
        provider: "grok",
        attemptedAt: `2026-09-28T04:2${i}:07.593Z`,
        reason: new Error("x"),
        diagnosticCode: "timeout",
        summary: "s",
        errorDetail: "d",
      });
    }
    const kept = fs.readdirSync(path.join(dataDir, "failures")).filter((e) => e.startsWith("grok-"));
    expect(kept).toHaveLength(BUNDLE_KEEP_PER_PROVIDER);
  });

  it("never throws, returning null when the dir is unusable", async () => {
    const file = path.join(mkdir(), "blocker");
    fs.writeFileSync(file, "x");
    await expect(
      writeFailureBundle({
        dataDir: path.join(file, "nope"),
        provider: "grok",
        attemptedAt: "2026-09-28T04:20:07.593Z",
        reason: new Error("x"),
        diagnosticCode: "timeout",
        summary: "s",
        errorDetail: "d",
      }),
    ).resolves.toBeNull();
  });
});

describe("coordinator bundle wiring", () => {
  function failingPollFn(reason: unknown) {
    return async (enabled: string[]) => enabled.map((provider) => ({ provider, status: "rejected" as const, reason }));
  }

  it("writes a bundle on failure when enabled", async () => {
    const dataDir = mkdir();
    const db = openDb(":memory:");
    migrate(db);
    const err = new Error("test: bad resets timestamp");
    attachEvidence(err, { source: "pty", stdout: "Weekly 26%\n" });
    const coord = createCoordinator({
      db,
      enabledProviders: ["test-x"],
      pollFn: failingPollFn(err),
      dataDir,
      debugFailureBundles: true,
    });
    const r = await coord.refresh();
    expect(r.rejected).toHaveLength(1);
    const failuresDir = path.join(dataDir, "failures");
    const entries = fs.readdirSync(failuresDir).filter((e) => e.startsWith("test-x-"));
    expect(entries).toHaveLength(1);
    const raw = fs.readFileSync(path.join(failuresDir, entries[0], "transcript-raw.txt"), "utf8");
    expect(raw).toContain("Weekly 26%");
    db.close();
  });

  it("writes nothing when disabled", async () => {
    const dataDir = mkdir();
    const db = openDb(":memory:");
    migrate(db);
    const coord = createCoordinator({
      db,
      enabledProviders: ["test-x"],
      pollFn: failingPollFn(new Error("boom")),
    });
    await coord.refresh();
    expect(fs.existsSync(path.join(dataDir, "failures"))).toBe(false);
    db.close();
  });
});
