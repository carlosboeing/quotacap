import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { Command } from "commander";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { buildSnapshot, projectRecommendationResponse } from "../../src/advisory/snapshot.js";
import { ServiceError, ServiceUnavailable } from "../../src/runtime/client.js";
import { migrate, openDb } from "../../src/store/db.js";
import { upsertQuota } from "../../src/store/quotas.js";
import { recordAttempt } from "../../src/store/attempts.js";
import { registerClientCommands, type ClientCommandDeps } from "../../src/cli/clients.js";
import { OFFLINE_LABEL } from "../../src/cli/snapshot-source.js";
import { VERSION } from "../../src/version.js";
import { ENABLED, FIXED_NOW, RT, exampleStateSnapshot, exampleStateSnapshotJson } from "../fixtures/stable-state.js";
import { seedFileDb, runCli } from "./helpers.js";

const DAY = 24 * 3600_000;

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qc-advise-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeConfig(home: string, port: number): void {
  const dir = path.join(home, ".quotacap");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ port }));
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

async function startStub(routes: Record<string, Handler>): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const handler = routes[req.url ?? ""];
    if (handler) handler(req, res);
    else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

async function closedPort(): Promise<number> {
  const stub = await startStub({});
  const { port } = stub;
  await stub.close();
  return port;
}

function buildFreshMemDb(now: Date): any {
  const db = openDb(":memory:");
  migrate(db);
  const iso = (ms: number) => new Date(ms).toISOString();
  const T = now.getTime();
  const Q = (q: any) => upsertQuota(db, { plan: "p", source: "cli", ...q });
  Q({ provider: "kimi", usedPct: 22, resetsAt: iso(T + 7 * DAY), periodStart: iso(T - 7 * DAY), fetchedAt: iso(T) });
  Q({ provider: "my-plan", usedPct: 12, resetsAt: iso(T + 7 * DAY), periodStart: iso(T - 7 * DAY), fetchedAt: iso(T), source: "manual" });
  for (const p of ["kimi", "my-plan"]) {
    recordAttempt(db, {
      provider: p,
      attemptedAt: iso(T),
      completedAt: iso(T),
      succeededAt: iso(T),
      success: true,
      failureCategory: null,
    });
  }
  return db;
}

