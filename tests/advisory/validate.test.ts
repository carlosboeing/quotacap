import { describe, it, expect } from "vitest";
import { validateTask, validateForecastProvider } from "../../src/advisory/validate.js";

describe("validate", () => {
  it("accepts the any/heavy/light contract and rejects the rest", () => {
    expect(validateTask("heavy")).toBe("heavy");
    expect(() => validateTask("urgent")).toThrowError(/invalid-argument/);
  });

  it("accepts manual and group ids, separates unknown from missing", () => {
    const ctx = { registered: ["claude", "codex", "kimi", "grok", "agy", "agy:3p", "manual"], storedIds: ["my-plan", "agy"] };
    expect(validateForecastProvider("my-plan", ctx)).toBe("my-plan");
    expect(validateForecastProvider("agy:3p", ctx)).toBe("agy:3p");
    expect(() => validateForecastProvider("nope", ctx)).toThrowError(/unknown-provider/);
    expect(() => validateForecastProvider("kimi", ctx)).toThrowError(/missing-reading/);
  });
});
