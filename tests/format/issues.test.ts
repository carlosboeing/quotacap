import { describe, it, expect } from "vitest";
import type { ProviderSnapshot, StateSnapshot } from "../../src/advisory/types.js";
import { renderIssues } from "../../src/format/issues.js";
import { FIXED_NOW, RT } from "../fixtures/stable-state.js";

function makeSnapshot(providers: Partial<ProviderSnapshot>[]): StateSnapshot {
  return {
    asOf: FIXED_NOW.toISOString(),
    runtime: RT,
    providers: providers.map((p) => ({
      id: "unknown",
      enabled: true,
      reporting: true,
      quota: null,
      advisory: null,
      evidence: [],
      exclusionReason: null,
      lastSuccessAt: null,
      stale: false,
      resetPassed: false,
      ageMs: null,
      lastAttempt: null,
      ...p,
    })),
    recommendation: {
      use: "none",
      reason: "no providers",
      wastePct: null,
      idealRate: 0,
      recommendationBasis: "none",
      alternatives: [],
      advisories: [],
    },
  };
}

describe("renderIssues", () => {
  it("returns empty string when there are no issues", () => {
    const snapshot = makeSnapshot([
      {
        id: "claude",
        enabled: true,
        reporting: true,
        lastAttempt: {
          provider: "claude",
          attemptedAt: FIXED_NOW.toISOString(),
          completedAt: FIXED_NOW.toISOString(),
          succeededAt: FIXED_NOW.toISOString(),
          success: true,
          failureCategory: null,
        },
      },
    ]);
    expect(renderIssues(snapshot, false)).toBe("");
    expect(renderIssues(snapshot, true)).toBe("");
  });

  it("renders bullet issues with summary, action, and detail in non-ASCII mode", () => {
    const snapshot = makeSnapshot([
      {
        id: "codex",
        enabled: true,
        reporting: false,
        exclusionReason: "provider-failed",
        lastAttempt: {
          provider: "codex",
          attemptedAt: FIXED_NOW.toISOString(),
          completedAt: FIXED_NOW.toISOString(),
          succeededAt: null,
          success: false,
          failureCategory: "unknown",
          diagnosticCode: "terminal_error",
          summary: "Unable to open Codex session",
          action: "Open Codex directly in your terminal to check whether it starts.",
          errorDetail: "pty exited during settle (code 1): stdin is not a terminal",
        },
      },
    ]);

    const out = renderIssues(snapshot, false);
    expect(out).toBe(
      [
        "Adapter issues:",
        "• codex: Unable to open Codex session",
        "  Action: Open Codex directly in your terminal to check whether it starts.",
        "  Detail: pty exited during settle (code 1): stdin is not a terminal",
      ].join("\n"),
    );
  });

  it("renders hyphen marker in ASCII mode", () => {
    const snapshot = makeSnapshot([
      {
        id: "codex",
        enabled: true,
        reporting: false,
        exclusionReason: "provider-failed",
        lastAttempt: {
          provider: "codex",
          attemptedAt: FIXED_NOW.toISOString(),
          completedAt: FIXED_NOW.toISOString(),
          succeededAt: null,
          success: false,
          failureCategory: "unknown",
          diagnosticCode: "terminal_error",
          summary: "Unable to open Codex session",
          action: "Open Codex directly in your terminal.",
          errorDetail: "pty exited during settle (code 1): stdin is not a terminal",
        },
      },
    ]);

    const out = renderIssues(snapshot, true);
    expect(out).toBe(
      [
        "Adapter issues:",
        "- codex: Unable to open Codex session",
        "  Action: Open Codex directly in your terminal.",
        "  Detail: pty exited during settle (code 1): stdin is not a terminal",
      ].join("\n"),
    );
  });

  it("handles legacy failed attempts with category fallback and missing-detail text, omitting Action", () => {
    const snapshot = makeSnapshot([
      {
        id: "kimi",
        enabled: true,
        reporting: false,
        exclusionReason: "provider-failed",
        lastAttempt: {
          provider: "kimi",
          attemptedAt: FIXED_NOW.toISOString(),
          completedAt: FIXED_NOW.toISOString(),
          succeededAt: null,
          success: false,
          failureCategory: "parse",
        },
      },
    ]);

    const out = renderIssues(snapshot, false);
    expect(out).toBe(
      [
        "Adapter issues:",
        "• kimi: provider failed (parse)",
        "  Detail: No diagnostic detail was recorded for this attempt.",
      ].join("\n"),
    );
  });

  it("ignores disabled failed providers", () => {
    const snapshot = makeSnapshot([
      {
        id: "codex",
        enabled: false,
        reporting: false,
        exclusionReason: "provider-failed",
        lastAttempt: {
          provider: "codex",
          attemptedAt: FIXED_NOW.toISOString(),
          completedAt: FIXED_NOW.toISOString(),
          succeededAt: null,
          success: false,
          failureCategory: "auth",
          summary: "Login required",
        },
      },
    ]);

    expect(renderIssues(snapshot, false)).toBe("");
  });
});
