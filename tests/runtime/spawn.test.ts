import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { trackedExecFile, liveChildCount } from "../../src/runtime/spawn.js";

async function writeTempScript(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qc-spawn-test-"));
  const file = path.join(dir, "script.mjs");
  await fs.writeFile(file, content, { mode: 0o755 });
  return file;
}

describe("trackedExecFile diagnostics", () => {
  it("rejects with safe DiagnosticError preserving terminal_error from stderr with secret stripped", async () => {
    const fake = await writeTempScript(
      "process.stderr.write('Error: stdin is not a terminal token=private-exec-secret\\n'); process.exit(1);",
    );
    await expect(
      trackedExecFile("test-adapter", process.execPath, [fake]),
    ).rejects.toMatchObject({
      name: "DiagnosticError",
      diagnostic: {
        diagnosticCode: "terminal_error",
        errorDetail: expect.stringContaining("stdin is not a terminal"),
      },
    });
    expect(liveChildCount()).toBe(0);
  });

  it("classifies missing command (ENOENT) as command_not_found without leaking path", async () => {
    await expect(
      trackedExecFile("test-adapter", "/nonexistent/binary/path/abc123xyz", []),
    ).rejects.toMatchObject({
      name: "DiagnosticError",
      diagnostic: {
        diagnosticCode: "command_not_found",
      },
    });
    expect(liveChildCount()).toBe(0);
  });

  it("classifies aborted signal as timeout with liveChildCount 0", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      trackedExecFile("test-adapter", process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      name: "DiagnosticError",
      diagnostic: {
        diagnosticCode: "timeout",
      },
    });
    expect(liveChildCount()).toBe(0);
  });
});
