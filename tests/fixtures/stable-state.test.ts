import { describe, it, expect } from "vitest";
import { FIXED_NOW, buildFixtureDb, exampleStateSnapshot } from "./stable-state.js";
import { buildSnapshot } from "../../src/advisory/snapshot.js";

const RT = { available: true, ready: true, polling: "idle" as const, lastCompletedPollAt: "2026-09-07T05:45:00+10:00", version: "0.0.21" };

describe("shared fixtures", () => {
  it("pins one clock and covers every required case", () => {
    expect(FIXED_NOW.toISOString()).toBe("2026-09-06T20:00:00.000Z"); // 2026-09-07T06:00:00+10:00
    const ids = exampleStateSnapshot.providers.map((p: any) => p.id);
    for (const id of ["kimi", "claude", "grok", "codex", "my-plan", "agy", "agy:3p"]) expect(ids).toContain(id);
  });

  it("is deterministic: rebuild matches the checked-in example", () => {
    const db = buildFixtureDb();
    const fresh = buildSnapshot(db, { enabledProviders: ["claude", "codex", "kimi", "grok", "agy"], now: FIXED_NOW, runtime: RT });
    expect(JSON.stringify(fresh)).toBe(JSON.stringify(exampleStateSnapshot));
  });
});
