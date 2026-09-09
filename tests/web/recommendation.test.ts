import { describe, it, expect } from "vitest";
import { exampleStateSnapshotJson, unknownPaceStateSnapshotJson } from "../fixtures/stable-state.js";
import { laneOf } from "../../web/src/components/Recommendation.js";

describe("recommendation lanes", () => {
  it("lanes follow server urgency, never recompute waste", () => {
    const s = JSON.parse(exampleStateSnapshotJson);
    for (const a of s.recommendation.advisories) {
      if (a.urgency === "burn now" || a.urgency === "use soon" || a.urgency === "save") {
        expect(laneOf(a, null)).toBe("use-more");
      }
      if (a.urgency === "slow down") expect(laneOf(a, null)).toBe("ease-off");
      if (a.urgency === "on track") expect(laneOf(a, null)).toBeNull();
    }
  });
  it("excluded providers never lane, unknown pace never forecasts", () => {
    expect(laneOf({ urgency: "burn now" }, "stale")).toBeNull();
    expect(laneOf({ urgency: "burn now" }, "reset-passed")).toBeNull();
    expect(laneOf({ urgency: "slow down" }, "invalid")).toBeNull();
    // The unknown-pace fixture keeps my-plan recommended at 76% waste; only
    // kimi's pace is unknown, so kimi carries no forecast fields and no lane.
    const u = JSON.parse(unknownPaceStateSnapshotJson);
    const kimi = u.providers.find((p: any) => p.id === "kimi");
    expect(kimi.advisory.paceSource).toBe("unknown");
    expect(kimi.advisory.wastePct).toBeNull();
    expect(kimi.advisory.burnRate).toBeNull();
    expect(laneOf(kimi.advisory, kimi.exclusionReason)).toBeNull();
  });
});
