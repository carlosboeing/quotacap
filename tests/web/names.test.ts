import { describe, it, expect } from "vitest";
import { displayName, isKnownProvider } from "../../web/src/names.js";

describe("display names", () => {
  it("maps known adapter ids and leaves unknown ids verbatim", () => {
    expect(displayName("claude")).toBe("Claude");
    expect(displayName("agy:3p")).toBe("Agy 3P");
    expect(displayName("my-plan")).toBe("my-plan");
    expect(isKnownProvider("claude")).toBe(true);
    expect(isKnownProvider("agy:3p")).toBe(true);
    expect(isKnownProvider("my-plan")).toBe(false);
  });

  it("treats Object.prototype keys as literal manual ids, not inherited values", () => {
    for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(displayName(id)).toBe(id);
      expect(typeof displayName(id)).toBe("string");
      expect(isKnownProvider(id)).toBe(false);
    }
  });
});
