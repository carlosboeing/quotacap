import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  autoEnableNewProviders,
  isExperimentalIngestEnabled,
  LEGACY_KNOWN_PROVIDERS,
  readServiceConfig,
  readServiceMetadata,
  resetAllProviderNameOverrides,
  setProviderNameOverride,
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
      enabledProviders: ["claude", "codex", "kimi", "grok", "agy", "muse"],
      knownProviders: ["claude", "codex", "kimi", "grok", "agy", "muse"],
      providerNames: {},
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
      "muse",
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
    for (const id of ["claude", "codex", "kimi", "grok", "agy", "manual", "muse"]) {
      expect(String(err.message)).toContain(id);
    }

    writeConfig({ enabledProviders: ["manual", "claude"] });
    const cfg = await readServiceConfig();
    expect(cfg.enabledProviders).toEqual(["manual", "claude"]);
  });
});

describe("experimental ingest flag", () => {
  const oldFlag = process.env.QUOTACAP_EXPERIMENTAL_INGEST;

  afterEach(() => {
    if (oldFlag === undefined) delete process.env.QUOTACAP_EXPERIMENTAL_INGEST;
    else process.env.QUOTACAP_EXPERIMENTAL_INGEST = oldFlag;
  });

  it("is off by default and omitted from written defaults", async () => {
    isolatedHome();
    delete process.env.QUOTACAP_EXPERIMENTAL_INGEST;
    expect(isExperimentalIngestEnabled()).toBe(false);
    const cfg = await readServiceConfig();
    expect(cfg.experimentalIngest).toBeUndefined();
  });

  it("follows env over config, then the optional config key", async () => {
    isolatedHome();
    writeConfig({ experimentalIngest: true });
    delete process.env.QUOTACAP_EXPERIMENTAL_INGEST;
    const cfg = await readServiceConfig();
    expect(cfg.experimentalIngest).toBe(true);
    expect(isExperimentalIngestEnabled(cfg, {})).toBe(true);

    expect(isExperimentalIngestEnabled(cfg, { QUOTACAP_EXPERIMENTAL_INGEST: "0" })).toBe(
      false,
    );
    expect(isExperimentalIngestEnabled({ experimentalIngest: false }, { QUOTACAP_EXPERIMENTAL_INGEST: "1" })).toBe(
      true,
    );
    expect(isExperimentalIngestEnabled({}, { QUOTACAP_EXPERIMENTAL_INGEST: "true" })).toBe(
      true,
    );
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

describe("providerNames config", () => {
  it("defaults providerNames to empty object when omitted", async () => {
    isolatedHome();
    const cfg = await readServiceConfig();
    expect(cfg.providerNames).toEqual({});
  });

  it("parses valid providerNames map including unregistered ids", async () => {
    isolatedHome();
    writeConfig({
      providerNames: {
        "agy:3p": "Google 3P",
        muse: "Work Muse",
        "custom-manual": "My Manual Provider",
      },
    });
    const cfg = await readServiceConfig();
    expect(cfg.providerNames).toEqual({
      "agy:3p": "Google 3P",
      muse: "Work Muse",
      "custom-manual": "My Manual Provider",
    });
  });

  it("rejects invalid display name in providerNames naming the field", async () => {
    isolatedHome();
    writeConfig({
      providerNames: {
        claude: "\x1b[31mRed\x1b[0m",
      },
    });
    await expect(readServiceConfig()).rejects.toThrow(/invalid config: providerNames\.claude/);
  });

  it("rejects empty display name in providerNames", async () => {
    isolatedHome();
    writeConfig({
      providerNames: {
        muse: "   ",
      },
    });
    await expect(readServiceConfig()).rejects.toThrow(/invalid config: providerNames\.muse/);
  });

  it("rejects display name exceeding 32 characters in providerNames", async () => {
    isolatedHome();
    writeConfig({
      providerNames: {
        codex: "a".repeat(33),
      },
    });
    await expect(readServiceConfig()).rejects.toThrow(/invalid config: providerNames\.codex/);
  });

  it("setProviderNameOverride preserves unknown fields and custom config without schema round-tripping", async () => {
    isolatedHome();
    const cfgPath = path.join(home, ".quotacap", "config.json");
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    // Write raw JSON with custom port, enabledProviders, and an unknown field
    fs.writeFileSync(
      cfgPath,
      JSON.stringify(
        {
          port: 9999,
          customUnknownKey: "preserve-me",
          providerNames: { claude: "Old Claude" },
        },
        null,
        2,
      ),
    );

    await setProviderNameOverride("muse", "Work Muse", cfgPath);

    const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    expect(raw.port).toBe(9999);
    expect(raw.customUnknownKey).toBe("preserve-me");
    expect(raw.providerNames).toEqual({
      claude: "Old Claude",
      muse: "Work Muse",
    });

    // Reset single with null
    await setProviderNameOverride("claude", null, cfgPath);
    const afterDelete = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    expect(afterDelete.customUnknownKey).toBe("preserve-me");
    expect(afterDelete.providerNames).toEqual({ muse: "Work Muse" });

    // Reset all preserves unknown keys
    await resetAllProviderNameOverrides(cfgPath);
    const afterResetAll = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    expect(afterResetAll.customUnknownKey).toBe("preserve-me");
    expect(afterResetAll.providerNames).toEqual({});
  });

  it("setProviderNameOverride throws and does not overwrite config if file is corrupt", async () => {
    isolatedHome();
    const cfgPath = path.join(home, ".quotacap", "config.json");
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, "{ this is not valid json");

    await expect(setProviderNameOverride("muse", "Work Muse", cfgPath)).rejects.toThrow(
      /cannot update provider names/,
    );
    expect(fs.readFileSync(cfgPath, "utf8")).toBe("{ this is not valid json");
  });
});

describe("provider auto-enable", () => {
  const FIVE = ["claude", "codex", "kimi", "grok", "agy"];

  function cfgPath(): string {
    return path.join(home, ".quotacap", "config.json");
  }

  function readRaw(): any {
    return JSON.parse(fs.readFileSync(cfgPath(), "utf8"));
  }

  it("backfills pre-feature configs with the frozen five, not the live registry", async () => {
    isolatedHome();
    writeConfig({ enabledProviders: FIVE });
    expect(LEGACY_KNOWN_PROVIDERS).toEqual(FIVE);
    const r = await autoEnableNewProviders({ which: () => null });
    expect(r?.changed).toBe(false);
    // muse stays unknown when its binary is absent, so it is re-checked next start.
    expect(r?.knownProviders).toEqual(FIVE);
    expect(r?.enabledProviders).toEqual(FIVE);
    expect(readRaw().knownProviders).toBeUndefined();
  });

  it("auto-enables an unknown adapter whose binary resolves, persisting both lists", async () => {
    isolatedHome();
    writeConfig({ enabledProviders: FIVE, customUnknownKey: "preserve-me" });
    const r = await autoEnableNewProviders({
      which: (bin) => (bin === "muse" ? `/bin/${bin}` : null),
    });
    expect(r?.changed).toBe(true);
    expect(r?.enabledProviders).toEqual([...FIVE, "muse"]);
    expect(r?.knownProviders).toEqual([...FIVE, "muse"]);
    const raw = readRaw();
    expect(raw.enabledProviders).toEqual([...FIVE, "muse"]);
    expect(raw.knownProviders).toEqual([...FIVE, "muse"]);
    expect(raw.customUnknownKey).toBe("preserve-me");
  });

  it("never re-adds a deliberately disabled provider that is already known", async () => {
    isolatedHome();
    writeConfig({ enabledProviders: FIVE, knownProviders: [...FIVE, "muse"] });
    const before = fs.readFileSync(cfgPath(), "utf8");
    const r = await autoEnableNewProviders({ which: () => "/bin/on-path" });
    expect(r?.changed).toBe(false);
    expect(r?.enabledProviders).toEqual(FIVE);
    expect(r?.knownProviders).toEqual([...FIVE, "muse"]);
    expect(fs.readFileSync(cfgPath(), "utf8")).toBe(before);
  });

  it("leaves fresh configs untouched (all six known and enabled)", async () => {
    isolatedHome();
    writeConfig({ enabledProviders: [...FIVE, "muse"], knownProviders: [...FIVE, "muse"] });
    const before = fs.readFileSync(cfgPath(), "utf8");
    const r = await autoEnableNewProviders({ which: () => "/bin/on-path" });
    expect(r?.changed).toBe(false);
    expect(fs.readFileSync(cfgPath(), "utf8")).toBe(before);
  });

  it("never probes or records manual, which has no CLI binary", async () => {
    isolatedHome();
    writeConfig({ enabledProviders: FIVE });
    const probed: string[] = [];
    const r = await autoEnableNewProviders({
      which: (bin) => {
        probed.push(bin);
        return `/bin/${bin}`;
      },
    });
    expect(probed).not.toContain("manual");
    expect(r?.enabledProviders).not.toContain("manual");
    expect(r?.knownProviders).not.toContain("manual");
  });

  it("returns null without throwing when the file is missing or corrupt", async () => {
    isolatedHome();
    expect(await autoEnableNewProviders()).toBeNull();
    const file = cfgPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{bad json");
    expect(await autoEnableNewProviders()).toBeNull();
    expect(fs.readFileSync(file, "utf8")).toBe("{bad json");
  });

  it("defaults knownProviders to all six and rejects a non-array naming the field", async () => {
    isolatedHome();
    writeConfig({ port: 9999 });
    const cfg = await readServiceConfig();
    expect(cfg.knownProviders).toEqual([...FIVE, "muse"]);
    writeConfig({ knownProviders: 42 });
    await expect(readServiceConfig()).rejects.toThrow(/invalid config: knownProviders/);
  });

  it("tolerates unknown ids in knownProviders instead of bricking start", async () => {
    isolatedHome();
    writeConfig({ knownProviders: ["claude", "retired-adapter"] });
    const cfg = await readServiceConfig();
    expect(cfg.knownProviders).toEqual(["claude", "retired-adapter"]);
  });
});


