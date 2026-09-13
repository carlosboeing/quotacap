import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { Command } from "commander";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { buildSnapshot, projectQuotasResponse } from "../../src/advisory/snapshot.js";
import { sortProviders } from "../../src/format/rows.js";
import { ServiceError, ServiceUnavailable } from "../../src/runtime/client.js";
import { migrate, openDb } from "../../src/store/db.js";
import { upsertQuota } from "../../src/store/quotas.js";
import { recordAttempt } from "../../src/store/attempts.js";
import { registerClientCommands, type ClientCommandDeps } from "../../src/cli/clients.js";
import { OFFLINE_LABEL } from "../../src/cli/snapshot-source.js";
import { VERSION } from "../../src/version.js";
import {
  ENABLED,
  FIXED_NOW,
  RT,
  exampleStateSnapshot,
  exampleStateSnapshotJson,
} from "../fixtures/stable-state.js";
import { seedFileDb, runCli } from "./helpers.js";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qc-status-"));
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

// The example fixture's providers with a shifted clock, so offline process
// runs see fresh readings under wall-clock time.
function buildFreshMemDb(now: Date): any {
  const db = openDb(":memory:");
  migrate(db);
  const iso = (ms: number) => new Date(ms).toISOString();
  const T = now.getTime();
  const Q = (q: any) => upsertQuota(db, { plan: "p", source: "cli", ...q });
  Q({ provider: "kimi", usedPct: 22, resetsAt: iso(T + 7 * DAY), periodStart: iso(T - 7 * DAY), fetchedAt: iso(T) });
  Q({ provider: "claude", usedPct: 40, sessionPct: 22, resetsAt: iso(T + 7 * DAY), periodStart: iso(T - 7 * DAY), fetchedAt: iso(T) });
  Q({ provider: "grok", usedPct: 30, resetsAt: "not-a-date", periodStart: iso(T - 7 * DAY), fetchedAt: iso(T) });
  Q({ provider: "codex", usedPct: 40, resetsAt: iso(T + 7 * DAY), periodStart: iso(T - 7 * DAY), fetchedAt: iso(T), resetsAtEstimated: true });
  Q({ provider: "my-plan", usedPct: 12, resetsAt: iso(T + 7 * DAY), periodStart: iso(T - 7 * DAY), fetchedAt: iso(T), source: "manual" });
  Q({ provider: "agy", usedPct: 50, resetsAt: iso(T + 7 * DAY), periodStart: iso(T), fetchedAt: iso(T) });
  Q({ provider: "agy:3p", usedPct: 60, resetsAt: iso(T + 7 * DAY), periodStart: iso(T - 7 * DAY), fetchedAt: iso(T - 3 * HOUR) });
  for (const p of ["kimi", "claude", "codex", "my-plan", "agy"]) {
    recordAttempt(db, {
      provider: p,
      attemptedAt: iso(T),
      completedAt: iso(T),
      succeededAt: iso(T),
      success: true,
      failureCategory: null,
    });
  }
  recordAttempt(db, {
    provider: "manual",
    attemptedAt: iso(T),
    completedAt: iso(T),
    succeededAt: null,
    success: true,
    failureCategory: "skipped",
  });
  return db;
}

