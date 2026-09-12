import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  postUpdateTakeover,
  registerUpdateCommand,
  stoppedDaemonMessage,
  type UpdateCommandDeps,
} from "../../src/cli/update.js";
import { platformAssetName } from "../../src/runtime/updates.js";
import { ServiceUnavailable } from "../../src/runtime/client.js";
import { acquireClaim, type Claim } from "../../src/runtime/owner.js";
import { VERSION } from "../../src/version.js";

const savedHome = process.env.QUOTACAP_HOME;
const savedReleaseBase = process.env.QUOTACAP_RELEASE_BASE_URL;
const dirs: string[] = [];
const claims: Claim[] = [];

afterEach(() => {
  for (const c of claims.splice(0)) {
    try {
      c.release();
    } catch {}
  }
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  if (savedHome === undefined) delete process.env.QUOTACAP_HOME;
  else process.env.QUOTACAP_HOME = savedHome;
  if (savedReleaseBase === undefined) delete process.env.QUOTACAP_RELEASE_BASE_URL;
  else process.env.QUOTACAP_RELEASE_BASE_URL = savedReleaseBase;
  vi.restoreAllMocks();
});

function isolatedHome(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "qc-update-"));
  dirs.push(d);
  process.env.QUOTACAP_HOME = d;
  // CLI tests exercise the hermetic JSON resolution path; the redirect path
  // is covered in tests/runtime/updates.test.ts. The host is never dialled —
  // every test injects fetchFn.
  process.env.QUOTACAP_RELEASE_BASE_URL = "http://127.0.0.1:9";
  return d;
}

