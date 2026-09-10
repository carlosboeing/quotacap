import fs from "node:fs";
import { describe, it, expect } from "vitest";
import { effectiveDensity } from "../../web/src/components/SubscriptionList.js";

describe("responsive rules", () => {
  it("keeps the Cards|Table choice at every width, matching the prototype", () => {
    expect(effectiveDensity("table", true)).toBe("table");
    expect(effectiveDensity("table", false)).toBe("table");
    expect(effectiveDensity("cards", true)).toBe("cards");
  });
  it("ships the required breakpoints and containment", () => {
    const css = fs.readFileSync("web/src/theme.css", "utf8");
    expect(css).toMatch(/\.cards-grid/);
    expect(css).toMatch(/\.rail-scroller/);
    expect(css).toMatch(/\.table-scroll/);
    expect(css).toMatch(/min-height: 24px/);
    expect(css).toMatch(
      /main > \.dashboard:first-child > section:first-of-type > \.section-head/
    );
    expect(css).toMatch(/\.alert \{[^}]*font-size: var\(--t-3\)/);
    expect(css).not.toMatch(/font-size: 13\.5px/);
    expect(css).toMatch(/\.recB \{[^}]*padding: var\(--s3\) var\(--s5\) var\(--s4\)/);
  });
});
