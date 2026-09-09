import { describe, it, expect, afterEach, vi } from "vitest";
import { Command } from "commander";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { registerRuntimeCommands } from "../../src/cli/runtime.js";
import {
  createServiceClient,
  ServiceUnavailable,
  ServiceError,
} from "../../src/runtime/client.js";
import { acquireClaim, type Claim } from "../../src/runtime/owner.js";
import { VERSION } from "../../src/version.js";

const exec = promisify(execFile);
const oldQcHome = process.env.QUOTACAP_HOME;
const dirs: string[] = [];
const claims: Claim[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  for (const c of claims.splice(0)) {
    try {
      c.release();
    } catch {}
  }
  for (const s of servers.splice(0)) {
    await new Promise((r) => s.close(r));
  }
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  process.env.QUOTACAP_HOME = oldQcHome;
  vi.restoreAllMocks();
});

function isolatedHome(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "qc-cli-rt-"));
  dirs.push(d);
  process.env.QUOTACAP_HOME = d;
  return d;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

async function stubServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, port };
}

function testProgram(deps: Record<string, any>) {
  const prog = new Command();
  prog.exitOverride();
  registerRuntimeCommands(prog, deps);
  return prog;
}

describe("runtime cli", () => {
  it("(a) --help lists daemon, web and service after extraction", async () => {
    const { stdout } = await exec("node", ["dist/cli/index.js", "--help"]);
    expect(stdout).toMatch(/daemon/);
    expect(stdout).toMatch(/web/);
    expect(stdout).toMatch(/service/);
  });

  it("(b) web against a healthy service opens the URL and starts nothing", async () => {
    isolatedHome();
    const { port } = await stubServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ok: true,
          ready: true,
          version: VERSION,
          exec: process.execPath,
          polling: "idle",
          lastCompletedPollAt: null,
        }),
      );
    });
    const opened: string[] = [];
    let started = 0;
    const exitCodes: number[] = [];
    const prog = testProgram({
      exit: (c: number) => exitCodes.push(c),
      openBrowser: async (url: string) => opened.push(url),
      startService: async () => {
        started++;
        throw new Error("must not start");
      },
    });
    await prog.parseAsync(["web", "--port", String(port)], { from: "user" });
    expect(opened).toEqual([`http://127.0.0.1:${port}`]);
    expect(started).toBe(0);
    expect(exitCodes).toEqual([]);
  });

  it("(c) web with nothing listening starts the foreground service and opens it", async () => {
    isolatedHome();
    const port = await getFreePort();
    const opened: string[] = [];
    const exitCodes: number[] = [];
    let startedWith: any = null;
    const prog = testProgram({
      exit: (c: number) => exitCodes.push(c),
      openBrowser: async (url: string) => opened.push(url),
      startService: async (opts: any) => {
        startedWith = opts;
        return { port, stop: async () => {}, state: {} };
      },
    });
    await prog.parseAsync(["web", "--port", String(port)], { from: "user" });
    expect(startedWith).toEqual({ port });
    expect(opened).toEqual([`http://127.0.0.1:${port}`]);
    expect(exitCodes).toEqual([]);
  });

  it("(d) version-mismatch service exits 2 naming executable, version and port", async () => {
    isolatedHome();
    const { port } = await stubServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ok: true,
          ready: true,
          version: "0.0.0-stale",
          exec: "/other/quotacap",
        }),
      );
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const opened: string[] = [];
    let started = 0;
    const exitCodes: number[] = [];
    const prog = testProgram({
      exit: (c: number) => exitCodes.push(c),
      openBrowser: async (url: string) => opened.push(url),
      startService: async () => {
        started++;
        throw new Error("must not start");
      },
    });
    await prog.parseAsync(["web", "--port", String(port)], { from: "user" });
    expect(exitCodes).toEqual([2]);
    const msg = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(msg).toContain("0.0.0-stale");
    expect(msg).toContain("/other/quotacap");
    expect(msg).toContain(String(port));
    expect(opened).toEqual([]);
    expect(started).toBe(0);
  });

  it("(e) web --port against an owner on another port exits 2", async () => {
    const home = isolatedHome();
    const claim = await acquireClaim(path.join(home, ".quotacap"));
    claims.push(claim);
    const port = await getFreePort();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let started = 0;
    const exitCodes: number[] = [];
    const prog = testProgram({
      exit: (c: number) => exitCodes.push(c),
      openBrowser: async () => {},
      startService: async () => {
        started++;
        throw new Error("must not start");
      },
    });
    await prog.parseAsync(["web", "--port", String(port)], { from: "user" });
    expect(exitCodes).toEqual([2]);
    const msg = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(msg).toMatch(/mismatch/);
    expect(msg).toContain(claim.info.version);
    expect(msg).toContain(String(port));
    expect(started).toBe(0);
  });

  it("(f) browser-open failure prints the URL and keeps the service", async () => {
    isolatedHome();
    const port = await getFreePort();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stop = vi.fn(async () => {});
    const exitCodes: number[] = [];
    const prog = testProgram({
      exit: (c: number) => exitCodes.push(c),
      openBrowser: async () => {
        throw new Error("no browser");
      },
      startService: async () => ({ port, stop, state: {} }),
    });
    await prog.parseAsync(["web", "--port", String(port)], { from: "user" });
    const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain(`http://127.0.0.1:${port}`);
    expect(stop).not.toHaveBeenCalled();
    expect(exitCodes).toEqual([]);
  });

  it("(h) client throws ServiceUnavailable on refused connection", async () => {
    const port = await getFreePort();
    const client = createServiceClient({ port, timeoutMs: 500 });
    await expect(client.get("/health")).rejects.toBeInstanceOf(ServiceUnavailable);
    await expect(client.post("/api/refresh", {})).rejects.toBeInstanceOf(
      ServiceUnavailable,
    );
  });

  it("(h) client throws ServiceError on HTTP 4xx/5xx and parses success", async () => {
    const { port } = await stubServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/boom") {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "bad" }));
      } else if (req.url === "/api/ingest") {
        res.end(JSON.stringify({ ok: req.headers["x-quotacap-token"] === "s3cret" }));
      } else {
        res.end(JSON.stringify({ ok: true }));
      }
    });
    const client = createServiceClient({ port });
    const err = await client.get("/boom").then(
      () => {
        throw new Error("unexpected success");
      },
      (e) => e,
    );
    expect(err).toBeInstanceOf(ServiceError);
    expect(err.status).toBe(400);
    expect(await client.get("/health")).toEqual({ ok: true });

    const authed = createServiceClient({ port, token: "s3cret" });
    expect(await authed.post("/api/ingest", { a: 1 })).toEqual({ ok: true });
  });
});
