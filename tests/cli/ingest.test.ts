import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { seedFileDb, runCli } from "./helpers.js";

const ENABLE_INGEST = { QUOTACAP_EXPERIMENTAL_INGEST: "1" };

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qc-ingest-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function writeConfig(home: string, port: number): void {
  const dir = path.join(home, ".quotacap");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ port }));
}

function writeToken(home: string, token: string): void {
  const dir = path.join(home, ".quotacap");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "token"), `${token}\n`);
}

interface Captured {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function startStub(
  onIngest: (captured: Captured, res: http.ServerResponse) => void,
): Promise<{ port: number; captured: Captured; close: () => Promise<void> }> {
  const captured: Captured = { headers: {}, body: "" };
  const server = http.createServer((req, res) => {
    if (req.url === "/api/ingest" && req.method === "POST") {
      captured.method = req.method;
      captured.url = req.url;
      captured.headers = req.headers;
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        captured.body = body;
        onIngest(captured, res);
      });
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    captured,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

async function closedPort(): Promise<number> {
  const server = http.createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return port;
}

describe("ingest process", () => {
  it("posts provider/text with the token header and prints ingested", async () => {
    const stub = await startStub((_captured, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, provider: "my plan" }));
    });
    try {
      const home = tmpDir();
      writeConfig(home, stub.port);
      writeToken(home, "test-token-123");
      const run = await runCli(home, ["ingest", "--provider", "my plan", "--text", "Weekly limit 16% used"], ENABLE_INGEST);
      expect(run.code).toBe(0);
      expect(run.stderr).toBe("");
      expect(run.stdout).toBe("ingested\n");
      expect(stub.captured.method).toBe("POST");
      expect(stub.captured.url).toBe("/api/ingest");
      expect(JSON.parse(stub.captured.body)).toEqual({
        provider: "my plan",
        text: "Weekly limit 16% used",
      });
      expect(stub.captured.headers["x-quotacap-token"]).toBe("test-token-123");
    } finally {
      await stub.close();
    }
  }, 15000);

  it("refused connection exits 1 without creating or writing any database file", async () => {
    const home = tmpDir();
    writeConfig(home, await closedPort());
    writeToken(home, "test-token-123");
    const dbPath = path.join(home, ".quotacap", "quotacap.db");
    const run = await runCli(home, ["ingest", "--provider", "p", "--text", "t"], ENABLE_INGEST);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/service-unavailable/);
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
  }, 15000);

  it("refused connection leaves a seeded database byte-identical", async () => {
    const home = tmpDir();
    const dbPath = seedFileDb(path.join(home, ".quotacap", "quotacap.db"));
    const before = fs.readFileSync(dbPath);
    writeConfig(home, await closedPort());
    const run = await runCli(home, ["ingest", "--provider", "p", "--text", "t"], ENABLE_INGEST);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/service-unavailable/);
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
  }, 15000);

  it("service 400 surfaces the message with exit 1", async () => {
    const stub = await startStub((_captured, res) => {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "invalid-argument: provider and text are required" }));
    });
    try {
      const home = tmpDir();
      writeConfig(home, stub.port);
      writeToken(home, "test-token-123");
      const run = await runCli(home, ["ingest", "--provider", "p", "--text", "t"], ENABLE_INGEST);
      expect(run.code).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toMatch(/service-error/);
      expect(run.stderr).toMatch(/400/);
      expect(run.stderr).toMatch(/invalid-argument: provider and text are required/);
    } finally {
      await stub.close();
    }
  }, 15000);

  it("service 401 names the token mismatch", async () => {
    const stub = await startStub((_captured, res) => {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "unauthorized: missing or invalid X-QuotaCap-Token header" }));
    });
    try {
      const home = tmpDir();
      writeConfig(home, stub.port);
      writeToken(home, "wrong-token");
      const run = await runCli(home, ["ingest", "--provider", "p", "--text", "t"], ENABLE_INGEST);
      expect(run.code).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toMatch(/service-error/);
      expect(run.stderr).toMatch(/401/);
      expect(run.stderr).toMatch(/X-QuotaCap-Token/);
    } finally {
      await stub.close();
    }
  }, 15000);

  it("manual IDs with spaces and colons pass through unvalidated", async () => {
    for (const provider of ["my plan", "custom:gpt-5:codex"]) {
      const stub = await startStub((_captured, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, provider }));
      });
      try {
        const home = tmpDir();
        writeConfig(home, stub.port);
        writeToken(home, "test-token-123");
        const run = await runCli(home, ["ingest", "--provider", provider, "--text", "81% used"], ENABLE_INGEST);
        expect(run.code).toBe(0);
        expect(run.stdout).toBe("ingested\n");
        expect(JSON.parse(stub.captured.body).provider).toBe(provider);
      } finally {
        await stub.close();
      }
    }
  }, 15000);

  it("is an unknown command unless the experimental flag is set", async () => {
    const home = tmpDir();
    const run = await runCli(home, ["ingest", "--provider", "p", "--text", "t"], {
      QUOTACAP_EXPERIMENTAL_INGEST: "0",
    });
    expect(run.code).not.toBe(0);
    expect(run.stdout + run.stderr).toMatch(/unknown command|unknown command 'ingest'/i);
    expect(run.stdout + run.stderr).not.toMatch(/^ingested$/m);
  }, 15000);

  it("--help lists ingest when the experimental flag is set", async () => {
    const home = tmpDir();
    const run = await runCli(home, ["--help"], ENABLE_INGEST);
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/\bingest\b/);
  }, 15000);
});
