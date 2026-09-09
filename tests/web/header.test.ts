import { describe, it, expect } from "vitest";
import { pillFor } from "../../web/src/components/Header.js";
import { repairFor } from "../../web/src/components/FaultBanner.js";

describe("header pill", () => {
  it("maps runtime states without inventing health", () => {
    expect(pillFor({ available: false, ready: false, polling: "idle" })).toBe("unreachable");
    expect(pillFor({ available: true, ready: true, polling: "in-progress" })).toBe("polling");
    expect(pillFor({ available: true, ready: true, polling: "idle" })).toBe("live");
    expect(pillFor({ available: true, ready: false, polling: "idle" })).toBe("not-ready");
  });
  it("treats cooldown as polling and a missing version as not ready", () => {
    expect(pillFor({ available: true, ready: true, polling: "cooldown" })).toBe("polling");
    expect(pillFor({ available: true, ready: true, polling: "idle", version: "" })).toBe("not-ready");
  });
});

describe("fault repair", () => {
  it("routes auth failures to provider sign-in and stale rows to re-poll", () => {
    const auth = repairFor({
      id: "claude",
      exclusionReason: "provider-failed",
      lastAttempt: { failureCategory: "auth" },
    } as any);
    expect(auth.text).toMatch(/sign in to the claude cli/i);
    expect(auth.text).toMatch(/never handles those credentials/i);
    const stale = repairFor({ id: "kimi", exclusionReason: "stale", lastAttempt: null } as any);
    expect(stale.text).toMatch(/poll again/i);
  });
});
