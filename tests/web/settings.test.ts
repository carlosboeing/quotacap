import { describe, it, expect } from "vitest";
import { exampleStateSnapshotJson } from "../fixtures/stable-state.js";
import { ingestPayload, providerStatus } from "../../web/src/components/settings/ProvidersPanel.js";

describe("settings", () => {
  it("sends ingest input unparsed for server validation", () => {
    expect(ingestPayload("my-plan", "Used 45 of 100 requests. Resets in 2 days.")).toEqual({
      provider: "my-plan",
      text: "Used 45 of 100 requests. Resets in 2 days.",
    });
  });
  it("labels provider status from server attempt and exclusion fields", () => {
    const s = JSON.parse(exampleStateSnapshotJson);
    const byId = new Map<string, any>(s.providers.map((p: any) => [p.id, p]));
    expect(providerStatus(byId.get("kimi"))).toBe("Ready");
    expect(providerStatus(byId.get("agy:3p"))).toBe("Stale");
    expect(providerStatus(byId.get("grok"))).toBe("Invalid");
    expect(providerStatus(byId.get("manual"))).toBe("Not reporting");
  });
});
