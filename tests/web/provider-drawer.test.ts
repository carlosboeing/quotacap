import { describe, it, expect } from "vitest";
import { exampleStateSnapshotJson, unknownPaceStateSnapshotJson } from "../fixtures/stable-state.js";
import { drawerModel } from "../../web/src/components/ProviderDrawer.js";

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
});
