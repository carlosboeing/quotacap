import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerProvidersCommand } from "../../src/cli/providers.js";
import { ServiceError, ServiceUnavailable, type ServiceClient } from "../../src/runtime/client.js";
import { readConfig, writeConfig } from "../../src/config.js";

let tmpHome = "";
const oldQcHome = process.env.QUOTACAP_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "qc-prov-test-"));
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
  registerProvidersCommand(program, deps);
  return program;
}

describe("CLI quotacap providers list", () => {
  it("prints provider list with ID, BUILT-IN, and EFFECTIVE columns", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => logs.push(msg));

    const program = createMockProgram();
    await program.parseAsync(["node", "quotacap", "providers", "list"]);

    const output = logs.join("\n");
    expect(output).toContain("ID");
    expect(output).toContain("BUILT-IN");
    expect(output).toContain("EFFECTIVE");
    expect(output).toContain("claude");
    expect(output).toContain("Claude");
    expect(output).toContain("muse");
    expect(output).toContain("Muse");
  });

  it("reflects active overrides and unregistered ids in the list", async () => {
    const cfg = await readConfig();
    cfg.providerNames = {
      muse: "Work Muse",
      "custom-bot": "My Local Bot",
    };
    await writeConfig(cfg);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => logs.push(msg));

    const program = createMockProgram();
    await program.parseAsync(["node", "quotacap", "providers", "list"]);

    const output = logs.join("\n");
    expect(output).toContain("muse");
    expect(output).toContain("Work Muse");
    expect(output).toContain("custom-bot");
    expect(output).toContain("My Local Bot");
  });
});

describe("CLI quotacap providers rename", () => {
  it("renames via PATCH when service is online", async () => {
    const patched: Array<{ path: string; body: any }> = [];
    const mockClient: ServiceClient = {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn().mockImplementation(async (path, body) => {
        patched.push({ path, body });
        return { ok: true, id: "muse", displayName: body.displayName };
      }),
    };

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => logs.push(msg));

    const program = createMockProgram({
      createClient: () => mockClient,
    });

    await program.parseAsync(["node", "quotacap", "providers", "rename", "muse", "Work Muse"]);

    expect(mockClient.patch).toHaveBeenCalledWith("/api/providers/muse", { displayName: "Work Muse" });
    expect(logs.join("\n")).toContain("renamed muse to \"Work Muse\"");
  });

  it("falls back to local config when service is offline", async () => {
    const mockClient: ServiceClient = {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn().mockRejectedValue(new ServiceUnavailable("daemon down")),
    };

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => logs.push(msg));

    const program = createMockProgram({
      createClient: () => mockClient,
    });

    await program.parseAsync(["node", "quotacap", "providers", "rename", "agy:3p", "Google 3P"]);

    const cfg = await readConfig();
    expect(cfg.providerNames["agy:3p"]).toBe("Google 3P");
    expect(logs.join("\n")).toContain("renamed agy:3p to \"Google 3P\"");
  });

  it("rejects invalid display name with error and exits 1", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg) => errors.push(msg));
    const exitMock = vi.fn();

    const program = createMockProgram({
      exit: exitMock,
    });

    try {
      await program.parseAsync(["node", "quotacap", "providers", "rename", "claude", "\x1b[31mRed\x1b[0m"]);
    } catch {
      // Commander exitOverride
    }

    expect(exitMock).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toMatch(/control character|ANSI/i);
  });
});

describe("CLI quotacap providers reset", () => {
  it("resets single provider override via PATCH online", async () => {
    const mockClient: ServiceClient = {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn().mockResolvedValue({ ok: true, id: "muse", displayName: null }),
    };

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => logs.push(msg));

    const program = createMockProgram({
      createClient: () => mockClient,
    });

    await program.parseAsync(["node", "quotacap", "providers", "reset", "muse"]);

    expect(mockClient.patch).toHaveBeenCalledWith("/api/providers/muse", { displayName: null });
    expect(logs.join("\n")).toContain("reset display name for muse");
  });

  it("resets single provider override in config offline", async () => {
    const cfg = await readConfig();
    cfg.providerNames = { muse: "Work Muse", codex: "My Codex" };
    await writeConfig(cfg);

    const mockClient: ServiceClient = {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn().mockRejectedValue(new ServiceUnavailable("daemon down")),
    };

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => logs.push(msg));

    const program = createMockProgram({
      createClient: () => mockClient,
    });

    await program.parseAsync(["node", "quotacap", "providers", "reset", "muse"]);

    const updated = await readConfig();
    expect(updated.providerNames.muse).toBeUndefined();
    expect(updated.providerNames.codex).toBe("My Codex");
    expect(logs.join("\n")).toContain("reset display name for muse");
  });

  it("resets all provider overrides with --all", async () => {
    const cfg = await readConfig();
    cfg.providerNames = { muse: "Work Muse", codex: "My Codex" };
    await writeConfig(cfg);

    const mockClient: ServiceClient = {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn().mockResolvedValue({ ok: true }),
    };

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => logs.push(msg));

    const program = createMockProgram({
      createClient: () => mockClient,
    });

    await program.parseAsync(["node", "quotacap", "providers", "reset", "--all"]);

    const updated = await readConfig();
    expect(updated.providerNames).toEqual({});
    expect(logs.join("\n")).toContain("reset all provider display name overrides");
  });

  it("errors and exits 1 if neither id nor --all is provided", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg) => errors.push(msg));
    const exitMock = vi.fn();

    const program = createMockProgram({
      exit: exitMock,
    });

    try {
      await program.parseAsync(["node", "quotacap", "providers", "reset"]);
    } catch {}

    expect(exitMock).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toContain("specify a provider id or --all");
  });
});
