import { describe, it, expect } from "vitest";
import { blendForecast, baselineFor } from "../../src/advisory/engine.js";
import { BLEND_K, GATE_TOL, RISK_MARGIN } from "../../src/advisory/types.js";
import type { Quota } from "../../src/adapters/types.js";

const NOW = new Date("2026-09-07T06:00:00Z");

function quota(over: Partial<Quota> = {}): Quota {
  return {
    provider: "claude",
    plan: "max",
    usedPct: 20,
    resetsAt: "2026-09-14T06:00:00Z",
    periodStart: "2026-09-05T06:00:00Z",
    source: "cli",
    fetchedAt: "2026-09-07T06:00:00Z",
    ...over,
  };
}

describe("forecast constants", () => {
  it("ships the starting values", () => {
    expect(BLEND_K).toBe(0.5);
    expect(RISK_MARGIN).toBe(0.15);
    expect(GATE_TOL).toBe(0.1);
  });
});

describe("blendForecast", () => {
  it("halves a spike: recent 60 against baseline 10 forecasts 35", () => {
    expect(blendForecast(60, 10)).toBeCloseTo(35, 10);
  });

  it("shrinks a dip symmetrically", () => {
    expect(blendForecast(10, 60)).toBeCloseTo(35, 10);
  });

  it("clamps a negative blend at zero", () => {
    expect(blendForecast(-10, 5)).toBe(0);
  });

  it("passes a lone recent rate through", () => {
    expect(blendForecast(60, null)).toBe(60);
  });

  it("passes a lone baseline through", () => {
    expect(blendForecast(null, 10)).toBe(10);
  });

  it("keeps a zero baseline rather than treating it as absent", () => {
    expect(blendForecast(20, 0)).toBeCloseTo(10, 10);
  });

  it("returns null when neither input exists", () => {
    expect(blendForecast(null, null)).toBeNull();
  });
});

describe("baselineFor", () => {
  it("prefers recorded history", () => {
    expect(baselineFor(12.5, quota(), NOW)).toBe(12.5);
  });

  it("keeps a zero history average", () => {
    expect(baselineFor(0, quota(), NOW)).toBe(0);
  });

  it("falls back to the window average when history is missing", () => {
    // 20% used over 2 elapsed days is 10%/day.
    expect(baselineFor(null, quota(), NOW)).toBeCloseTo(10, 10);
  });

  it("returns null when history and pace are both unavailable", () => {
    expect(baselineFor(null, quota({ periodStart: "" }), NOW)).toBeNull();
  });

  it("returns null when the window average is still too young", () => {
    expect(baselineFor(null, quota({ periodStart: "2026-09-07T04:00:00Z" }), NOW)).toBeNull();
  });
});
