import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerProvidersCommand } from "../../src/cli/providers.js";
import { ServiceError, ServiceUnavailable, type ServiceClient } from "../../src/runtime/client.js";
import { readConfig, writeConfig } from "../../src/config.js";

const { mockCreateInterface } = vi.hoisted(() => ({
  mockCreateInterface: vi.fn(),
}));

vi.mock("node:readline/promises", () => ({
  default: { createInterface: mockCreateInterface },
}));

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

  it("resets all provider overrides via PATCH online with --all", async () => {
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

    expect(mockClient.patch).toHaveBeenCalledWith("/api/providers/muse", { displayName: null });
    expect(mockClient.patch).toHaveBeenCalledWith("/api/providers/codex", { displayName: null });
    expect(logs.join("\n")).toContain("reset all provider display name overrides");
  });

  it("resets all provider overrides in config offline with --all", async () => {
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

    await program.parseAsync(["node", "quotacap", "providers", "reset", "--all"]);

    const updated = await readConfig();
    expect(updated.providerNames).toEqual({});
    expect(logs.join("\n")).toContain("reset all provider display name overrides");
  });

  it("fails and exits 1 without wiping local config if daemon returns ServiceError during reset --all", async () => {
    const cfg = await readConfig();
    cfg.providerNames = { muse: "Work Muse", codex: "My Codex" };
    await writeConfig(cfg);

    const mockClient: ServiceClient = {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn().mockRejectedValue(new ServiceError(500, "daemon failed")),
    };

    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg) => errors.push(msg));
    const exitMock = vi.fn();

    const program = createMockProgram({
      createClient: () => mockClient,
      exit: exitMock,
    });

    await program.parseAsync(["node", "quotacap", "providers", "reset", "--all"]);

    expect(exitMock).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toContain("daemon failed");

    // Local config must NOT be wiped!
    const updated = await readConfig();
    expect(updated.providerNames).toEqual({ muse: "Work Muse", codex: "My Codex" });
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

  it("prints a clean error and exits 1 when config is corrupt during offline rename", async () => {
    const mockClient: ServiceClient = {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn().mockRejectedValue(new ServiceUnavailable("offline")),
    };

    const cfgPath = path.join(tmpHome, ".quotacap", "config.json");
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, "{ malformed json");

    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg) => errors.push(msg));
    const exitMock = vi.fn();

    const program = createMockProgram({
      createClient: () => mockClient,
      exit: exitMock,
    });

    await program.parseAsync(["node", "quotacap", "providers", "rename", "claude", "Work Claude"]);

    expect(exitMock).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toContain("cannot update provider names");
    expect(fs.readFileSync(cfgPath, "utf8")).toBe("{ malformed json");
  });
});

describe("CLI quotacap providers enable", () => {
  it("enables opencode-go via POST with consent when --yes is passed", async () => {
    const mockClient: ServiceClient = {
      get: vi.fn(),
      post: vi.fn().mockResolvedValue({ ok: true, id: "opencode-go", enabled: true, restartRequired: true }),
      patch: vi.fn(),
    };
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => logs.push(msg));

    const program = createMockProgram({ createClient: () => mockClient });
    await program.parseAsync(["node", "quotacap", "providers", "enable", "opencode-go", "--yes"]);

    expect(mockClient.post).toHaveBeenCalledWith("/api/providers/opencode-go/enabled", { enabled: true, consent: true });
    const out = logs.join("\n");
    expect(out).toContain("opencode auth login -p opencode-go");
    expect(out).toContain("enabled opencode-go");
    expect(out).toContain("Next: run quotacap service restart to start polling");
  });

  it("refuses non-TTY enable of opencode-go without --yes after printing the notice", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg) => errors.push(msg));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const exitMock = vi.fn();
    const isTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    const mockClient: ServiceClient = { get: vi.fn(), post: vi.fn(), patch: vi.fn() };
    const program = createMockProgram({ createClient: () => mockClient, exit: exitMock });
    try {
      await program.parseAsync(["node", "quotacap", "providers", "enable", "opencode-go"]);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: isTTY, configurable: true });
    }

    expect(exitMock).toHaveBeenCalledWith(1);
    expect(mockClient.post).not.toHaveBeenCalled();
    expect(errors.join("\n")).toMatch(/--yes/);
  });

  it("rejects an unregistered id with exit 1", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg) => errors.push(msg));
    const exitMock = vi.fn();
    const program = createMockProgram({ exit: exitMock });
    try {
      await program.parseAsync(["node", "quotacap", "providers", "enable", "nope"]);
    } catch {}
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toMatch(/unknown provider/i);
  });

  it("falls back to a config write when the daemon is offline", async () => {
    const mockClient: ServiceClient = {
      get: vi.fn(),
      post: vi.fn().mockRejectedValue(new ServiceUnavailable("daemon down")),
      patch: vi.fn(),
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createMockProgram({ createClient: () => mockClient });
    await program.parseAsync(["node", "quotacap", "providers", "enable", "opencode-go", "--yes"]);

    const cfg = await readConfig();
    expect(cfg.enabledProviders).toContain("opencode-go");
    expect(typeof cfg.opencodeGoConsentAt).toBe("string");
  });

  it("refuses opencode-go enable against a pre-route daemon instead of writing brick config", async () => {
    const mockClient: ServiceClient = {
      get: vi.fn(),
      post: vi.fn().mockRejectedValue(new ServiceError(404, "not found")),
      patch: vi.fn(),
    };
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg) => errors.push(msg));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const exitMock = vi.fn();

    const program = createMockProgram({ createClient: () => mockClient, exit: exitMock });
    await program.parseAsync(["node", "quotacap", "providers", "enable", "opencode-go", "--yes"]);

    expect(exitMock).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toMatch(/predates OpenCode Go|quotacap update/);
    const cfg = await readConfig();
    expect(cfg.enabledProviders).not.toContain("opencode-go");
    expect(cfg.opencodeGoConsentAt).toBeNull();
  });

  it("still falls back to a config write for known ids on 404", async () => {
    const mockClient: ServiceClient = {
      get: vi.fn(),
      post: vi.fn().mockRejectedValue(new ServiceError(404, "not found")),
      patch: vi.fn(),
    };
    const warns: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((msg) => warns.push(msg));
    vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createMockProgram({ createClient: () => mockClient });
    await program.parseAsync(["node", "quotacap", "providers", "enable", "claude", "--yes"]);

    const cfg = await readConfig();
    expect(cfg.enabledProviders).toContain("claude");
    expect(warns.join("\n")).toMatch(/version skew/);
  });
});

