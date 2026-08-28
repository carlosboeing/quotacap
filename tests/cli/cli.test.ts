import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
describe("cli", () => {
  it("--help lists commands", async () => {
    const { stdout } = await exec("node", ["dist/cli/index.js","--help"]);
    expect(stdout).toMatch(/status/);
  });
});
