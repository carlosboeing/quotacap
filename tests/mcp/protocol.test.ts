import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { VERSION } from "../../src/version.js";
import { OFFLINE_LABEL } from "../../src/cli/snapshot-source.js";
import { seedFileDb } from "../cli/helpers.js";

const tmpDirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  }
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function closedPort(): Promise<number> {
  const server = http.createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return port;
}

interface Session {
  sendLine: (line: string) => void;
  waitLines: (count: number, timeoutMs?: number) => Promise<string[]>;
  stdoutLines: () => string[];
  stderrText: () => string;
}

async function startSession(home: string, url: string): Promise<Session> {
  const child = spawn("node", ["dist/cli/index.js", "mcp"], {
    env: { ...process.env, QUOTACAP_HOME: home, QUOTACAP_URL: url },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  let outBuffer = "";
  let errBuffer = "";
  const lines: string[] = [];
  child.stdout!.on("data", (chunk: Buffer) => {
    outBuffer += chunk.toString("utf8");
    const parts = outBuffer.split("\n");
    outBuffer = parts.pop()!;
    for (const part of parts) {
      if (part.length) lines.push(part);
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    errBuffer += chunk.toString("utf8");
  });
  return {
    sendLine: (line: string) => child.stdin!.write(`${line}\n`),
    waitLines: async (count: number, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      while (lines.length < count) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} stdout lines`);
        await new Promise((r) => setTimeout(r, 20));
      }
      return lines.slice();
    },
    stdoutLines: () => lines.slice(),
    stderrText: () => errBuffer,
  };
}

describe("mcp stdio protocol", () => {
  it("keeps stdout pure JSON-RPC with stderr-only diagnostics", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "qc-proto-"));
    tmpDirs.push(home);
    seedFileDb(path.join(home, ".quotacap", "quotacap.db"));
    const session = await startSession(home, `http://127.0.0.1:${await closedPort()}`);
    const send = (id: number, method: string, params?: unknown) =>
      session.sendLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));

    send(1, "initialize", { capabilities: {} });
    let lines = await session.waitLines(1);
    const init = JSON.parse(lines[0]);
    expect(init.id).toBe(1);
    expect(init.result.serverInfo).toEqual({ name: "quotacap", version: VERSION });

    send(2, "tools/list");
    lines = await session.waitLines(2);
    expect(JSON.parse(lines[1]).result.tools.map((t: any) => t.name)).toEqual([
      "get_quotas",
      "get_recommendation",
      "forecast",
    ]);

    // Offline tool call: stdout carries the labeled snapshot, stderr the label.
    send(3, "tools/call", { name: "get_quotas", arguments: {} });
    lines = await session.waitLines(3);
    const quotas = JSON.parse(lines[2]);
    expect(quotas.id).toBe(3);
    expect(quotas.result.isError).toBeUndefined();
    expect(quotas.result.content[0].text).toContain("Not reporting");

    send(4, "tools/call", { name: "forecast", arguments: { provider: "nope" } });
    lines = await session.waitLines(4);
    const forecast = JSON.parse(lines[3]);
    expect(forecast.result.isError).toBe(true);
    expect(forecast.result.content[0].text).toMatch(/unknown-provider/);

    send(5, "tools/call", { name: "get_recommendation", arguments: { task: "bogus" } });
    lines = await session.waitLines(5);
    const rec = JSON.parse(lines[4]);
    expect(rec.result.isError).toBe(true);
    expect(rec.result.content[0].text).toMatch(/invalid-argument/);

    // Malformed input and notifications produce no stdout.
    session.sendLine("this is not json");
    send(6, "ping");
    lines = await session.waitLines(6);
    expect(JSON.parse(lines[5]).id).toBe(6);
    session.sendLine(JSON.stringify({ jsonrpc: "2.0", method: "ping" }));
    send(7, "ping");
    lines = await session.waitLines(7);
    expect(JSON.parse(lines[6]).id).toBe(7);

    send(8, "unknown/method");
    lines = await session.waitLines(8);
    const unknown = JSON.parse(lines[7]);
    expect(unknown.error.code).toBe(-32601);

    // Protocol purity: every stdout line parses with a matching id, and the
    // offline label never leaks onto stdout.
    const seen = new Set([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const line of session.stdoutLines()) {
      const msg = JSON.parse(line);
      expect(msg.jsonrpc).toBe("2.0");
      expect(seen.has(msg.id)).toBe(true);
      expect(line).not.toContain("offline");
    }
    // Give stderr a moment to flush, then check the diagnostics.
    await new Promise((r) => setTimeout(r, 200));
    expect(session.stderrText()).toContain(OFFLINE_LABEL);
  }, 30000);
});
