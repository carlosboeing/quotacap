import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const exec = promisify(execFile);
describe("cli", () => {
  it("--help lists commands", async () => {
    const { stdout } = await exec("node", ["dist/cli/index.js","--help"]);
    expect(stdout).toMatch(/status/);
  });
  it("status prints the shared quota table", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "qc-cli-"));
    const env = { ...process.env, HOME: home };
    try {
      await exec("node", ["dist/cli/index.js","ingest","--provider","kimi","--text","Weekly limit 16% used resets in 3d"], { env });
      const { stdout } = await exec("node", ["dist/cli/index.js","status"], { env });
      expect(stdout).toMatch(/\| Provider \| Used \| Left \| Resets \| Days left \|/);
      expect(stdout).toMatch(/\| kimi \| 16% \| 84% \|/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 10000);
});
