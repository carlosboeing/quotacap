import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import fssync from "node:fs";
import os from "node:os";
import path from "node:path";
import { trackedExecFile, liveChildCount } from "../../src/runtime/spawn.js";

async function writeTempScript(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qc-spawn-test-"));
  const file = path.join(dir, "script.mjs");
  await fs.writeFile(file, content, { mode: 0o755 });
  return file;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  cond: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(25);
  }
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
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

describe("probe lifecycle: timeout, stdin, process group", () => {
  // Reaps stub pids the code under test failed to kill, so a red run leaves
  // no strays behind. No-ops once the probe lifecycle reaps its own children.
  const stubPidFiles: string[] = [];
  const stubDirs: string[] = [];

  afterEach(async () => {
    for (const f of stubPidFiles.splice(0)) {
      try {
        const pid = parseInt(await fs.readFile(f, "utf8"), 10);
        if (Number.isFinite(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      } catch {}
    }
    for (const d of stubDirs.splice(0)) {
      fssync.rmSync(d, { recursive: true, force: true });
    }
    // A leaked stub keeps its tracked entry until it exits; wait for the
    // reaps above to land so one test's strays never pollute the next.
    await waitFor(() => liveChildCount() === 0, 5000, "liveChildCount 0").catch(() => {});
  });

  async function mkStubDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qc-spawn-probe-"));
    stubDirs.push(dir);
    return dir;
  }

  it("timeout reaps a SIGTERM-ignoring child and rejects as timeout", async () => {
    const dir = await mkStubDir();
    const pidFile = path.join(dir, "stub.pid");
    stubPidFiles.push(pidFile);
    const stub = await writeTempScript(
      `import fs from "node:fs";\n` +
        `process.on("SIGTERM", () => {});\n` +
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `setInterval(() => {}, 1000);\n`,
    );
    stubDirs.push(path.dirname(stub));
    await expect(
      trackedExecFile("test-probe", process.execPath, [stub], { timeout: 500 }),
    ).rejects.toMatchObject({
      name: "DiagnosticError",
      diagnostic: { diagnosticCode: "timeout" },
    });
    const pid = parseInt(await fs.readFile(pidFile, "utf8"), 10);
    await waitFor(() => !isPidAlive(pid), 3000, `pid ${pid} to die`);
    await waitFor(() => liveChildCount() === 0, 3000, "liveChildCount 0");
  }, 15000);

  it("probe children get a closed stdin", async () => {
    const stub = await writeTempScript(
      `let ended = false;\n` +
        `process.stdin.on("end", () => { ended = true; });\n` +
        `process.stdin.resume();\n` +
        `setTimeout(() => { process.stdout.write(ended ? "stdin:closed\\n" : "stdin:open\\n"); process.exit(0); }, 300);\n`,
    );
    stubDirs.push(path.dirname(stub));
    const { stdout } = await trackedExecFile("test-probe", process.execPath, [stub], {
      timeout: 5000,
    });
    expect(stdout).toContain("stdin:closed");
  }, 15000);

  it("timeout reaps grandchildren in the probe process group", async () => {
    const dir = await mkStubDir();
    const pidFile = path.join(dir, "stub.pid");
    const gpidFile = path.join(dir, "grandchild.pid");
    stubPidFiles.push(pidFile, gpidFile);
    // Same-group grandchild (like an MCP server booted by a CLI probe): no
    // `detached`, ignored stdio, unref'd — it outlives a direct-child kill.
    const stub = await writeTempScript(
      `import fs from "node:fs";\n` +
        `import { spawn } from "node:child_process";\n` +
        `process.on("SIGTERM", () => {});\n` +
        `const g = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"], { stdio: "ignore" });\n` +
        `g.unref();\n` +
        `fs.writeFileSync(${JSON.stringify(gpidFile)}, String(g.pid));\n` +
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `setInterval(() => {}, 1000);\n`,
    );
    stubDirs.push(path.dirname(stub));
    await expect(
      trackedExecFile("test-probe", process.execPath, [stub], { timeout: 500 }),
    ).rejects.toMatchObject({
      name: "DiagnosticError",
      diagnostic: { diagnosticCode: "timeout" },
    });
    const pid = parseInt(await fs.readFile(pidFile, "utf8"), 10);
    const gpid = parseInt(await fs.readFile(gpidFile, "utf8"), 10);
    await waitFor(() => !isPidAlive(pid), 3000, `pid ${pid} to die`);
    await waitFor(() => !isPidAlive(gpid), 3000, `grandchild ${gpid} to die`);
    await waitFor(() => liveChildCount() === 0, 3000, "liveChildCount 0");
  }, 15000);
});
