import { describe, it, expect } from "vitest";
import { exampleStateSnapshotJson } from "../fixtures/stable-state.js";
import {
  adapterProviders,
  connectionBadge,
  connectionName,
  providerStatus,
} from "../../web/src/components/settings/ProvidersPanel.js";

describe("settings", () => {
  it("lists CLI adapters only, omitting manual ingest ids", () => {
    const s = JSON.parse(exampleStateSnapshotJson);
    const ids = adapterProviders(s.providers).map((p: { id: string }) => p.id);
    expect(ids).toContain("kimi");
    expect(ids).toContain("agy:3p");
    expect(ids).not.toContain("manual");
    expect(ids).not.toContain("my-plan");
    expect(ids).not.toContain("test");
  });
  it("labels provider status from server attempt and exclusion fields", () => {
    const s = JSON.parse(exampleStateSnapshotJson);
    const byId = new Map<string, any>(s.providers.map((p: any) => [p.id, p]));
    expect(providerStatus(byId.get("kimi"))).toBe("Ready");
    expect(providerStatus(byId.get("agy:3p"))).toBe("Stale");
    expect(providerStatus(byId.get("grok"))).toBe("Invalid");
    expect(providerStatus(byId.get("manual"))).toBe("Not reporting");
  });
  it("uses mock connection names and puts last-read on the status pill", () => {
    expect(connectionName("kimi")).toBe("Kimi Code");
    expect(connectionName("claude")).toBe("Claude Code");
    expect(connectionName("agy")).toBe("Antigravity");
    const s = JSON.parse(exampleStateSnapshotJson);
    const kimi = s.providers.find((p: { id: string }) => p.id === "kimi");
    expect(connectionBadge(kimi)).toMatch(/^Ready · /);
    const stale = s.providers.find((p: { id: string }) => p.id === "agy:3p");
    expect(connectionBadge(stale)).toMatch(/^Stale · /);
  });
});
