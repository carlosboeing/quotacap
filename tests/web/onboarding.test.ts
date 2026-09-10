import { describe, it, expect } from "vitest";
import { exampleStateSnapshotJson } from "../fixtures/stable-state.js";
import { routeFor } from "../../web/src/router.js";
import { readiness } from "../../web/src/pages/Onboarding.js";

describe("onboarding guard", () => {
  it("routes first run to setup and everything else to the dashboard", () => {
    expect(routeFor("/", true)).toBe("/setup");
    expect(routeFor("/setup", false)).toBe("/");
    expect(routeFor("/nope", false)).toBe("/");
  });
});

describe("setup readiness", () => {
  it("reads readiness from server state without probing", () => {
    const s = JSON.parse(exampleStateSnapshotJson);
    const byId = new Map<string, any>(s.providers.map((p: any) => [p.id, p]));
    expect(readiness(byId.get("kimi")).status).toBe("Ready");
    expect(readiness(byId.get("manual")).status).toBe("Sign in first");
    expect(readiness(byId.get("manual")).detail).toMatch(/no live adapter/);
    expect(
      readiness({ id: "claude", quota: null, lastAttempt: { failureCategory: "auth" } } as any).status
    ).toBe("Sign in first");
  });
});
