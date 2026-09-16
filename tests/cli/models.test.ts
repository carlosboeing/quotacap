import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerModelsCommand } from "../../src/cli/models.js";
import { CATALOG_CLIENT_TIMEOUT_MS } from "../../src/catalog/index.js";
import { openDb, migrate } from "../../src/store/db.js";
import { upsertCatalog } from "../../src/store/catalogs.js";
import { upsertQuota } from "../../src/store/quotas.js";
import { OFFLINE_LABEL } from "../../src/cli/snapshot-source.js";
import { ensureConfig, writeConfig } from "../../src/config.js";

let tmpHome = "";
const oldQcHome = process.env.QUOTACAP_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "qc-models-test-"));
  process.env.QUOTACAP_HOME = tmpHome;
});

afterEach(() => {
  process.env.QUOTACAP_HOME = oldQcHome;
  if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  tmpHome = "";
  vi.restoreAllMocks();
});

function createMockProgram(deps: any = {}) {
  const program = new Command();
  program.exitOverride();
  registerModelsCommand(program, deps);
  return program;
}

describe("CLI quotacap models", () => {
  const sampleModels = [
    {
      id: "claude",
      displayName: "Claude",
      harness: "Claude Code",
      vendor: "Anthropic",
      leftoverPct: 75,
      resetsAt: "2026-09-20T00:00:00Z",
      catalog: {
        status: "ok",
        fetchedAt: "2026-09-16T10:00:00Z",
        listed: [
          { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", default: true },
          { id: "claude-opus-4-6", displayName: "Claude Opus 4.6" },
        ],
      },
    },
  ];

  it("calls client GET /api/models with CATALOG_CLIENT_TIMEOUT_MS and prints table", async () => {
    let requestedUrl = "";
    let clientTimeout = 0;
    const mockClient = {
      get: async (url: string) => {
        requestedUrl = url;
        return sampleModels;
      },
      post: async () => {},
    };

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => logs.push(msg));

    const program = createMockProgram({
      createClient: (opts: any) => {
        clientTimeout = opts.timeoutMs;
        return mockClient;
      },
    });

    await program.parseAsync(["node", "quotacap", "models"]);

    expect(requestedUrl).toBe("/api/models");
    expect(clientTimeout).toBe(CATALOG_CLIENT_TIMEOUT_MS);
    expect(clientTimeout).toBe(30000);

    const output = logs.join("\n");
    expect(output).toContain("PROVIDER");
    expect(output).toContain("LEFTOVER");
    expect(output).toContain("STATUS");
    expect(output).toContain("MODELS");
    expect(output).toContain("Claude");
    expect(output).toContain("75%");
    expect(output).toContain("ok");
    expect(output).toContain("claude-sonnet-4-6, claude-opus-4-6");
  });

  it("outputs JSON with --json", async () => {
    const mockClient = {
      get: async () => sampleModels,
      post: async () => {},
    };

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => logs.push(msg));

    const program = createMockProgram({
      createClient: () => mockClient,
    });

    await program.parseAsync(["node", "quotacap", "models", "--json"]);

    expect(JSON.parse(logs[0])).toEqual(sampleModels);
  });

  it("passes ?provider= filter when --provider is used", async () => {
    let requestedUrl = "";
    const mockClient = {
      get: async (url: string) => {
        requestedUrl = url;
        return sampleModels;
      },
      post: async () => {},
    };

    const program = createMockProgram({
      createClient: () => mockClient,
    });

    await program.parseAsync(["node", "quotacap", "models", "--provider", "claude"]);
    expect(requestedUrl).toBe("/api/models?provider=claude");
  });

  it("calls POST /api/models/refresh when --refresh is used", async () => {
    let requestedUrl = "";
    const mockClient = {
      get: async () => {},
      post: async (url: string) => {
        requestedUrl = url;
        return { cooldown: false, models: sampleModels };
      },
    };

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => logs.push(msg));

    const program = createMockProgram({
      createClient: () => mockClient,
    });

    await program.parseAsync(["node", "quotacap", "models", "--refresh"]);
    expect(requestedUrl).toBe("/api/models/refresh");
    expect(logs.join("\n")).toContain("Claude");
  });

  it("offline fallback with unreachable daemon: runs in-process wait:true ensureCatalogs and logs OFFLINE_LABEL", async () => {
    const { config: cfg } = await ensureConfig();
    cfg.enabledProviders = ["fake"];
    await writeConfig(cfg);

    const db = openDb(":memory:"); migrate(db);
    upsertCatalog(db, "fake", [{ id: "m-offline", displayName: "Offline Model" }], new Date().toISOString());
    upsertQuota(db, {
      provider: "fake",
      plan: "pro",
      usedPct: 10,
      resetsAt: new Date().toISOString(),
      periodStart: new Date().toISOString(),
      source: "cli",
      fetchedAt: new Date().toISOString(),
    });

    // Client that fails transport
    const failingClient = {
      get: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8787");
      },
      post: async () => {},
    };

    const stderr: string[] = [];
    const stdout: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg) => stderr.push(msg));
    vi.spyOn(console, "log").mockImplementation((msg) => stdout.push(msg));

    const program = createMockProgram({
      createClient: () => failingClient,
      openDb: () => db,
    });

    await program.parseAsync(["node", "quotacap", "models"]);

    expect(stderr).toContain(OFFLINE_LABEL);
    const output = stdout.join("\n");
    expect(output).toContain("fake");
    expect(output).toContain("90%");
    expect(output).toContain("m-offline");
  });

  it("offline mode rejects unknown provider", async () => {
    const db = openDb(":memory:"); migrate(db);
    const failingClient = {
      get: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8787");
      },
      post: async () => {},
    };

    const stderr: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg) => stderr.push(msg));
    let exitCode = 0;
    const exit = (code: number) => {
      exitCode = code;
      throw new Error(`exit ${code}`);
    };

    const program = createMockProgram({
      createClient: () => failingClient,
      openDb: () => db,
      exit,
    });

    await expect(
      program.parseAsync(["node", "quotacap", "models", "--provider", "unknown-bogus"]),
    ).rejects.toThrow();

    expect(exitCode).toBe(1);
    expect(stderr.join("\n")).toContain("unknown provider: unknown-bogus");
  });

  it("calls POST /api/models/refresh?provider=claude when --refresh --provider claude is used and passes token", async () => {
    let requestedUrl = "";
    let clientToken: string | undefined;
    const mockClient = {
      get: async () => {},
      post: async (url: string) => {
        requestedUrl = url;
        return { cooldown: false, models: sampleModels };
      },
    };

    const program = createMockProgram({
      createClient: (opts: any) => {
        clientToken = opts.token;
        return mockClient;
      },
      takeoverOpts: {
        readToken: () => "test-token",
      },
    });

    await program.parseAsync(["node", "quotacap", "models", "--refresh", "--provider", "claude"]);
    expect(requestedUrl).toBe("/api/models/refresh?provider=claude");
    expect(clientToken).toBe("test-token");
  });

  it("offline fallback migrates database so model_catalogs exists before upsert", async () => {
    const { config: cfg } = await ensureConfig();
    cfg.enabledProviders = ["fake"];
    await writeConfig(cfg);

    const db = openDb(":memory:");
    const failingClient = {
      get: async () => { throw new Error("offline"); },
      post: async () => {},
    };
    const program = createMockProgram({
      createClient: () => failingClient,
      openDb: () => db,
    });
    await program.parseAsync(["node", "quotacap", "models"]);
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='model_catalogs'").get();
    expect(table).toBeDefined();
  });
});
