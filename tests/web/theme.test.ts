import { describe, it, expect } from "vitest";
import fs from "node:fs";
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

describe("watch palette", () => {
  const css = fs.readFileSync(new URL("../../web/src/theme.css", import.meta.url), "utf8");
  const tokens = ["--watch", "--watch-soft", "--fill-watch", "--edge-watch"];

  it("defines the amber-orange watch family in both themes", () => {
    const darkAt = css.indexOf('html[data-theme="dark"]');
    expect(darkAt).toBeGreaterThan(0);
    for (const block of [css.slice(0, darkAt), css.slice(darkAt)]) {
      for (const token of tokens) {
        const hue40 = new RegExp(`${token}:\\s*oklch\\(\\s*[\\d.]+\\s+[\\d.]+\\s+40\\s*\\)`);
        expect(block).toMatch(hue40);
      }
    }
  });
});
