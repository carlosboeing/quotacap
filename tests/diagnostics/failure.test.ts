import { describe, expect, it } from "vitest";
import {
  classifyFailure,
  diagnosticError,
  formatProviderName,
  DiagnosticError,
  type DiagnosticCode,
} from "../../src/diagnostics/failure.js";

describe("diagnostic boundary and failure classification", () => {
  it("preserves the specific cause inside a process exit", () => {
    const error = diagnosticError(new Error("pty exited during settle (code 1)"), {
      source: "pty",
      checkpoint: "during settle",
      exitCode: 1,
      stderr: "Error: unauthorized token=private-value",
    });
    const failure = classifyFailure("codex", error);
    expect(failure).toMatchObject({ diagnosticCode: "auth", category: "auth" });
    expect(failure.errorDetail).toContain("code 1");
    expect(failure.errorDetail).toContain("unauthorized");
    expect(JSON.stringify({ error, failure })).not.toContain("private-value");
    expect(error.message).not.toContain("private-value");
  });

  it("does not call a bare PTY exit a terminal defect", () => {
    const failure = classifyFailure("grok", new Error("pty exited during settle (code 0)"));
    expect(failure.diagnosticCode).toBe("unknown");
    expect(failure.errorDetail).toContain("code 0");
    expect(failure.errorDetail).toContain("Unrecognized diagnostic text omitted");
    expect(failure.category).toBe("unknown");
  });

  it("formats registered and unknown provider display names", () => {
    expect(formatProviderName("claude")).toBe("Claude");
    expect(formatProviderName("codex")).toBe("Codex");
    expect(formatProviderName("grok")).toBe("Grok");
    expect(formatProviderName("kimi")).toBe("Kimi");
    expect(formatProviderName("agy")).toBe("Antigravity");
    expect(formatProviderName("agy:3p")).toBe("Antigravity (3rd-party)");
    expect(formatProviderName("muse")).toBe("Muse");
    expect(formatProviderName("all")).toBe("QuotaCap service");
    expect(formatProviderName("unknown-provider")).toBe("Provider");
  });

  describe("complete precedence matrix", () => {
    it("Order 1: timeout (structured AbortError)", () => {
      const abortErr = new Error("This operation was aborted");
      abortErr.name = "AbortError";
      const failure = classifyFailure("claude", abortErr);
      expect(failure.diagnosticCode).toBe("timeout");
      expect(failure.category).toBe("timeout");
      expect(failure.summary).toBe("Claude took too long to respond");
    });

    it("Order 1: timeout takes precedence over login help on screen", () => {
      const abortErr = new Error("operation timed out");
      abortErr.name = "AbortError";
      const error = diagnosticError(abortErr, {
        source: "pty",
        checkpoint: "abort",
        stdout: "Welcome to Claude! Please run claude login to continue.",
      });
      const failure = classifyFailure("claude", error);
      expect(failure.diagnosticCode).toBe("timeout");
      expect(failure.category).toBe("timeout");
    });

    it("Order 1: timeout QuotaCap checkpoint (ready timeout / completion timeout)", () => {
      const err = diagnosticError(new Error("pty ready timeout after 6000ms"), {
        source: "pty",
        checkpoint: "ready timeout",
        durationMs: 6000,
      });
      const failure = classifyFailure("kimi", err);
      expect(failure.diagnosticCode).toBe("timeout");
      expect(failure.category).toBe("timeout");
      expect(failure.errorDetail).toContain("ready timeout");
    });

    it("Order 2: command_not_found (ENOENT / command not found / is not recognized)", () => {
      const enoent = new Error("spawn /opt/bin/codex ENOENT");
      (enoent as any).code = "ENOENT";
      const f1 = classifyFailure("codex", enoent);
      expect(f1.diagnosticCode).toBe("command_not_found");
      expect(f1.category).toBe("unknown");
      expect(f1.summary).toBe("Codex not found");

      const f2 = classifyFailure("codex", new Error("/bin/sh: codex: command not found"));
      expect(f2.diagnosticCode).toBe("command_not_found");

      const f3 = classifyFailure("codex", new Error("'codex' is not recognized as an internal or external command"));
      expect(f3.diagnosticCode).toBe("command_not_found");

      // Bare "not found" is insufficient!
      const f4 = classifyFailure("codex", new Error("file not found in search"));
      expect(f4.diagnosticCode).toBe("unknown");
    });

    it("Order 3: terminal_error (all listed phrases)", () => {
      const phrases = [
        "stdin is not a terminal",
        "device not configured",
        "not a tty",
        "inappropriate ioctl",
        "Bun runtime lacks terminal (PTY) support",
        "node-pty not available",
      ];
      for (const phrase of phrases) {
        const failure = classifyFailure("grok", new Error(`failure: ${phrase}`));
        expect(failure.diagnosticCode).toBe("terminal_error");
        expect(failure.category).toBe("unknown");
        expect(failure.summary).toBe("Unable to open Grok session");
        expect(failure.action).toContain("Open Grok directly in your terminal");
      }
    });

    it("Order 4: trust_prompt (untrusted workspace / trust prompt / trust this folder)", () => {
      for (const phrase of ["untrusted workspace", "trust prompt", "trust this folder"]) {
        const failure = classifyFailure("agy", new Error(`detected ${phrase}`));
        expect(failure.diagnosticCode).toBe("trust_prompt");
        expect(failure.category).toBe("unknown");
        expect(failure.summary).toBe("Antigravity security prompt pending");
        expect(failure.action).toContain("review the folder approval prompt");
      }
    });

    it("Order 5: rate_limit (rate limit / too many requests / quota exceeded / HTTP 429)", () => {
      for (const phrase of [
        "rate limit exceeded",
        "rate_limit reached",
        "too many requests",
        "quota exceeded",
        "status: 429",
        "HTTP 429",
      ]) {
        const failure = classifyFailure("kimi", new Error(`api error: ${phrase}`));
        expect(failure.diagnosticCode).toBe("rate_limit");
        expect(failure.category).toBe("unknown");
        expect(failure.summary).toBe("Kimi rate limited");
      }

      // Wrapper rate limit inside pty exit
      const wrapperError = diagnosticError(new Error("pty exited during settle (code 1)"), {
        source: "pty",
        checkpoint: "during settle",
        exitCode: 1,
        stderr: "Too Many Requests",
      });
      const fWrapper = classifyFailure("kimi", wrapperError);
      expect(fWrapper.diagnosticCode).toBe("rate_limit");

      // Bare number 429 is insufficient!
      const bare429 = classifyFailure("kimi", new Error("processed item 429 with error"));
      expect(bare429.diagnosticCode).toBe("unknown");
    });

    it("Order 6: auth (unauthorized / login required / run <provider> login / credentials)", () => {
      const cases = [
        { text: "login required", expected: "auth" },
        { text: "user is not logged in", expected: "auth" },
        { text: "session logged out", expected: "auth" },
        { text: "HTTP 401 unauthorized", expected: "auth" },
        { text: "HTTP 401 unauthorised", expected: "auth" },
        { text: "403 forbidden", expected: "auth" },
        { text: "run codex login to continue", expected: "auth" },
        { text: "credential not found", expected: "auth" },
        { text: "missing credentials in keychain", expected: "auth" },
        { text: "invalid credentials provided", expected: "auth" },
        { text: "expired credentials", expected: "auth" },
        { text: "missing api key", expected: "auth" },
        { text: "authentication failed", expected: "auth" },
        { text: "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.", expected: "auth" },
        { text: "refresh token was already used", expected: "auth" },
        { text: "Please log out and sign in again", expected: "auth" },
      ];
      for (const { text, expected } of cases) {
        const failure = classifyFailure("codex", new Error(text));
        expect(failure.diagnosticCode).toBe(expected);
        expect(failure.category).toBe("auth");
        expect(failure.summary).toBe("Codex needs you to confirm the subscription account");
        expect(failure.action).toBe(
          "Open Codex, complete the browser sign-in it shows, then select Refresh in the QuotaCap dashboard.",
        );
      }
    });

    it("classifies vendor account-confirmation text as auth and drops the browser link", () => {
      const agy = classifyFailure(
        "agy",
        new Error(
          "Eligibility check failed: Your current account is not eligible for Antigravity. Verify your account to continue. Alternatively, try signing in with another personal Google account. https://accounts.google.com/signin/continue?plt=SECRETTOKEN",
        ),
      );
      expect(agy.diagnosticCode).toBe("auth");
      expect(agy.category).toBe("auth");
      expect(agy.summary).toBe("Antigravity needs you to confirm the subscription account");
      expect(agy.errorDetail).toBe("login required");
      expect(JSON.stringify(agy)).not.toContain("SECRETTOKEN");
      expect(JSON.stringify(agy)).not.toContain("accounts.google.com");

      const codex = classifyFailure(
        "codex",
        diagnosticError(new Error("pty completion timeout after 12000ms"), {
          source: "pty",
          checkpoint: "completion timeout",
          durationMs: 12000,
          stdout:
            "starting\nSign in with Device Code\nhttps://auth.openai.com/oauth/authorize?code_challenge=SECRETVALUE\n",
        }),
      );
      expect(codex.diagnosticCode).toBe("auth");
      expect(codex.summary).toBe("Codex needs you to confirm the subscription account");
      expect(codex.errorDetail).toContain("login required");
      expect(JSON.stringify(codex)).not.toContain("SECRETVALUE");
      expect(JSON.stringify(codex)).not.toContain("auth.openai.com");

      const stillTimeout = classifyFailure(
        "codex",
        diagnosticError(new Error("pty completion timeout after 12000ms"), {
          source: "pty",
          checkpoint: "completion timeout",
          durationMs: 12000,
          stdout: "starting up\nloading models\n",
        }),
      );
      expect(stillTimeout.diagnosticCode).toBe("timeout");
    });

    it("Order 7: network (ENOTFOUND / ECONNREFUSED / ETIMEDOUT / EAI_AGAIN / fetch failed)", () => {
      for (const phrase of ["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "fetch failed"]) {
        const failure = classifyFailure("claude", new Error(`network error ${phrase}`));
        expect(failure.diagnosticCode).toBe("network");
        expect(failure.category).toBe("network");
        expect(failure.summary).toBe("Connection failed");
        expect(failure.action).toContain("QuotaCap could not reach the network");
      }
    });

    it("Order 8: parse_error (SyntaxError / bad resets timestamp / bad timestamp / invalid date)", () => {
      const syntaxErr = new SyntaxError("Unexpected token < in JSON at position 0");
      const f1 = classifyFailure("grok", syntaxErr);
      expect(f1.diagnosticCode).toBe("parse_error");
      expect(f1.category).toBe("parse");
      expect(f1.summary).toBe("Unable to read Grok usage");

      for (const phrase of ["bad resets timestamp: September 99,99:99", "bad timestamp", "invalid date"]) {
        const failure = classifyFailure("grok", new Error(phrase));
        expect(failure.diagnosticCode).toBe("parse_error");
        expect(failure.category).toBe("parse");
      }
    });

    it("Order 8: parse_error (adapter parse vocabulary)", () => {
      const cases: Array<[string, string, string]> = [
        ["codex", "codex: weekly limit not found in TUI output", "weekly limit not found"],
        ["codex", "codex: 5h limit not found in TUI output", "5h limit not found"],
        ["grok", "grok: weekly percent not found in TUI output", "weekly percent not found"],
        ["muse", "muse: weekly usage not found in TUI output", "weekly usage not found"],
        ["muse", "muse: current-window usage not found in TUI output", "current-window usage not found"],
        ["codex", "codex: bad weekly pct", "bad weekly pct"],
        ["kimi", "kimi: bad 5h pct", "bad 5h pct"],
        ["muse", "muse: bad current pct", "bad current pct"],
        ["muse", "muse: bad weekly reset", "bad weekly reset"],
        ["codex", 'codex: bad 5h reset "02:43 on 15 Sep"', "bad 5h reset"],
        ["agy", "agy: bad weekly reset_time", "bad weekly reset_time"],
        ["agy", "agy: status is not SUCCESS", "status is not SUCCESS"],
        ["agy", "agy: no usage groups", "no usage groups"],
        ["agy", "agy: no weekly bucket", "no weekly bucket"],
      ];
      for (const [provider, message, phrase] of cases) {
        const failure = classifyFailure(provider, new Error(message));
        expect(failure.diagnosticCode).toBe("parse_error");
        expect(failure.category).toBe("parse");
        // Canonical phrase only: the quoted variable suffix is never echoed.
        expect(failure.errorDetail).toBe(phrase);
      }
      const failure = classifyFailure("codex", new Error('codex: bad 5h reset "02:43 on 15 Sep"'));
      expect(failure.summary).toBe("Unable to read Codex usage");
      expect(failure.action).toContain("Check for a QuotaCap update");
    });

    it("classifies opencode-go fixed phrases as parse_error", () => {
      for (const msg of [
        "opencode-go: rolling usage not found",
        "opencode-go: bad rolling pct",
        "opencode-go: usage status not ok",
        "opencode-go: bad monthly pct",
        "opencode-go: bad monthly reset",
        "opencode-go: unknown monthly status",
      ]) {
        const f = classifyFailure("opencode-go", new Error(msg));
        expect(f.diagnosticCode).toBe("parse_error");
        expect(f.category).toBe("parse");
      }
    });

    it("Order 8b: service_unavailable (subscription/service currently unavailable)", () => {
      const f1 = classifyFailure("muse", new Error("muse: subscription currently unavailable"));
      expect(f1.diagnosticCode).toBe("service_unavailable");
      expect(f1.category).toBe("unknown");
      expect(f1.summary).toBe("Muse usage currently unavailable");
      expect(f1.errorDetail).toBe("subscription currently unavailable");
      expect(f1.action).toContain("QuotaCap already retried automatically with a warm-up prompt");

      const f2 = classifyFailure("muse", new Error("subscription currently unavailable in TUI output"));
      expect(f2.diagnosticCode).toBe("service_unavailable");
      expect(f2.errorDetail).toBe("subscription currently unavailable");

      const f3 = classifyFailure("codex", new Error("codex: limits refresh requested, run /status again shortly"));
      expect(f3.diagnosticCode).toBe("service_unavailable");
      expect(f3.summary).toBe("Codex usage currently unavailable");
      expect(f3.action).toContain("Send a prompt in Codex to refresh its session limits");
    });

    it("Order 9: timeout (remaining explicit timeout / timed out)", () => {
      const f1 = classifyFailure("kimi", new Error("request timed out after 5000ms"));
      expect(f1.diagnosticCode).toBe("timeout");
      expect(f1.category).toBe("timeout");

      const f2 = classifyFailure("kimi", new Error("gateway timeout"));
      expect(f2.diagnosticCode).toBe("timeout");
      expect(f2.category).toBe("timeout");
    });

    it("Order 10: unknown (bare wrappers and unrecognized errors)", () => {
      const f1 = classifyFailure("agy", new Error("something went wrong"));
      expect(f1.diagnosticCode).toBe("unknown");
      expect(f1.category).toBe("unknown");
      expect(f1.summary).toBe("Antigravity stopped unexpectedly");
      expect(f1.action).toContain("Inspect the configured QuotaCap service log");

      const f2 = classifyFailure("agy:3p", new Error("pty exited (code 0)"));
      expect(f2.diagnosticCode).toBe("unknown");
      expect(f2.summary).toBe("Antigravity (3rd-party) stopped unexpectedly");
    });
  });

  describe("sanitization and secret leakage prevention", () => {
    it("strips ANSI and OSC escape sequences from detail", () => {
      const raw = "\x1b[31mError:\x1b[0m \x1b]0;terminal title\x07stdin is not a terminal";
      const err = diagnosticError(new Error(raw));
      expect(err.diagnostic.errorDetail).not.toContain("\x1b");
      expect(err.diagnostic.errorDetail).toContain("stdin is not a terminal");
    });

    it("normalizes carriage returns and whitespace to single-line", () => {
      const raw = "pty exited during settle (code 1)\r\nline2\rline3";
      const err = diagnosticError(new Error(raw));
      expect(err.diagnostic.errorDetail).not.toContain("\r");
      expect(err.diagnostic.errorDetail).not.toContain("\n");
    });

    it("does not leak URLs, file paths, emails, credentials, or command args", () => {
      const raw = "authentication failed: url=https://user:secret@api.anthropic.com/v1/auth path=/private/secret/path email=carlos@example.com token=sk-ant-api03-abcdefg";
      const err = diagnosticError(new Error(raw));
      const failure = classifyFailure("claude", err);

      const combined = JSON.stringify({ err, failure, message: err.message });
      expect(combined).not.toContain("secret@");
      expect(combined).not.toContain("/private/secret/path");
      expect(combined).not.toContain("carlos@example.com");
      expect(combined).not.toContain("sk-ant-api03-abcdefg");
      expect(err.diagnostic.errorDetail).toBe("authentication failed");
    });

    it("enforces 300-character maximum on errorDetail", () => {
      const longInput = "a".repeat(500);
      const err = diagnosticError(new Error(longInput));
      expect(err.diagnostic.errorDetail.length).toBeLessThanOrEqual(300);
    });

    it("appends omission sentence for unrecognized text when metadata is present", () => {
      const err = diagnosticError(new Error("pty exited during settle (code 42)"), {
        source: "pty",
        checkpoint: "during settle",
        exitCode: 42,
      });
      expect(err.diagnostic.errorDetail).toBe("pty exited during settle (code 42): Unrecognized diagnostic text omitted");
    });

    it("emits omission sentence as complete detail when metadata is absent and text unrecognized", () => {
      const err = diagnosticError(new Error("completely unknown error message"));
      expect(err.diagnostic.errorDetail).toBe("Unrecognized diagnostic text omitted");
    });

    it("handles non-Error rejection values safely", () => {
      const f1 = classifyFailure("codex", "string rejection");
      expect(f1.diagnosticCode).toBe("unknown");
      expect(f1.errorDetail).toBe("Unrecognized diagnostic text omitted");

      const f2 = classifyFailure("codex", { some: "object", with: "properties" });
      expect(f2.diagnosticCode).toBe("unknown");
      expect(f2.errorDetail).toBe("Unrecognized diagnostic text omitted");

      const f3 = classifyFailure("codex", null);
      expect(f3.diagnosticCode).toBe("unknown");
      expect(f3.errorDetail).toBe("Unrecognized diagnostic text omitted");
    });

    it("does not attach raw cause, stderr, or original stack to DiagnosticError", () => {
      const orig = new Error("orig message with secret=xyz");
      orig.stack = "Error: at /secret/path/foo.js:10:20";
      const err = diagnosticError(orig, {
        source: "exec",
        stderr: "fatal: private stderr data",
      });
      expect((err as any).cause).toBeUndefined();
      expect((err as any).stderr).toBeUndefined();
      expect(JSON.stringify(err)).not.toContain("secret=xyz");
      expect(JSON.stringify(err)).not.toContain("private stderr data");
      expect(JSON.stringify(err)).not.toContain("/secret/path");
    });

    it("generic DiagnosticError retains already classified diagnosticCode from abort", () => {
      const abortErr = new Error("aborted");
      abortErr.name = "AbortError";
      const err = diagnosticError(abortErr);
      expect(err.diagnostic.diagnosticCode).toBe("timeout");
      // Re-wrapping DiagnosticError returns original instance unchanged, preventing prefix doubling
      const err2 = diagnosticError(err);
      expect(err2).toBe(err);
      expect(err2.diagnostic.diagnosticCode).toBe("timeout");

      const errWithEvidence = diagnosticError(err, { source: "pty", checkpoint: "during settle", exitCode: 1 });
      expect(errWithEvidence).toBe(err);
      expect(errWithEvidence.diagnostic.errorDetail).toBe(err.diagnostic.errorDetail);
    });

    it("rejects plain object pretending to be DiagnosticError", () => {
      const fake = {
        diagnostic: {
          diagnosticCode: "terminal_error",
          errorDetail: "fake injected detail with secret=123",
        },
      };
      const failure = classifyFailure("codex", fake);
      expect(failure.errorDetail).not.toContain("fake injected detail");
    });
  });
});