function tmpFile(dir: string, rel: string, content: string): string {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

const TARBALL = Buffer.from("fake-release-tarball");
const ASSET = platformAssetName();

function releaseFetch(opts: {
  tag?: string;
  htmlUrl?: string;
  tarball?: Buffer;
  failAssets?: boolean;
  failApi?: boolean;
} = {}) {
  const tar = opts.tarball ?? TARBALL;
  return (async (url: any) => {
    const u = String(url);
    if (u.includes("releases/latest")) {
      if (opts.failApi) throw new Error("network down");
      return {
        ok: true,
        status: 200,
        json: async () => ({ tag_name: opts.tag ?? "v99.0.0", html_url: opts.htmlUrl ?? "https://x/notes" }),
      };
    }
    if (opts.failAssets) return { ok: false, status: 404, text: async () => "", arrayBuffer: async () => Buffer.from("") };
    if (u.endsWith("/SHA256SUMS")) {
      const hex = crypto.createHash("sha256").update(tar).digest("hex");
      return { ok: true, status: 200, text: async () => `${hex}  ${ASSET}\n` };
    }
    return { ok: true, status: 200, arrayBuffer: async () => tar };
  }) as unknown as typeof fetch;
}

function failingFetch() {
  return (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
}

function downClient() {
  return () => ({
    get: async () => {
      throw new ServiceUnavailable("down");
    },
    post: async () => {
      throw new ServiceUnavailable("down");
    },
  });
}

async function runUpdate(args: string[], deps: UpdateCommandDeps): Promise<{
  logs: string[];
  errors: string[];
  exitCodes: number[];
}> {
  const logs: string[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: any[]) => {
    logs.push(a.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a: any[]) => {
    errors.push(a.join(" "));
  });
  const prog = new Command();
  prog.exitOverride();
  registerUpdateCommand(prog, { ...deps, exit: (c: number) => exitCodes.push(c) });
  await prog.parseAsync(["update", ...args], { from: "user" });
  return { logs, errors, exitCodes };
}

function standaloneEnv(home: string) {
  const execPath = tmpFile(home, "bin/quotacap", "old-binary");
  return { execPath, channelEnv: { execPath, argv1: "update" as string } };
}

describe("update --check", () => {
  it("reports availability in human and JSON shapes", async () => {
    const home = isolatedHome();
    const { channelEnv } = standaloneEnv(home);
    const human = await runUpdate(["--check"], { channelEnv, fetchFn: releaseFetch() });
    expect(human.logs).toEqual([`${VERSION} -> 99.0.0 available`]);
    expect(human.errors).toEqual([]);
    expect(human.exitCodes).toEqual([]);

    const json = await runUpdate(["--check", "--json"], { channelEnv, fetchFn: releaseFetch() });
    expect(json.exitCodes).toEqual([]);
    expect(JSON.parse(json.logs.join("\n"))).toEqual({
      channel: "standalone",
      current: VERSION,
      latest: "99.0.0",
      upToDate: false,
      updated: false,
      instruction: null,
      error: null,
    });
  });

  it("reports already-at-latest without parens", async () => {
    const home = isolatedHome();
    const { channelEnv } = standaloneEnv(home);
    const r = await runUpdate(["--check"], {
      channelEnv,
      fetchFn: releaseFetch({ tag: `v${VERSION}` }),
    });
    expect(r.logs).toEqual(["already at latest"]);
    expect(r.exitCodes).toEqual([]);
  });

  it("writes the daily cache and errors loudly when unresolvable", async () => {
    const home = isolatedHome();
    const { channelEnv } = standaloneEnv(home);
    await runUpdate(["--check"], { channelEnv, fetchFn: releaseFetch() });
    const cache = JSON.parse(fs.readFileSync(path.join(home, ".quotacap", "updates.json"), "utf8"));
    expect(cache).toMatchObject({ latest: "99.0.0", channel: "standalone", current: VERSION });

    const bad = await runUpdate(["--check"], { channelEnv, fetchFn: failingFetch() });
    expect(bad.exitCodes).toEqual([1]);
    expect(bad.errors.join("\n")).toMatch(/could not resolve/);
  });

  it("diagnoses a rate-limited response with its reset time", async () => {
    const home = isolatedHome();
    const { channelEnv } = standaloneEnv(home);
    const reset = 1786840560;
    const limited = (async () => ({
      ok: false,
      status: 403,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(reset),
      },
    })) as unknown as typeof fetch;
    const d = new Date(reset * 1000);
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const r = await runUpdate(["--check"], { channelEnv, fetchFn: limited });
    expect(r.exitCodes).toEqual([1]);
    expect(r.errors.join("\n")).toContain("rate limit");
    expect(r.errors.join("\n")).toContain(`resets ${hhmm}`);
    expect(r.errors.join("\n")).toContain("quotacap update --to <version>");

    const json = await runUpdate(["--check", "--json"], { channelEnv, fetchFn: limited });
    expect(JSON.parse(json.logs.join("\n"))).toMatchObject({
      latest: null,
      error: expect.stringContaining("rate limit"),
    });
  });
});

describe("update print-only channels", () => {
  it.each([
    ["brew", { execPath: "/opt/homebrew/Cellar/quotacap/0.0.22/bin/quotacap", argv1: "update" }, "Run: brew upgrade quotacap"],
    ["pnpm", { execPath: "/usr/bin/node", argv1: "/h/.local/share/pnpm/global/5/node_modules/quotacap/dist/cli/index.js" }, "Run: pnpm add -g quotacap@latest"],
    ["yarn", { execPath: "/usr/bin/node", argv1: "/h/.config/yarn/global/node_modules/quotacap/dist/cli/index.js" }, "Run: yarn global add quotacap@latest"],
    ["npx", { execPath: "/x/_npx/1/quotacap", argv1: "update" }, "Running via npx, which always resolves the latest published version; nothing to update."],
  ])("%s prints its instruction and exits 0", async (channel, channelEnv, line) => {
    isolatedHome();
    const r = await runUpdate([], { channelEnv: channelEnv as any, fetchFn: releaseFetch() });
    expect(r.logs).toEqual([line]);
    expect(r.exitCodes).toEqual([]);
    const json = await runUpdate(["--json"], { channelEnv: channelEnv as any, fetchFn: releaseFetch() });
    expect(JSON.parse(json.logs.join("\n"))).toMatchObject({
      channel,
      updated: false,
      instruction: line,
      error: null,
    });
    expect(json.exitCodes).toEqual([]);
  });
});

describe("update refusals", () => {
  it("source checkouts refuse with guidance, even for --check", async () => {
    const home = isolatedHome();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qc-upd-src-"));
    dirs.push(root);
    fs.mkdirSync(path.join(root, "src", "cli"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "cli", "index.ts"), "x");
    const entry = tmpFile(root, "dist/cli/index.js", "x");
    const channelEnv = { execPath: "/usr/bin/node", argv1: entry };
    for (const args of [[], ["--check"]]) {
      const r = await runUpdate(args, { channelEnv, fetchFn: releaseFetch() });
      expect(r.exitCodes).toEqual([1]);
      expect(r.errors.join("\n")).toMatch(/source checkout/);
    }
    const json = await runUpdate(["--json"], { channelEnv, fetchFn: releaseFetch() });
    expect(JSON.parse(json.logs.join("\n"))).toMatchObject({
      channel: "source",
      latest: null,
      upToDate: null,
      updated: false,
      error: expect.stringContaining("source checkout"),
    });
    expect(home).toBeTruthy();
  });

  it("unknown channels refuse with reinstall instructions", async () => {
    isolatedHome();
    const channelEnv = { execPath: "/usr/bin/node", argv1: undefined };
    const r = await runUpdate([], { channelEnv, fetchFn: releaseFetch() });
    expect(r.exitCodes).toEqual([1]);
    expect(r.errors.join("\n")).toMatch(/reinstall manually/);
  });
});

describe("update standalone", () => {
  it("already at latest exits 0 with parens", async () => {
    const home = isolatedHome();
    const { channelEnv } = standaloneEnv(home);
    const r = await runUpdate([], {
      channelEnv,
      fetchFn: releaseFetch({ tag: `v${VERSION}` }),
    });
    expect(r.logs).toEqual([`already at latest (${VERSION})`]);
    expect(r.exitCodes).toEqual([]);
  });

  it("applies the swap and leaves an unmanaged daemon stopped with guidance", async () => {
    const home = isolatedHome();
    const { execPath, channelEnv } = standaloneEnv(home);
    let live = true;
    const r = await runUpdate([], {
      channelEnv,
      execPath,
      fetchFn: releaseFetch(),
      extractTar: (tarball: string, destDir: string) => {
        expect(fs.existsSync(tarball)).toBe(true);
        tmpFile(destDir, "quotacap", "new-binary");
      },
      createClient: () => ({
        get: async (p: string) => {
          if (!live || p !== "/health") throw new ServiceUnavailable("down");
          return { ok: true, ready: true, version: VERSION, exec: execPath };
        },
        post: async () => {
          live = false;
          return { ok: true, restarting: true };
        },
      }),
      isManaged: async () => false,
      takeoverOpts: { readToken: () => "tok", sleep: async () => {}, timeoutMs: 1000 },
    });
    expect(fs.readFileSync(execPath, "utf8")).toBe("new-binary");
    expect(r.exitCodes).toEqual([]);
    expect(r.logs[0]).toBe(`Updated ${VERSION} to 99.0.0`);
    expect(r.logs[1]).toBe(stoppedDaemonMessage(VERSION, "99.0.0"));
    expect(r.logs[2]).toBe("https://x/notes");
  });

  it("refreshes the service registration for managed daemons and reports updated JSON", async () => {
    const home = isolatedHome();
    const { execPath, channelEnv } = standaloneEnv(home);
    let version = VERSION;
    const services: Array<{ args: string[]; opts?: Record<string, any> }> = [];
    const r = await runUpdate(["--json"], {
      channelEnv,
      execPath,
      fetchFn: releaseFetch(),
      extractTar: (tarball: string, destDir: string) => {
        tmpFile(destDir, "quotacap", "new-binary");
      },
      createClient: () => ({
        get: async () => ({ ok: true, ready: true, version, exec: execPath }),
        post: async () => {
          throw new Error("unused");
        },
      }),
      isManaged: async () => true,
      execService: async (args: string[], opts?: Record<string, any>) => {
        services.push({ args, opts });
        version = "99.0.0";
        return 0;
      },
      takeoverOpts: { sleep: async () => {}, timeoutMs: 1000 },
    });
    expect(services).toEqual([{ args: ["install"], opts: { version: "99.0.0" } }]);
    expect(r.exitCodes).toEqual([]);
    expect(JSON.parse(r.logs.join("\n"))).toEqual({
      channel: "standalone",
      current: VERSION,
      latest: "99.0.0",
      upToDate: true,
      updated: true,
      instruction: null,
      error: null,
    });
  });

  it("swap failures exit 1 without updating", async () => {
    const home = isolatedHome();
    const { execPath, channelEnv } = standaloneEnv(home);
    const r = await runUpdate([], {
      channelEnv,
      execPath,
      fetchFn: releaseFetch({ failAssets: true }),
    });
    expect(r.exitCodes).toEqual([1]);
    expect(r.errors.join("\n")).toMatch(/download failed/);
  });
});

describe("update npm", () => {
  const npmEnv = {
    execPath: "/usr/bin/node",
    argv1: "/prefix/lib/node_modules/quotacap/dist/cli/index.js",
    npmPrefix: () => "/prefix",
  };

  it("spawns the global install, warns on shadows, then takes over", async () => {
    const home = isolatedHome();
    tmpFile(home, ".local/bin/quotacap", "stale-binary");
    const spawns: string[][] = [];
    const r = await runUpdate([], {
      channelEnv: npmEnv,
      homeDir: home,
      fetchFn: releaseFetch(),
      spawnNpm: async (args: string[]) => {
        spawns.push(args);
        return 0;
      },
      createClient: downClient(),
      isManaged: async () => false,
    });
    expect(spawns).toEqual([["install", "-g", "quotacap@latest"]]);
    expect(r.errors.join("\n")).toMatch(/may shadow this npm install/);
    // The warning names the fixture shadow, never the real ~/.local/bin.
    expect(r.errors.join("\n")).toContain(path.join(home, ".local", "bin", "quotacap"));
    expect(r.logs[0]).toBe(`Updated ${VERSION} to 99.0.0`);
    expect(r.exitCodes).toEqual([]);
  });

  it("pins --version and reports spawn failures", async () => {
    const home = isolatedHome();
    const spawns: string[][] = [];
    const r = await runUpdate(["--version", "0.0.21"], {
      channelEnv: npmEnv,
      homeDir: home,
      fetchFn: releaseFetch(),
      spawnNpm: async (args: string[]) => {
        spawns.push(args);
        return 3;
      },
      createClient: downClient(),
    });
    expect(spawns).toEqual([["install", "-g", "quotacap@0.0.21"]]);
    expect(r.exitCodes).toEqual([1]);
    expect(r.errors.join("\n")).toContain("exited 3");
    expect(home).toBeTruthy();
  });
});

describe("postUpdateTakeover", () => {
  it("wedged claims exit 2, older daemons warn, matches stay silent", async () => {
    const home = isolatedHome();
    const dataDir = path.join(home, ".quotacap");
    fs.mkdirSync(dataDir, { recursive: true });
    const claim = await acquireClaim(dataDir);
    claims.push(claim);
    const wedged = await postUpdateTakeover({
      target: "99.0.0",
      port: 1,
      dataDir,
      createClient: downClient(),
      isManaged: async () => true,
    });
    expect(wedged.exitCode).toBe(2);
    expect(wedged.error).toContain("service restart");

    const older = await postUpdateTakeover({
      target: "0.0.21",
      port: 1,
      dataDir,
      createClient: () => ({
        get: async () => ({ ok: true, ready: true, version: "99.0.0", exec: "/new/q" }),
        post: async () => {
          throw new Error("unused");
        },
      }),
    });
    expect(older).toMatchObject({ exitCode: 0, error: null });
    expect(older.warnings).toEqual(["daemon is newer (99.0.0); run 'quotacap update' to match it"]);

    const match = await postUpdateTakeover({
      target: "99.0.0",
      port: 1,
      dataDir,
      createClient: () => ({
        get: async () => ({ ok: true, ready: true, version: "99.0.0", exec: "/q" }),
        post: async () => {
          throw new Error("unused");
        },
      }),
    });
    expect(match).toEqual({ notes: [], warnings: [], error: null, exitCode: 0 });
  });

  it("pins the stopped-daemon message", () => {
    expect(stoppedDaemonMessage("0.0.21", "0.0.23")).toBe(
      "Stopped old daemon (0.0.21); no background service is registered. " +
        "Run 'quotacap web' to start 0.0.23, or 'quotacap service install' to run it in the background.",
    );
  });
});
