import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readServiceConfig,
  readServiceMetadata,
  writeServiceMetadata,
  type ServiceMetadata,
} from "../../src/config.js";

const oldQcHome = process.env.QUOTACAP_HOME;
let home = "";

afterEach(() => {
  process.env.QUOTACAP_HOME = oldQcHome;
  if (home) fs.rmSync(home, { recursive: true, force: true });
  home = "";
});

function isolatedHome(): string {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "qc-svc-cfg-"));
  process.env.QUOTACAP_HOME = home;
  return home;
}

function writeConfig(obj: unknown): void {
  const dir = path.join(home, ".quotacap");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(obj));
}

describe("strict service config", () => {
  it("(a) absent config means defaults", async () => {
    isolatedHome();
    const cfg = await readServiceConfig();
    expect(cfg).toEqual({
      port: 8787,
      pollMinutes: 15,
      enabledProviders: ["claude", "codex", "kimi", "grok", "agy"],
    });
  });

  it("partial config fills missing keys with defaults", async () => {
    isolatedHome();
    writeConfig({ port: 9999 });
    const cfg = await readServiceConfig();
    expect(cfg.port).toBe(9999);
    expect(cfg.pollMinutes).toBe(15);
    expect(cfg.enabledProviders).toEqual([
      "claude",
      "codex",
      "kimi",
      "grok",
      "agy",
    ]);
  });

  it("(b) malformed JSON throws instead of defaults", async () => {
    isolatedHome();
    const dir = path.join(home, ".quotacap");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), "{bad json");
    await expect(readServiceConfig()).rejects.toThrow(/invalid config/);
  });

  it("(c) bad port throws naming the field", async () => {
    for (const port of [0, 99999, "8787", -1, 87.5]) {
      isolatedHome();
      writeConfig({ port });
      await expect(readServiceConfig()).rejects.toThrow(/invalid config: port/);
      fs.rmSync(home, { recursive: true, force: true });
      home = "";
    }
    process.env.QUOTACAP_HOME = oldQcHome;
  });

  it("(d) non-positive or non-finite pollMinutes throws", async () => {
    for (const pollMinutes of [0, -5, 1e999]) {
      isolatedHome();
      writeConfig({ pollMinutes });
      await expect(readServiceConfig()).rejects.toThrow(
        /invalid config: pollMinutes/,
      );
      fs.rmSync(home, { recursive: true, force: true });
      home = "";
    }
    process.env.QUOTACAP_HOME = oldQcHome;
  });

  it("(e) unknown provider id throws listing valid ids; manual allowed", async () => {
    isolatedHome();
    writeConfig({ enabledProviders: ["claude", "bogus"] });
    const err = await readServiceConfig().then(
      () => {
        throw new Error("unexpectedly accepted unknown provider");
      },
      (e) => e,
    );
    expect(String(err.message)).toMatch(/invalid config: enabledProviders/);
    expect(String(err.message)).toContain("bogus");
    for (const id of ["claude", "codex", "kimi", "grok", "agy", "manual"]) {
      expect(String(err.message)).toContain(id);
    }

    writeConfig({ enabledProviders: ["manual", "claude"] });
    const cfg = await readServiceConfig();
    expect(cfg.enabledProviders).toEqual(["manual", "claude"]);
  });
});

describe("service metadata", () => {
  it("(f) metadata round-trips private and contains paths only", () => {
    isolatedHome();
    expect(readServiceMetadata()).toBeNull();
    const meta: ServiceMetadata = {
      version: "0.0.21",
      exec: "/usr/local/bin/quotacap",
      providerPaths: {
        claude: "/opt/homebrew/bin/claude",
        codex: null,
        kimi: "/opt/homebrew/bin/kimi",
        grok: "/opt/homebrew/bin/grok",
        agy: null,
      },
      installedAt: new Date().toISOString(),
    };
    writeServiceMetadata(meta);
    const file = path.join(home, ".quotacap", "service.json");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readServiceMetadata()).toEqual(meta);
    const serialized = fs.readFileSync(file, "utf8");
    for (const secret of ["token", "secret", "credential", "env"]) {
      expect(serialized.toLowerCase()).not.toContain(secret);
    }
  });
});
