import { describe, it, expect } from "vitest";
import { exampleStateSnapshotJson, staleStateSnapshotJson } from "../fixtures/stable-state.js";
import { toViewModel, firstRun, ageLabel, nextRefreshLabel } from "../../web/src/state.js";

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
  it("labels next refresh from lastCompletedPollAt and the default interval", () => {
    const now = Date.parse("2026-09-10T12:00:00Z");
    expect(nextRefreshLabel(null, "idle", now)).toBe("Next automatic refresh pending");
    expect(nextRefreshLabel("2026-09-10T11:52:00Z", "idle", now)).toBe(
      "Next automatic refresh in 7m",
    );
    expect(nextRefreshLabel("2026-09-10T11:00:00Z", "idle", now)).toBe(
      "Next automatic refresh due",
    );
    expect(nextRefreshLabel("2026-09-10T11:52:00Z", "in-progress", now)).toBe("Refreshing now");
  });
});