describe("advise process", () => {
  it("--task bogus exits 1 client-side without touching the network", async () => {
    const home = tmpDir();
    writeConfig(home, await closedPort());
    const dbPath = path.join(home, ".quotacap", "quotacap.db");
    const run = await runCli(home, ["advise", "--task", "bogus"]);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/invalid-argument/);
    expect(fs.existsSync(dbPath)).toBe(false);
  }, 15000);

  it("--json online equals the fixture recommendation including its basis", async () => {
    const stub = await startStub({
      "/api/state": (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(exampleStateSnapshotJson);
      },
    });
    try {
      const home = tmpDir();
      writeConfig(home, stub.port);
      const run = await runCli(home, ["advise", "--json"]);
      expect(run.code).toBe(0);
      expect(run.stderr).toBe("");
      const rec = JSON.parse(run.stdout);
      expect(rec).toEqual(exampleStateSnapshot.recommendation);
      expect(rec.recommendationBasis).toBe("known-waste");
      const human = await runCli(home, ["advise"]);
      expect(human.code).toBe(0);
      expect(human.stdout).toBe("my-plan: 76% waste in 7.0d\n");
    } finally {
      await stub.close();
    }
  }, 15000);

  it("--json is identical for any, heavy, and light on the same fixture", async () => {
    const stub = await startStub({
      "/api/state": (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(exampleStateSnapshotJson);
      },
    });
    try {
      const home = tmpDir();
      writeConfig(home, stub.port);
      const outs: string[] = [];
      for (const task of ["any", "heavy", "light"]) {
        const run = await runCli(home, ["advise", "--json", "--task", task]);
        expect(run.code).toBe(0);
        outs.push(run.stdout);
      }
      expect(outs[1]).toBe(outs[0]);
      expect(outs[2]).toBe(outs[0]);
      expect(JSON.parse(outs[0]).recommendationBasis).toBe("known-waste");
    } finally {
      await stub.close();
    }
  }, 15000);

  it("offline matches online with the label on stderr, human keeps use: reason", async () => {
    const T0 = new Date();
    const mem = buildFreshMemDb(T0);
    const served = buildSnapshot(mem, { enabledProviders: ENABLED, now: T0, runtime: RT });
    const stub = await startStub({
      "/api/state": (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(served));
      },
    });
    try {
      const home = tmpDir();
      writeConfig(home, stub.port);
      const online = await runCli(home, ["advise", "--json"]);
      expect(online.code).toBe(0);
      seedFileDb(path.join(home, ".quotacap", "quotacap.db"), () => mem);
      writeConfig(home, await closedPort());
      const offline = await runCli(home, ["advise", "--json"]);
      expect(offline.code).toBe(0);
      expect(offline.stderr).toContain(OFFLINE_LABEL);
      const a = JSON.parse(online.stdout);
      const b = JSON.parse(offline.stdout);
      expect(b.use).toBe(a.use);
      expect(b.recommendationBasis).toBe(a.recommendationBasis);
      expect(b.reason.replace(/[\d.]+/g, "#")).toBe(a.reason.replace(/[\d.]+/g, "#"));
      expect(b.wastePct).toBeCloseTo(a.wastePct, 0);
      const human = await runCli(home, ["advise"]);
      expect(human.code).toBe(0);
      expect(human.stderr).toContain(OFFLINE_LABEL);
      expect(human.stdout).toMatch(/^my-plan: \d+% waste in 7\.0d\n$/);
    } finally {
      await stub.close();
    }
  }, 15000);

  it("no-data prints the none contract with exit 0", async () => {
    const home = tmpDir();
    writeConfig(home, await closedPort());
    const json = await runCli(home, ["advise", "--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({
      use: "none",
      reason: "no quotas yet",
      wastePct: null,
      idealRate: 0,
      recommendationBasis: "none",
      alternatives: [],
      advisories: [],
    });
    const human = await runCli(home, ["advise"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toBe("none: no quotas yet\n");
  }, 15000);

  it("help never claims task-specific ranking", async () => {
    const home = tmpDir();
    const run = await runCli(home, ["advise", "--help"]);
    expect(run.code).toBe(0);
    expect(run.stdout).not.toMatch(/task-specific|ranked|tailored|optimized/i);
    expect(run.stdout).toMatch(/same advice for every task/);
  }, 15000);
});

