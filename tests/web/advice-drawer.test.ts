import fs from "node:fs";
import React from "react";
import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { exampleStateSnapshotJson } from "../fixtures/stable-state.js";
import { AdviceDrawer } from "../../web/src/components/AdviceDrawer.js";
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
});