describe("status process", () => {
  it("--json online is exactly the shared projection with old row keys byte-identical", async () => {
    const stub = await startStub({
      "/api/state": (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(exampleStateSnapshotJson);
      },
    });
    try {
      const home = tmpDir();
      writeConfig(home, stub.port);
      const run = await runCli(home, ["status", "--json"]);
      expect(run.code).toBe(0);
      expect(run.stderr).toBe("");
      const rows = JSON.parse(run.stdout);
      expect(rows).toEqual(projectQuotasResponse(exampleStateSnapshot));
      const servedById = new Map(exampleStateSnapshot.providers.map((p) => [p.id, p.quota]));
      for (const row of rows) {
        for (const k of ["provider", "plan", "usedPct", "resetsAt", "periodStart", "source", "fetchedAt"]) {
          expect(row[k]).toEqual((servedById.get(row.provider) as any)[k]);
        }
      }
    } finally {
      await stub.close();
    }
  }, 15000);

  it("--json offline prints the same array with the offline label on stderr", async () => {
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
      const online = await runCli(home, ["status", "--json"]);
      expect(online.code).toBe(0);
      expect(online.stderr).toBe("");
      seedFileDb(path.join(home, ".quotacap", "quotacap.db"), () => mem);
      writeConfig(home, await closedPort());
      const offline = await runCli(home, ["status", "--json"]);
      expect(offline.code).toBe(0);
      expect(offline.stderr).toContain(OFFLINE_LABEL);
      expect(offline.stdout).not.toContain("offline");
      // ageMs is wall-clock volatile (Task 2 proves fixed-clock identity);
      // every other key must match the online array exactly.
      const normalize = (rows: any[]) =>
        rows.map((r) => {
          expect(typeof r.ageMs === "number" || r.ageMs === null).toBe(true);
          const { ageMs: _ageMs, ...rest } = r;
          return rest;
        });
      expect(normalize(JSON.parse(offline.stdout))).toEqual(normalize(JSON.parse(online.stdout)));
    } finally {
      await stub.close();
    }
  }, 15000);

  it("piped human output is wide without ANSI", async () => {
    const stub = await startStub({
      "/api/state": (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(exampleStateSnapshotJson);
      },
    });
    try {
      const home = tmpDir();
      writeConfig(home, stub.port);
      const run = await runCli(home, ["status"]);
      expect(run.code).toBe(0);
      expect(run.stdout).not.toContain("\x1b[");
      expect(run.stdout).toContain("PROVIDER");
      expect(run.stdout).toContain("FORECAST");
      for (const name of ["my-plan", "Kimi", "Claude", "Codex", "Antigravity", "Grok"]) {
        expect(run.stdout).toContain(name);
      }
    } finally {
      await stub.close();
    }
  }, 15000);

  it("--ascii uses ASCII glyphs without ANSI", async () => {
    const stub = await startStub({
      "/api/state": (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(exampleStateSnapshotJson);
      },
    });
    try {
      const home = tmpDir();
      writeConfig(home, stub.port);
      const run = await runCli(home, ["status", "--ascii"]);
      expect(run.code).toBe(0);
      expect(run.stdout).not.toContain("\x1b[");
      expect(run.stdout).not.toMatch(/[█│░★]/);
      expect(run.stdout).toContain("#");
      expect(run.stdout).toContain("|");
      expect(run.stdout).toContain(":");
    } finally {
      await stub.close();
    }
  }, 15000);

  it.each(["recommended", "reset-asc", "reset-desc", "used-desc", "used-asc"] as const)(
    "--sort %s orders rows like the shared sorter",
    async (key) => {
      const stub = await startStub({
        "/api/state": (_req, res) => {
          res.setHeader("content-type", "application/json");
          res.end(exampleStateSnapshotJson);
        },
      });
      try {
        const home = tmpDir();
        writeConfig(home, stub.port);
        const run = await runCli(home, ["status", "--sort", key]);
        expect(run.code).toBe(0);
        const nameById = new Map(exampleStateSnapshot.providers.map((p) => [p.id, p.displayName]));
        const expected = sortProviders(
          exampleStateSnapshot.providers,
          key,
          exampleStateSnapshot.recommendation.use,
        ).map((p) => nameById.get(p.id)!);
        let at = -1;
        for (const name of expected) {
          const next = run.stdout.indexOf(name, at + 1);
          expect(next).toBeGreaterThan(at);
          at = next;
        }
      } finally {
        await stub.close();
      }
    },
    15000,
  );

  it("invalid --sort exits 1 before any I/O", async () => {
    const home = tmpDir();
    writeConfig(home, await closedPort());
    const dbPath = path.join(home, ".quotacap", "quotacap.db");
    const run = await runCli(home, ["status", "--sort", "bogus"]);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/invalid-argument/);
    expect(fs.existsSync(dbPath)).toBe(false);
  }, 15000);

  it("--compact prints the exact statusline, ASCII-only", async () => {
    const stub = await startStub({
      "/api/state": (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(exampleStateSnapshotJson);
      },
    });
    try {
      const home = tmpDir();
      writeConfig(home, stub.port);
      const run = await runCli(home, ["status", "--compact"]);
      expect(run.code).toBe(0);
      expect(run.stdout).toBe(
        "[my-plan:12%~] | [kimi:22%~] | [claude:40%~] | [codex:40%~] | [agy:50%?] | [agy:3p:60%?] | [grok:30%?]  (use: my-plan)\n",
      );
      for (const ch of run.stdout) expect(ch.charCodeAt(0)).toBeLessThan(128);
    } finally {
      await stub.close();
    }
  }, 15000);

  it("no-data exits 0 with the start-service hint and creates nothing", async () => {
    const home = tmpDir();
    writeConfig(home, await closedPort());
    const dbPath = path.join(home, ".quotacap", "quotacap.db");
    const run = await runCli(home, ["status"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/no quotas yet/);
    expect(run.stdout).toMatch(/quotacap web/);
    expect(run.stdout).not.toMatch(/quotacap ingest/);
    expect(fs.existsSync(dbPath)).toBe(false);
    const json = await runCli(home, ["status", "--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual([]);
    const compact = await runCli(home, ["status", "--compact"]);
    expect(compact.code).toBe(0);
    expect(compact.stdout).toBe("(use: none)\n");
  }, 15000);

  it("service 500 exits 1 with service-error and no fallback", async () => {
    const home = tmpDir();
    seedFileDb(path.join(home, ".quotacap", "quotacap.db"));
    const stub = await startStub({
      "/api/state": (_req, res) => {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: "boom" }));
      },
    });
    try {
      writeConfig(home, stub.port);
      const run = await runCli(home, ["status"]);
      expect(run.code).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toMatch(/service-error/);
    } finally {
      await stub.close();
    }
  }, 15000);
});