describe("CLI quotacap providers disable", () => {
  it("disables via POST and reports it", async () => {
    const mockClient: ServiceClient = {
      get: vi.fn(),
      post: vi.fn().mockResolvedValue({ ok: true, id: "opencode-go", enabled: false, restartRequired: true }),
      patch: vi.fn(),
    };
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => logs.push(msg));

    const program = createMockProgram({ createClient: () => mockClient });
    await program.parseAsync(["node", "quotacap", "providers", "disable", "opencode-go"]);

    expect(mockClient.post).toHaveBeenCalledWith("/api/providers/opencode-go/enabled", { enabled: false });
    expect(logs.join("\n")).toContain("disabled opencode-go");
  });

  it("falls back to a config write offline and revokes consent", async () => {
    const cfg = await readConfig();
    cfg.enabledProviders = ["claude", "opencode-go"];
    cfg.opencodeGoConsentAt = "2026-09-17T00:00:00Z";
    await writeConfig(cfg);
    const mockClient: ServiceClient = {
      get: vi.fn(),
      post: vi.fn().mockRejectedValue(new ServiceUnavailable("daemon down")),
      patch: vi.fn(),
    };
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const program = createMockProgram({ createClient: () => mockClient });
    await program.parseAsync(["node", "quotacap", "providers", "disable", "opencode-go"]);

    const updated = await readConfig();
    expect(updated.enabledProviders).not.toContain("opencode-go");
    expect(updated.opencodeGoConsentAt).toBeNull();
  });
});

describe("CLI provider id validation rejects prototype-chain names", () => {
  it("enable constructor --yes with an online daemon exits 1 with unknown provider and no POST", async () => {
    const mockClient: ServiceClient = {
      get: vi.fn(),
      post: vi.fn().mockResolvedValue({ ok: true }),
      patch: vi.fn(),
    };
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg) => errors.push(msg));
    const exitMock = vi.fn();

    const program = createMockProgram({ createClient: () => mockClient, exit: exitMock });
    try {
      await program.parseAsync(["node", "quotacap", "providers", "enable", "constructor", "--yes"]);
    } catch {}

    expect(exitMock).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toMatch(/unknown provider/i);
    expect(mockClient.post).not.toHaveBeenCalled();
  });

  it("disable constructor exits 1 with unknown provider and no POST", async () => {
    const mockClient: ServiceClient = {
      get: vi.fn(),
      post: vi.fn().mockResolvedValue({ ok: true }),
      patch: vi.fn(),
    };
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg) => errors.push(msg));
    const exitMock = vi.fn();

    const program = createMockProgram({ createClient: () => mockClient, exit: exitMock });
    try {
      await program.parseAsync(["node", "quotacap", "providers", "disable", "constructor"]);
    } catch {}

    expect(exitMock).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toMatch(/unknown provider/i);
    expect(mockClient.post).not.toHaveBeenCalled();
  });

  it("enable constructor --yes offline does not write the junk id to config", async () => {
    const mockClient: ServiceClient = {
      get: vi.fn(),
      post: vi.fn().mockRejectedValue(new ServiceUnavailable("daemon down")),
      patch: vi.fn(),
    };
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg) => errors.push(msg));
    const exitMock = vi.fn();

    const program = createMockProgram({ createClient: () => mockClient, exit: exitMock });
    try {
      await program.parseAsync(["node", "quotacap", "providers", "enable", "constructor", "--yes"]);
    } catch {}

    expect(exitMock).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toMatch(/unknown provider/i);
    expect(mockClient.post).not.toHaveBeenCalled();
    const cfg = await readConfig();
    expect(cfg.enabledProviders).not.toContain("constructor");
  });
});

describe("CLI opencode-go consent prompt EOF", () => {
  it("treats a rejected question (Ctrl-D/EOF) as a no answer without POSTing", async () => {
    const closeMock = vi.fn();
    mockCreateInterface.mockReturnValue({
      question: vi.fn().mockRejectedValue(new Error("EOF")),
      close: closeMock,
    });
    const mockClient: ServiceClient = { get: vi.fn(), post: vi.fn(), patch: vi.fn() };
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => logs.push(msg));
    const isTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    const program = createMockProgram({ createClient: () => mockClient });
    try {
      await program.parseAsync(["node", "quotacap", "providers", "enable", "opencode-go"]);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: isTTY, configurable: true });
    }

    expect(logs.join("\n")).toContain("not enabled");
    expect(mockClient.post).not.toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalled();
  });
});
