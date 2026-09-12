import { describe, it, expect } from "vitest";
import type { ProviderSnapshot } from "../../src/advisory/types.js";
import { stateWord } from "../../src/format/rows.js";
import { renderMarkdownTable, renderRecommendationSummary } from "../../src/format/markdown.js";
import { emptySnapshot } from "../../src/cli/snapshot-source.js";
import {
  FIXED_NOW,
  exampleStateSnapshot,
  unknownPaceStateSnapshot,
} from "../fixtures/stable-state.js";

describe("markdown table", () => {
  it("pins the example fixture exactly in recommended order", () => {
    expect(renderMarkdownTable(exampleStateSnapshot, FIXED_NOW)).toBe(
      [
        "| Provider | Used | Elapsed | Resets | State | Forecast |",
        "|---|---|---|---|---|---|",
        "| ★ my-plan | 12% | 50% | 7d | Behind pace | 76% waste in 7.0d |",
        "| Kimi | 22% | 50% | 7d | Behind pace | 56% waste in 7.0d |",
        "| Claude | 40% | 50% | 7d | Behind pace | 20% waste in 7.0d |",
        "| Codex | 40% | 50% | 7d (est.) | Behind pace | 20% estimated waste in 7.0d |",
        "| Antigravity | 50% | 0% | 7d | On track | Measuring pace; 50% remains with 7.0d until reset |",
        "| Antigravity 3P | 60% | 0% | 7d | Not reporting | stale 3h ago |",
        "| Grok | 30% | — | — | Not reporting | invalid reading |",
        "| Manual | — | — | — | Not reporting | no readings yet |",
      ].join("\n"),
    );
  });

  it("shares STATE words with the terminal row model for every provider", () => {
    const out = renderMarkdownTable(exampleStateSnapshot, FIXED_NOW);
    for (const p of exampleStateSnapshot.providers) {
      expect(out).toContain(`| ${stateWord(p)} |`);
    }
  });

  it("shows no numeric rate or predicted waste for unknown pace", () => {
    const kimi = unknownPaceStateSnapshot.providers.find((p) => p.id === "kimi")!;
    const out = renderMarkdownTable(unknownPaceStateSnapshot, FIXED_NOW);
    const line = out.split("\n").find((l) => l.includes("| Kimi |"))!;
    expect(line).toContain("Measuring pace;");
    expect(line).not.toMatch(/waste/i);
    expect(line).not.toMatch(/%\/day/);
    expect(kimi.advisory?.paceSource).toBe("unknown");
  });

  it("escapes pipes and newlines in provider ids", () => {
    const p = exampleStateSnapshot.providers.find((x) => x.id === "kimi")!;
    const weird: ProviderSnapshot = { ...p, id: "a|b\nc", displayName: "a|b\nc" };
    const out = renderMarkdownTable({ ...exampleStateSnapshot, providers: [weird] }, FIXED_NOW);
    expect(out).toContain("| a\\|b c |");
    expect(out).not.toContain("a|b");
  });
});

describe("recommendation summary", () => {
  it("names use and reason like advise", () => {
    expect(renderRecommendationSummary(exampleStateSnapshot)).toBe("my-plan: 76% waste in 7.0d");
    expect(renderRecommendationSummary(emptySnapshot(FIXED_NOW))).toBe("none: no quotas yet");
  });
});
