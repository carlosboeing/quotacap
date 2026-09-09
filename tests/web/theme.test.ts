import { describe, it, expect } from "vitest";
import { resolveTheme } from "../../web/src/Theme.js";

describe("theme", () => {
  it("prefers stored, then system", () => {
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme(null, true)).toBe("dark");
    expect(resolveTheme(null, false)).toBe("light");
  });
  it("honours a stored light theme over a dark system", () => {
    expect(resolveTheme("light", true)).toBe("light");
  });
});