describe("status wiring", () => {
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
        throw new Error("status must not call client.post");
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

  it("renders the fixed-clock wide table through the real wiring", async () => {
    await runWired(["status"], onlineDeps());
    expect(exitCode).toBeUndefined();
    expect(errors).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("PROVIDER");
    expect(logs[0]).toContain("76% waste in 7.0d");
    expect(logs[0]).toContain("★ my-plan");
  });

  it("selects narrow below 100 columns on a TTY", async () => {
    await runWired(["status"], onlineDeps({ resolveWidth: () => ({ columns: 80, tty: true }) }));
    expect(logs).toHaveLength(1);
    expect(logs[0].split("\n")).toHaveLength(2 * exampleStateSnapshot.providers.length);
    expect(logs[0]).toContain("resets 7d");
    expect(logs[0]).toContain("\x1b[");
  });

  it("disables ANSI for NO_COLOR and --ascii on a TTY", async () => {
    process.env.NO_COLOR = "1";
    try {
      await runWired(["status"], onlineDeps({ resolveWidth: () => ({ columns: 120, tty: true }) }));
    } finally {
      delete process.env.NO_COLOR;
    }
    expect(logs[0]).not.toContain("\x1b[");
    expect(logs[0]).toContain("█");
    logs = [];
    await runWired(["status", "--ascii"], onlineDeps({ resolveWidth: () => ({ columns: 120, tty: true }) }));
    expect(logs[0]).not.toContain("\x1b[");
    expect(logs[0]).not.toContain("█");
    expect(logs[0]).toContain("#");
  });

  it("falls back offline with the stderr label and exact fixed-clock output", async () => {
    seedFileDb(path.join(home, ".quotacap", "quotacap.db"));
    const deps = onlineDeps({
      createClient: () => ({
        get: async () => {
          throw new ServiceUnavailable("down");
        },
        post: async () => {
          throw new ServiceUnavailable("down");
        },
      }),
      openDb: undefined,
    });
    await runWired(["status", "--json"], deps);
    expect(errors).toEqual([OFFLINE_LABEL]);
    expect(JSON.parse(logs[0])).toEqual(projectQuotasResponse(exampleStateSnapshot));
    logs = [];
    errors = [];
    await runWired(["status", "--compact"], deps);
    expect(errors).toEqual([OFFLINE_LABEL]);
    expect(logs[0]).toBe(
      "[my-plan:12%~] | [kimi:22%~] | [claude:40%~] | [codex:40%~] | [agy:50%?] | [agy:3p:60%?] | [grok:30%?]  (use: my-plan)",
    );
  });

  it("rejects invalid --sort without touching client creation", async () => {
    const createClient = vi.fn(() => {
      throw new Error("must not create client");
    });
    await runWired(["status", "--sort", "bogus"], onlineDeps({ createClient: createClient as never }));
    expect(exitCode).toBe(1);
    expect(createClient).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/invalid-argument/);
  });

  it("reports live-service failures with exit 1", async () => {
    await runWired(
      ["status"],
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
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/service-error/);
  });

  it("warns on exec-only skew and still renders online", async () => {
    await runWired(
      ["status"],
      onlineDeps({
        createClient: () => ({
          get: async (p: string) =>
            p === "/health"
              ? { ok: true, version: VERSION, exec: "/other/q" }
              : servedState(),
          post: async () => {
            throw new Error("unused");
          },
        }),
      }),
    );
    expect(exitCode).toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("/other/q");
    expect(errors[0]).toContain("versions match");
  });

  it("warns on older CLI and still renders online", async () => {
    await runWired(
      ["status"],
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
    expect(exitCode).toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("daemon is newer (99.0.0)");
  });

  it("takes the managed path when newer, then renders online", async () => {
    let version = "0.0.0-stale";
    const restarts: string[][] = [];
    await runWired(
      ["status"],
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
      ["status"],
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

  it("prints the update footer on TTY stderr only, never under --json or piped", async () => {
    const stale = {
      checkedAt: new Date().toISOString(),
      latest: "99.0.0",
      channel: "standalone",
      current: VERSION,
    };
    const footer = `Update available: ${VERSION} -> 99.0.0. Run 'quotacap update' to upgrade.`;
    const desc = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    const reset = () => {
      logs.length = 0;
      errors.length = 0;
      exitCode = undefined;
    };
    try {
      Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
      await runWired(["status"], onlineDeps({ checkUpdates: async () => stale }));
      expect(errors).toEqual([`quotacap ${VERSION}`, footer]);
      reset();
      await runWired(["status", "--json"], onlineDeps({ checkUpdates: async () => stale }));
      expect(errors).toEqual([]);
      reset();
      Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
      await runWired(["status"], onlineDeps({ checkUpdates: async () => stale }));
      expect(errors).toEqual([]);
    } finally {
      if (desc) Object.defineProperty(process.stderr, "isTTY", desc);
    }
  });

  it("prints the version line on TTY stderr, with the daemon when it differs", async () => {
    const desc = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    try {
      Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
      await runWired(["status"], onlineDeps());
      expect(errors).toEqual([`quotacap ${VERSION}`]);
      logs.length = 0;
      errors.length = 0;
      await runWired(
        ["status"],
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
      logs.length = 0;
      errors.length = 0;
      await runWired(["status", "--compact"], onlineDeps());
      expect(errors).toEqual([]);
    } finally {
      if (desc) Object.defineProperty(process.stderr, "isTTY", desc);
    }
  });

  describe("status --verbose with provider diagnostics", () => {
    const failedServedState = () => {
      const s = JSON.parse(exampleStateSnapshotJson);
      const codex = s.providers.find((p: any) => p.id === "codex");
      codex.reporting = false;
      codex.exclusionReason = "provider-failed";
      codex.lastAttempt = {
        provider: "codex",
        attemptedAt: FIXED_NOW.toISOString(),
        completedAt: FIXED_NOW.toISOString(),
        succeededAt: null,
        success: false,
        failureCategory: "unknown",
        diagnosticCode: "terminal_error",
        summary: "Unable to open Codex session",
        action: "Open Codex directly in your terminal to check whether it starts.",
        errorDetail: "pty exited during settle (code 1): stdin is not a terminal",
      };
      return s;
    };

    const failedDeps = (stateOverride?: any, clientDeps?: Partial<ClientCommandDeps>) =>
      onlineDeps({
        createClient: () => ({
          get: async () => stateOverride ?? failedServedState(),
          post: async () => {
            throw new Error("status must not call client.post");
          },
        }),
        ...clientDeps,
      });

    it("does not render issues in normal wide mode without --verbose", async () => {
      await runWired(["status"], failedDeps());
      expect(exitCode).toBeUndefined();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("Unable to open Codex session");
      expect(logs[0]).not.toContain("Adapter issues:");
    });

    it("does not render issues in narrow mode without --verbose", async () => {
      await runWired(["status"], failedDeps(undefined, { resolveWidth: () => ({ columns: 80, tty: true }) }));
      expect(exitCode).toBeUndefined();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("Unable to open Codex session");
      expect(logs[0]).not.toContain("Adapter issues:");
    });

    it("renders bullet issues with a blank line separator under --verbose in wide mode", async () => {
      await runWired(["status", "--verbose"], failedDeps());
      expect(exitCode).toBeUndefined();
      expect(logs).toHaveLength(2);
      expect(logs[0]).toContain("PROVIDER");
      expect(logs[0]).toContain("Unable to open Codex session");
      expect(logs[1]).toBe(
        "\nAdapter issues:\n• codex: Unable to open Codex session\n  Action: Open Codex directly in your terminal to check whether it starts.\n  Detail: pty exited during settle (code 1): stdin is not a terminal",
      );
    });

    it("renders hyphen marker under --verbose and --ascii", async () => {
      await runWired(["status", "--verbose", "--ascii"], failedDeps());
      expect(exitCode).toBeUndefined();
      expect(logs).toHaveLength(2);
      expect(logs[1]).toBe(
        "\nAdapter issues:\n- codex: Unable to open Codex session\n  Action: Open Codex directly in your terminal to check whether it starts.\n  Detail: pty exited during settle (code 1): stdin is not a terminal",
      );
    });

    it("does not render issues under --verbose with --json", async () => {
      await runWired(["status", "--verbose", "--json"], failedDeps());
      expect(exitCode).toBeUndefined();
      expect(logs).toHaveLength(1);
      const parsed = JSON.parse(logs[0]);
      expect(Array.isArray(parsed)).toBe(true);
      expect(logs[0]).not.toContain("Adapter issues:");
    });

    it("does not render issues under --verbose with --compact", async () => {
      await runWired(["status", "--verbose", "--compact"], failedDeps());
      expect(exitCode).toBeUndefined();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("[codex:");
      expect(logs[0]).not.toContain("Adapter issues:");
    });

    it("does not render issues under --verbose when failed provider is disabled", async () => {
      const state = failedServedState();
      state.providers.find((p: any) => p.id === "codex").enabled = false;
      await runWired(["status", "--verbose"], failedDeps(state));
      expect(exitCode).toBeUndefined();
      expect(logs).toHaveLength(1);
      expect(logs[0]).not.toContain("Adapter issues:");
    });

    it("does not render issues under --verbose when there are no failures", async () => {
      await runWired(["status", "--verbose"], onlineDeps());
      expect(exitCode).toBeUndefined();
      expect(logs).toHaveLength(1);
      expect(logs[0]).not.toContain("Adapter issues:");
    });

    it("renders fallback wording for legacy failed attempt without diagnostic fields under --verbose", async () => {
      const state = JSON.parse(exampleStateSnapshotJson);
      const kimi = state.providers.find((p: any) => p.id === "kimi");
      kimi.reporting = false;
      kimi.exclusionReason = "provider-failed";
      kimi.lastAttempt = {
        provider: "kimi",
        attemptedAt: FIXED_NOW.toISOString(),
        completedAt: FIXED_NOW.toISOString(),
        succeededAt: null,
        success: false,
        failureCategory: "auth",
      };
      await runWired(["status", "--verbose"], failedDeps(state));
      expect(exitCode).toBeUndefined();
      expect(logs).toHaveLength(2);
      expect(logs[1]).toBe(
        "\nAdapter issues:\n• kimi: provider failed (auth)\n  Detail: No diagnostic detail was recorded for this attempt.",
      );
    });
  });
});