describe("advise wiring", () => {
  let home: string;
  let savedHome: string | undefined;
  let logs: string[];
  let errors: string[];
  let exitCode: number | undefined;

  const servedState = () => JSON.parse(exampleStateSnapshotJson);
  const onlineDeps = (over: Partial<ClientCommandDeps> = {}): ClientCommandDeps => ({
    createClient: () => ({
      get: async () => servedState(),
      post: async () => {
        throw new Error("unused");
      },
    }),
    openDb: () => {
      throw new Error("must not open db online");
    },
    resolveWidth: () => ({ columns: undefined, tty: false }),
    now: () => FIXED_NOW,
    exit: (code: number) => {
      exitCode = code;
    },
    checkUpdates: async () => null,
    ...over,
  });

  async function runWired(args: string[], deps: ClientCommandDeps): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerClientCommands(program, deps);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    home = tmpDir();
    savedHome = process.env.QUOTACAP_HOME;
    process.env.QUOTACAP_HOME = home;
    logs = [];
    errors = [];
    exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation((...a: any[]) => {
      logs.push(a.join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...a: any[]) => {
      errors.push(a.join(" "));
    });
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.QUOTACAP_HOME;
    else process.env.QUOTACAP_HOME = savedHome;
  });

  it("offline --json is byte-identical to online under a fixed clock", async () => {
    seedFileDb(path.join(home, ".quotacap", "quotacap.db"));
    await runWired(["advise", "--json"], onlineDeps());
    const online = logs[0];
    expect(errors).toEqual([]);
    logs = [];
    errors = [];
    await runWired(
      ["advise", "--json"],
      onlineDeps({
        createClient: () => ({
          get: async () => {
            throw new ServiceUnavailable("down");
          },
          post: async () => {
            throw new ServiceUnavailable("down");
          },
        }),
        openDb: undefined,
      }),
    );
    expect(errors).toEqual([OFFLINE_LABEL]);
    expect(logs[0]).toBe(online);
    expect(JSON.parse(logs[0])).toEqual(projectRecommendationResponse(exampleStateSnapshot, "any"));
  });

  it("rejects invalid tasks before client creation", async () => {
    const createClient = vi.fn(() => {
      throw new Error("must not create client");
    });
    await runWired(["advise", "--task", "bogus"], onlineDeps({ createClient: createClient as never }));
    expect(exitCode).toBe(1);
    expect(createClient).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/invalid-argument/);
  });

  it("reports live-service failures with exit 1", async () => {
    await runWired(
      ["advise"],
      onlineDeps({
        createClient: () => ({
          get: async () => {
            throw new ServiceError(500, "boom");
          },
          post: async () => {
            throw new ServiceError(500, "boom");
          },
        }),
      }),
    );
    expect(exitCode).toBe(1);
    expect(logs).toEqual([]);
    expect(errors[0]).toMatch(/service-error/);
  });

  it("takes the managed path when newer, then advises online", async () => {
    let version = "0.0.0-stale";
    const restarts: string[][] = [];
    await runWired(
      ["advise"],
      onlineDeps({
        createClient: () => ({
          get: async (p: string) =>
            p === "/health"
              ? { ok: true, ready: true, version, exec: "/old/q" }
              : servedState(),
          post: async () => {
            throw new Error("unused");
          },
        }),
        isManaged: async () => true,
        execService: async (args: string[]) => {
          restarts.push(args);
          version = VERSION;
          return 0;
        },
        takeoverOpts: { sleep: async () => {}, timeoutMs: 1000 },
      }),
    );
    expect(restarts).toEqual([["restart"]]);
    expect(exitCode).toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`Upgraded daemon from 0.0.0-stale to ${VERSION} (service restarted)`);
  });

  it("serves stored readings on unmanaged skew instead of failing", async () => {
    seedFileDb(path.join(home, ".quotacap", "quotacap.db"));
    await runWired(
      ["advise"],
      onlineDeps({
        createClient: () => ({
          get: async (p: string) =>
            p === "/health"
              ? { ok: true, ready: true, version: "0.0.0-stale", exec: "/old/q" }
              : servedState(),
          post: async () => {
            throw new Error("unused");
          },
        }),
        isManaged: async () => false,
        openDb: undefined,
      }),
    );
    expect(exitCode).toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(errors).toEqual([
      expect.stringContaining("daemon is older (0.0.0-stale)"),
      OFFLINE_LABEL,
    ]);
  });

  it("prints the update footer on TTY stderr only, never under --json", async () => {
    const stale = {
      checkedAt: new Date().toISOString(),
      latest: "99.0.0",
      channel: "standalone",
      current: VERSION,
    };
    const footer = `Update available: ${VERSION} -> 99.0.0. Run 'quotacap update' to upgrade.`;
    const desc = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    try {
      Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
      await runWired(["advise"], onlineDeps({ checkUpdates: async () => stale }));
      expect(errors).toEqual([`quotacap ${VERSION}`, footer]);
      logs.length = 0;
      errors.length = 0;
      exitCode = undefined;
      await runWired(["advise", "--json"], onlineDeps({ checkUpdates: async () => stale }));
      expect(errors).toEqual([]);
    } finally {
      if (desc) Object.defineProperty(process.stderr, "isTTY", desc);
    }
  });

  it("prints the version line on TTY stderr, with the daemon when it differs", async () => {
    const desc = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    try {
      Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
      await runWired(["advise"], onlineDeps());
      expect(errors).toEqual([`quotacap ${VERSION}`]);
      logs.length = 0;
      errors.length = 0;
      await runWired(
        ["advise"],
        onlineDeps({
          createClient: () => ({
            get: async (p: string) =>
              p === "/health"
                ? { ok: true, version: "99.0.0", exec: "/new/q" }
                : servedState(),
            post: async () => {
              throw new Error("unused");
            },
          }),
        }),
      );
      expect(errors[0]).toContain("daemon is newer (99.0.0)");
      expect(errors[1]).toBe(`quotacap ${VERSION} · daemon 99.0.0`);
    } finally {
      if (desc) Object.defineProperty(process.stderr, "isTTY", desc);
    }
  });
});
