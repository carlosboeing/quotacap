import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "./helpers.js";

function isolatedHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qc-init-"));
}

function configPath(home: string): string {
  return path.join(home, ".quotacap", "config.json");
}

// init keeps stdout JSON (machine contract) while human guidance goes to
// stderr; --quiet silences both, --force rewrites after backing up.
describe("init command", () => {
  it("provisions config.json with JSON on stdout and guidance on stderr", async () => {
    const home = isolatedHome();
    const res = await runCli(home, ["init"]);
    expect(res.code).toBe(0);
    expect(fs.existsSync(configPath(home))).toBe(true);
    const printed = JSON.parse(res.stdout);
    expect(printed.port).toBe(JSON.parse(fs.readFileSync(configPath(home), "utf8")).port);
    expect(res.stderr).toContain("wrote default config to");
    expect(res.stderr).toContain(configPath(home));
    expect(res.stderr).toContain("quotacap web");
  });

  it("--quiet provisions silently on success", async () => {
    const home = isolatedHome();
    const res = await runCli(home, ["init", "--quiet"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("");
    expect(fs.existsSync(configPath(home))).toBe(true);
  });

  it("rerun is idempotent and reports the existing file", async () => {
    const home = isolatedHome();
    expect((await runCli(home, ["init"])).code).toBe(0);
    const res = await runCli(home, ["init"]);
    expect(res.code).toBe(0);
    expect(() => JSON.parse(res.stdout)).not.toThrow();
    expect(res.stderr).toContain("config already exists");
    expect(res.stderr).toContain(configPath(home));
  });

  it("--force rewrites defaults after backing up the existing file", async () => {
    const home = isolatedHome();
    const p = configPath(home);
    expect((await runCli(home, ["init"])).code).toBe(0);
    const custom = { ...JSON.parse(fs.readFileSync(p, "utf8")), port: 9999 };
    fs.writeFileSync(p, JSON.stringify(custom));
    const res = await runCli(home, ["init", "--force"]);
    expect(res.code).toBe(0);
    expect(JSON.parse(fs.readFileSync(p, "utf8")).port).not.toBe(9999);
    expect(JSON.parse(fs.readFileSync(`${p}.bak`, "utf8")).port).toBe(9999);
    expect(res.stderr).toContain("rewrote default config");
  });
});
