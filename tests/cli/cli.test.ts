import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { VERSION } from "../../src/version.js";
const exec = promisify(execFile);

// Contract shell: help lists every command, version is byte-identical.
// Command behavior lives in the per-command suites (status/advise/ingest).
describe("cli contract", () => {
  it("--help lists all commands", async () => {
    const { stdout } = await exec("node", ["dist/cli/index.js", "--help"]);
    for (const cmd of ["status", "advise", "ingest", "init", "version", "mcp", "daemon", "web", "service"]) {
      expect(stdout).toMatch(new RegExp(`\\b${cmd}\\b`));
    }
  });
  it("status --help lists the four options", async () => {
    const { stdout } = await exec("node", ["dist/cli/index.js", "status", "--help"]);
    for (const opt of ["--json", "--compact", "--ascii", "--sort"]) {
      expect(stdout).toContain(opt);
    }
  });
  it("version prints the release version", async () => {
    const { stdout } = await exec("node", ["dist/cli/index.js", "version"]);
    expect(stdout.trim()).toBe(VERSION);
  });
});
