import { describe, it, expect } from "vitest";
import { getConfigPath } from "../src/config.js";
import fs from "node:fs";

describe("bootstrap", () => {
  it("package.json has bin quotacap", () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    expect(pkg.name).toBe("quotacap");
    expect(pkg.bin.quotacap).toBeDefined();
  });
  it("getConfigPath respects XDG/ home", () => {
    const p = getConfigPath();
    expect(p).toMatch(/quotacap/);
  });
});
