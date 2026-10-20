import fs from "node:fs";
import React from "react";
import { renderToString } from "react-dom/server";
import { describe, it, expect, vi } from "vitest";
import { exampleStateSnapshotJson, monthlyStateSnapshotJson } from "../fixtures/stable-state.js";
import { AdviceDrawer } from "../../web/src/components/AdviceDrawer.js";
import { CopyButton } from "../../web/src/components/CopyButton.js";
import { toViewModel } from "../../web/src/state.js";

describe("advice drawer", () => {
  it("renders the prototype advice panel from snapshot fields", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const html = renderToString(
      React.createElement(AdviceDrawer, {
        open: true,
        recommendation: s.recommendation,
        providers: s.providers,
        asOf: s.asOf,
        onClose: () => {},
      })
    );
    expect(html).toContain("advice-drawer");
    expect(html).toContain("Quota Advice");
    expect(html).toContain("Recommended for next session");
    expect(html).toContain("Fleet Pacing Breakdown");
    expect(html).toContain("quotacap advise");
    expect(html).toContain(String(Math.round(s.recommendation.wastePct as number)));
    expect(html).not.toContain("predicted waste");
  });
  it("matches the concept recommended-badge and rec-picon metrics", () => {
    const css = fs.readFileSync("web/src/theme.css", "utf8");
    expect(css).toMatch(/\.recommended-badge \{[^}]*gap: 6px/);
    expect(css).toMatch(/\.recommended-badge \{[^}]*padding: 3\.5px 10px/);
    expect(css).not.toMatch(/\.recommended-badge \{[^}]*font-family: var\(--font-mono\)/);
    expect(css).toMatch(/\.rec-picon svg \{[^}]*width: 18px/);
    expect(css).toMatch(/\.drawer-close \{[^}]*color: var\(--ink\)/);
  });

  it("renders nothing when closed", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const html = renderToString(
      React.createElement(AdviceDrawer, {
        open: false,
        recommendation: s.recommendation,
        providers: s.providers,
        asOf: s.asOf,
        onClose: () => {},
      })
    );
    expect(html).toBe("");
  });

  it("a monthly-bound pick reads its reason, never the weekly expiry", () => {
    const s = toViewModel(JSON.parse(monthlyStateSnapshotJson));
    const html = renderToString(
      React.createElement(AdviceDrawer, {
        open: true, recommendation: s.recommendation, providers: s.providers, asOf: s.asOf, onClose: () => {},
      })
    ).replace(/<!-- -->/g, "");
    expect(html).toContain("5% of month left in 8.7d");
    expect(html).not.toContain("unused quota expires in");
  });

  it("uses the trimmed subtitle, one-sentence pick body, and prose stats with mono figures", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const pick = s.providers.find((p) => p.id === s.recommendation.use)!;
    const html = renderToString(
      React.createElement(AdviceDrawer, {
        open: true,
        recommendation: s.recommendation,
        providers: s.providers,
        asOf: s.asOf,
        onClose: () => {},
        onSelectProvider: () => {},
      })
    ).replace(/<!-- -->/g, "");
    expect(html).toContain("Which quota to burn next, and why");
    // Stats line is prose; figures are wrapped in <b> (mono via CSS).
    expect(html).toContain("unused quota expires in");
    // One sentence: remaining + time to reset + pace basis, no second filler sentence.
    expect(html).toContain(
      `has ${Math.round(pick.advisory!.remaining)}% quota remaining with 7d 0h to reset, forecast at the window-average pace.`
    );
    expect(html).not.toContain("Using this subscription now avoids");
    expect(html).not.toContain("Equivalent terminal command:");
    const css = fs.readFileSync("web/src/theme.css", "utf8");
    expect(css).toMatch(/\.advice-card-stats \{[^}]*font-size: var\(--t-2\)/);
    expect(css).not.toMatch(/\.advice-card-stats \{[^}]*font-family: var\(--font-mono\)/);
    expect(css).toMatch(/\.advice-card-stats b \{[^}]*font-family: var\(--font-mono\)/);
  });

  it("renders fleet breakdown as lane-group rows with lane-language labels and pressure/opportunity metas", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const html = renderToString(
      React.createElement(AdviceDrawer, {
        open: true,
        recommendation: s.recommendation,
        providers: s.providers,
        asOf: s.asOf,
        onClose: () => {},
        onSelectProvider: () => {},
      })
    ).replace(/<!-- -->/g, "");
    expect(html).toContain("lane-group");
    expect(html).toContain("lane-row");
    expect(html).toContain("↑");
    expect(html).toContain("Use more");
    expect(html).toContain("↓");
    expect(html).toContain("Ease off");
    // Use-more metas lead with unused % and reset (Kimi 56% waste in the fixture).
    expect(html).toContain("56% unused · resets in 7d 0h");
    const css = fs.readFileSync("web/src/theme.css", "utf8");
    expect(css).toMatch(/\.lane-group dt\.um \{[^}]*color: var\(--warn\)/);
    expect(css).toMatch(/\.lane-group dt\.eo \{[^}]*color: var\(--danger\)/);
    expect(css).toMatch(/\.lane-row \{/);
    expect(css).toMatch(/@media \(max-width: 430px\)[\s\S]*\.lane-row \.meta \{ font-size: var\(--t-1\)/);
  });

  it("shows the View {name} details cross-link and a CLI copy button; App wires it to swap drawers", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const pick = s.providers.find((p) => p.id === s.recommendation.use)!;
    const onSelectProvider = vi.fn();
    const html = renderToString(
      React.createElement(AdviceDrawer, {
        open: true,
        recommendation: s.recommendation,
        providers: s.providers,
        asOf: s.asOf,
        onClose: () => {},
        onSelectProvider,
      })
    ).replace(/<!-- -->/g, "");
    expect(html).toContain(`View ${pick.displayName} details`);
    expect(html).toContain("goto-link");
    expect(html).toContain("cli-wrap");
    expect(html).toContain(">Copy<");
    expect(html).toContain('aria-live="polite"');
    // App must close advice and open the provider (the inverse of the advice opener).
    const app = fs.readFileSync("web/src/App.tsx", "utf8");
    expect(app).toMatch(/<AdviceDrawer[\s\S]*onSelectProvider=\{\(id\) => \{\s*setAdviceOpen\(false\);\s*setSelectedProvider\(id\);/);
    // Recommendation tooltip now names the advice drawer, not a provider.
    const rec = fs.readFileSync("web/src/components/Recommendation.tsx", "utf8");
    expect(rec).toContain('title="Open quota advice"');
    expect(rec).not.toContain("Open recommended provider");
  });

  it("CopyButton renders a Copy button with a polite live region", () => {
    const html = renderToString(React.createElement(CopyButton, { text: "quotacap advise" }));
    expect(html).toContain(">Copy<");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="status"');
  });
});
