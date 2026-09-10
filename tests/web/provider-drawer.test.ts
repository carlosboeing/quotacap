import fs from "node:fs";
import React from "react";
import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { exampleStateSnapshotJson, unknownPaceStateSnapshotJson } from "../fixtures/stable-state.js";
import { toViewModel } from "../../web/src/state.js";
import {
  compactSnapshot,
  drawerModel,
  paceBasis,
  rankingCopy,
  sourceLabel,
} from "../../web/src/components/ProviderDrawer.js";
import { ProviderDrawer } from "../../web/src/components/ProviderDrawer.js";

describe("provider drawer", () => {
  it("exposes server fields without synthesis", () => {
    const s = JSON.parse(exampleStateSnapshotJson);
    const m = drawerModel(s.providers.find((p: any) => p.id === "codex"));
    expect(m.estimatedReset).toBe(true);
    expect(m.evidence).toContain("estimated-reset");
    expect(m.sessionReset).toBeUndefined(); // never synthesized
  });
  it("marks unknown pace and exclusion reasons in plain words", () => {
    const s = JSON.parse(exampleStateSnapshotJson);
    const invalid = drawerModel(s.providers.find((p: any) => p.id === "grok"));
    expect(invalid.exclusionReason).toBe("invalid");
    expect(invalid.exclusionWords).toMatch(/invalid/i);
    expect(invalid.burnRate).toBeNull();
    const u = JSON.parse(unknownPaceStateSnapshotJson);
    const kimi = drawerModel(u.providers.find((p: any) => p.id === "kimi"));
    expect(kimi.paceSource).toBe("unknown");
    expect(kimi.burnRate).toBeNull();
    expect(kimi.wastePct).toBeNull();
  });
  it("labels adapter source without inventing credential paths", () => {
    expect(sourceLabel("cli")).toBe("Live CLI");
    expect(sourceLabel("tui")).toBe("Live TUI");
    expect(sourceLabel("manual")).toBe("Manual ingest");
  });
  it("renders the concept drawer sections from snapshot fields", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const kimi = s.providers.find((p) => p.id === "kimi")!;
    expect(paceBasis(kimi, Date.parse(s.asOf))).toMatch(/averaged over|Window avg|Measured/);
    const why = rankingCopy(kimi, s.recommendation);
    expect(why.known).toMatch(/Kimi reports 22%/);
    expect(why.pace).toMatch(/%\/day/);
    const html = renderToString(
      React.createElement(ProviderDrawer, {
        provider: kimi,
        asOf: s.asOf,
        recommendation: s.recommendation,
        onClose: () => {},
      })
    );
    expect(html).toContain("Current window");
    expect(html).toContain("Adapter and provenance");
    expect(html).toContain("Ranking rationale");
    expect(html).toMatch(/averaged over|Window avg|Measured/);
    expect(html).toContain("Live CLI");
    expect(html).toContain("Credential");
    expect(html).toContain("handled by Kimi");
    expect(html).not.toContain("kimi-code.json");
    expect(html).not.toContain("Burn rate");
    const snap = compactSnapshot(kimi, Date.parse(s.asOf));
    expect(snap.provider).toBe("kimi");
    expect(snap.source).toBe("cli");
    expect(snap.pacingStatus).toMatch(/behind|ontrack|ahead|cap|out/);
  });
  it("matches concept JSON snapshot type and does not clip the block", () => {
    const css = fs.readFileSync("web/src/theme.css", "utf8");
    expect(css).toMatch(/\.draw-code \{[^}]*font-size: var\(--t-2\)/);
    expect(css).toMatch(/\.draw-code \{[^}]*line-height: 1\.6/);
    expect(css).toMatch(/\.draw-code \{[^}]*white-space: pre;/);
    expect(css).not.toMatch(/\.draw-code \{[^}]*max-height:/);
  });
});
