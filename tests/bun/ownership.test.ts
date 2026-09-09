import { test, expect } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readClaim } from "../../src/runtime/owner.ts";

const HOLDER = path.resolve(import.meta.dir, "../runtime/helpers/claim-holder.mjs");

function mkHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qc-bun-owner-"));
}

function waitFor(child: ChildProcess, needle: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for ${needle}; got ${JSON.stringify(out)}`));
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      out += String(d);
      if (out.includes(needle)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`exited ${code} before ${needle}; got ${JSON.stringify(out)}`));
    });
  });
}

function runToExit(
  bin: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    p.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function holdAndContend(holderBin: string, contenderBin: string): Promise<void> {
  const dir = mkHome();
  try {
    const holder = spawn(holderBin, [HOLDER, "--dir", dir, "--hold-ms", "3000"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await waitFor(holder, "HELD", 10000);
      const live = readClaim(dir);
      expect(live).not.toBeNull();
      const r = await runToExit(contenderBin, [HOLDER, "--dir", dir, "--hold-ms", "500"]);
      if (r.code !== 1 || !r.stdout.includes(`CONTENDED:${live!.nonce}`)) {
        throw new Error(
          `contender failed: code=${r.code} ${JSON.stringify(r.stdout)} ${JSON.stringify(r.stderr)}`,
        );
      }
      const exitCode: number | null = await new Promise((resolve) =>
        holder.on("close", resolve),
      );
      expect(exitCode).toBe(0);
    } finally {
      holder.kill("SIGKILL");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test(
  "bun holder vs node contender: exactly one wins",
  async () => {
    await holdAndContend(process.execPath, "node");
  },
  15000,
);

test(
  "node holder vs bun contender: exactly one wins",
  async () => {
    await holdAndContend("node", process.execPath);
  },
  15000,
);
