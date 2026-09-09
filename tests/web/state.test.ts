import { describe, it, expect } from "vitest";
import { exampleStateSnapshotJson, staleStateSnapshotJson } from "../fixtures/stable-state.js";
import { toViewModel, firstRun, ageLabel } from "../../web/src/state.js";

describe("state mapping", () => {
  it("keeps server words and flags untouched", () => {
    const vm = toViewModel(JSON.parse(exampleStateSnapshotJson));
    expect(vm.recommendation.reason).toBe(JSON.parse(exampleStateSnapshotJson).recommendation.reason);
    expect(vm.providers.find((p: any) => p.id === "grok")!.exclusionReason).toBe("invalid");
  });
  it("detects first run only when no quota rows exist", () => {
    expect(firstRun({ providers: [{ quota: null }, { quota: null }] } as any)).toBe(true);
    expect(firstRun(JSON.parse(staleStateSnapshotJson))).toBe(false); // stale rows are still rows
  });
  it("labels reading age from the server timestamp", () => {
    const now = Date.now();
    expect(ageLabel(new Date(now - 30_000).toISOString(), now)).toBe("read 30s ago");
    expect(ageLabel(new Date(now - 5 * 60_000).toISOString(), now)).toBe("read 5m ago");
    expect(ageLabel(new Date(now - 2 * 3_600_000).toISOString(), now)).toBe("read 2h ago");
  });
});
