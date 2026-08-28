import { describe, it, expect } from "vitest";
import fs from "node:fs";
describe("web D", () => {
  it("index.html has app root", () => {
    const html = fs.readFileSync("web/index.html","utf8");
    expect(html).toMatch(/id="app"/);
  });
});
