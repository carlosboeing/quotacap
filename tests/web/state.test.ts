import { describe, it, expect } from "vitest";
import { exampleStateSnapshotJson, staleStateSnapshotJson } from "../fixtures/stable-state.js";
import { toViewModel, firstRun, ageLabel, nextRefreshLabel, displayPlan, shortWindowLabel } from "../../web/src/state.js";

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
  it("defaults lastCloses to an empty array for older daemons", () => {
    const vm = toViewModel(JSON.parse(exampleStateSnapshotJson));
    for (const p of vm.providers) expect(p.lastCloses).toEqual([]);
    const withClose = JSON.parse(exampleStateSnapshotJson);
    withClose.providers[0].lastCloses = [{ provider: "x", leftoverPct: 12 }];
    expect(toViewModel(withClose).providers[0].lastCloses).toHaveLength(1);
  });
  it("passes Watch advisories and blend fields through the vendored mirror", () => {
    const raw = JSON.parse(exampleStateSnapshotJson);
    const kimi = raw.providers.find((p: any) => p.id === "kimi");
    kimi.advisory = { ...kimi.advisory, status: "watch", recentRate: 6.2, baselineRate: 3.1, aheadOfElapsed: false };
    const vm = toViewModel(raw);
    const adv = vm.providers.find((p) => p.id === "kimi")!.advisory!;
    expect(adv.status).toBe("watch");
    expect(adv.recentRate).toBe(6.2);
    expect(adv.baselineRate).toBe(3.1);
    expect(adv.aheadOfElapsed).toBe(false);
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
  it("hides the unknown plan placeholder from display", () => {
    expect(displayPlan("unknown")).toBeNull();
    expect(displayPlan("")).toBeNull();
    expect(displayPlan(null)).toBeNull();
    expect(displayPlan(undefined)).toBeNull();
    expect(displayPlan("Plus")).toBe("Plus");
    expect(displayPlan("SuperGrok")).toBe("SuperGrok");
  });
  it("names each short window as 5h Limit", () => {
    expect(shortWindowLabel("codex")).toBe("5h Limit");
    expect(shortWindowLabel("kimi")).toBe("5h Limit");
    expect(shortWindowLabel("agy")).toBe("5h Limit");
    expect(shortWindowLabel("agy:3p")).toBe("5h Limit");
    expect(shortWindowLabel("claude")).toBe("5h Limit");
    expect(shortWindowLabel("muse")).toBe("5h Limit");
    expect(shortWindowLabel("grok")).toBeNull();
    expect(shortWindowLabel("manual")).toBeNull();
  });
  it("labels the opencode-go short window like the other 5h providers", () => {
    expect(shortWindowLabel("opencode-go")).toBe("5h Limit");
  });
  it("normalizes detectedProviders with an empty default for older daemons", () => {
    const vm = toViewModel({ asOf: "x", runtime: { available: true, ready: true, polling: "idle", lastCompletedPollAt: null, version: "t" } as any, providers: [], recommendation: {} as any });
    expect(vm.runtime.detectedProviders).toEqual([]);
    const vm2 = toViewModel({ asOf: "x", runtime: { available: true, ready: true, polling: "idle", lastCompletedPollAt: null, version: "t", detectedProviders: ["opencode-go"] } as any, providers: [], recommendation: {} as any });
    expect(vm2.runtime.detectedProviders).toEqual(["opencode-go"]);
  });
});
