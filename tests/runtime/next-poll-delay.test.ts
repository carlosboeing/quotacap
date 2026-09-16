import { describe, it, expect } from "vitest";
import { nextPollDelayMs } from "../../src/runtime/poll.js";

const INTERVAL = 15 * 60 * 1000;
const NOW = Date.parse("2026-09-10T02:11:00Z");
const RESET = "2026-09-10T02:25:00Z";

function delay(over: any = {}) {
  return nextPollDelayMs({
    nowMs: NOW,
    intervalMs: INTERVAL,
    latest: [{ provider: "agy", resetsAt: RESET }],
    lastCompletedPollAtMs: null,
    enabledProviders: ["agy"],
    ...over,
  });
}

describe("nextPollDelayMs", () => {
  it("returns the time until five minutes before a known weekly reset", () => {
    expect(delay()).toBe(9 * 60 * 1000);
  });

  it("keeps the ordinary interval for estimated resets", () => {
    expect(
      delay({
        latest: [{ provider: "grok", resetsAt: RESET, resetsAtEstimated: true }],
        enabledProviders: ["grok"],
      }),
    ).toBe(INTERVAL);
  });

  it("keeps the ordinary interval when under 25 seconds remain before the reset", () => {
    expect(delay({ nowMs: Date.parse("2026-09-10T02:24:50Z") })).toBe(INTERVAL);
  });

  it("keeps the ordinary interval when a poll already completed inside the lead window", () => {
    expect(delay({ lastCompletedPollAtMs: Date.parse("2026-09-10T02:20:30Z") })).toBe(INTERVAL);
    expect(delay({ lastCompletedPollAtMs: Date.parse("2026-09-10T02:20:00Z") })).toBe(INTERVAL);
  });

  it("arms one second later when already inside the lead window with no poll since", () => {
    expect(delay({ nowMs: Date.parse("2026-09-10T02:21:00Z") })).toBe(1000);
  });

  it("ignores providers that are not enabled", () => {
    expect(delay({ latest: [{ provider: "grok", resetsAt: RESET }] })).toBe(INTERVAL);
  });

  it("treats agy:3p as enabled when agy is enabled", () => {
    expect(delay({ latest: [{ provider: "agy:3p", resetsAt: RESET }] })).toBe(9 * 60 * 1000);
    expect(delay({ latest: [{ provider: "agy:3p", resetsAt: RESET }], enabledProviders: [] })).toBe(INTERVAL);
  });

  it("takes the earliest candidate across providers, never exceeding the interval", () => {
    expect(
      delay({
        latest: [
          { provider: "claude", resetsAt: "2026-09-10T03:00:00Z" },
          { provider: "agy", resetsAt: RESET },
        ],
        enabledProviders: ["agy", "claude"],
      }),
    ).toBe(9 * 60 * 1000);
    expect(
      delay({
        latest: [
          { provider: "agy", resetsAt: RESET },
          { provider: "kimi", resetsAt: "2026-09-10T02:19:00Z" },
        ],
        enabledProviders: ["agy", "kimi"],
      }),
    ).toBe(3 * 60 * 1000);
  });

  it("ignores missing, unparseable, and already-due resets", () => {
    for (const resetsAt of [undefined, "not-a-date", "2026-09-10T02:00:00Z", "2026-09-10T02:11:00Z"]) {
      expect(delay({ latest: [{ provider: "agy", resetsAt }] })).toBe(INTERVAL);
    }
  });

  it("does not wait past the ordinary interval for a distant reset", () => {
    expect(delay({ latest: [{ provider: "agy", resetsAt: "2026-09-17T02:25:00Z" }] })).toBe(INTERVAL);
  });
});
