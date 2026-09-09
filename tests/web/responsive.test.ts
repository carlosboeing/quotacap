import fs from "node:fs";
import { describe, it, expect } from "vitest";
import { effectiveDensity } from "../../web/src/components/SubscriptionList.js";

describe("responsive rules", () => {
  it("forces cards on narrow viewports and restores the choice when wide", () => {
    expect(effectiveDensity("table", true)).toBe("cards");
    expect(effectiveDensity("table", false)).toBe("table");
    expect(effectiveDensity("cards", true)).toBe("cards");
  });
  it("ships the required breakpoints and containment", () => {
    const css = fs.readFileSync("web/src/theme.css", "utf8");
    expect(css).toMatch(/\.cards-grid/);
    expect(css).toMatch(/@media \(min-width: 768px\)/);
    expect(css).toMatch(/\.rail-scroll/);
    expect(css).toMatch(/\.table-scroll/);
    expect(css).toMatch(/min-height: 24px/);
  });
});
