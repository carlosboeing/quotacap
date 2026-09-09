import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectStatus,
  status,
  type ServiceDeps,
} from "../../src/service/macos.js";
import { writeServiceMetadata } from "../../src/config.js";
import { VERSION } from "../../src/version.js";

const oldQcHome = process.env.QUOTACAP_HOME;
const dirs: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    await new Promise((r) => s.close(r));
  }
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  process.env.QUOTACAP_HOME = oldQcHome;
});

function mkHome(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "qc-status-"));
  dirs.push(d);
  process.env.QUOTACAP_HOME = d;
  return d;
}

async function stubHealth(
  body: Record<string, any>,
): Promise<{ port: number }> {
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  return { port: typeof addr === "object" && addr ? addr.port : 0 };
}

const PRINT_RUNNING = `gui/501/quotacap = {
	active count = 5
	state = running
	pid = 4242
	last exit code = 0
}`;

const PRINT_DEAD = `gui/501/quotacap = {
	active count = 0
	state = not running
	last exit code = 1
}`;

function writePlist(home: string): string {
  const plistFile = path.join(home, "Library/LaunchAgents/quotacap.plist");
  fs.mkdirSync(path.dirname(plistFile), { recursive: true });
  fs.writeFileSync(
    plistFile,
    `<?xml version="1.0"?><plist><dict><key>Label</key><string>quotacap</string></dict></plist>`,
  );
  return plistFile;
}

function writeMeta(
  home: string,
  paths: Record<string, string | null>,
): void {
  writeServiceMetadata(
    {
      version: VERSION,
      exec: "/stable/quotacap",
      providerPaths: paths,
      installedAt: new Date().toISOString(),
    },
    path.join(home, ".quotacap"),
  );
}

interface Ctx {
  deps: ServiceDeps & { printed: string[] };
  calls: string[][];
}

function ctxFor(
  home: string,
  opts: {
    printImpl?: (args: string[]) => string;
    port?: number;
    now?: () => Date;
  } = {},
): Ctx {
  const calls: string[][] = [];
  const printed: string[] = [];
  const deps = {
    platform: "darwin",
    home,
    uid: 501,
    dataDir: path.join(home, ".quotacap"),
    runLaunchctl: (args: string[]) => {
      calls.push(args);
      if (opts.printImpl) return opts.printImpl(args);
      throw new Error("no launchctl stub");
    },
    print: (m: string) => void printed.push(m),
    error: (m: string) => void printed.push(m),
    now: opts.now ?? (() => new Date("2026-09-09T12:00:00Z")),
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    printed,
  } as ServiceDeps & { printed: string[] };
  return { deps, calls };
}

describe("service status", () => {
  it("(a) all-healthy shows all five sections", async () => {
    const home = mkHome();
    writePlist(home);
    writeMeta(home, {
      claude: "/opt/bin/claude",
      codex: "/opt/bin/codex",
      kimi: "/opt/bin/kimi",
      grok: "/opt/bin/grok",
      agy: "/opt/bin/agy",
    });
    const { port } = await stubHealth({
      ok: true,
      ready: true,
      version: VERSION,
      exec: "/stable/quotacap",
      polling: "idle",
      lastCompletedPollAt: "2026-09-09T11:55:00Z",
    });
    const { deps } = ctxFor(home, {
      printImpl: () => PRINT_RUNNING,
      port,
    });
    const st = await collectStatus(deps);
    expect(st.registration).toMatchObject({ installed: true, loaded: true, pid: 4242 });
    expect(st.readiness).toMatchObject({ ok: true, ready: true, version: VERSION });
    expect(st.version.skew).toBe(false);
    expect(st.endpoint.url).toBe(`http://127.0.0.1:${port}`);
    expect(st.lastPoll.at).toBe("2026-09-09T11:55:00Z");
    expect(st.lastPoll.ageMs).toBe(5 * 60 * 1000);

    await status(deps);
    const out = deps.printed.join("\n");
    for (const section of ["Registration", "Readiness", "Endpoint", "Last poll", "Providers"]) {
      expect(out).toContain(section);
    }
    expect(out).toContain("4242");
    expect(out).toContain(VERSION);
    expect(out).toContain(`http://127.0.0.1:${port}`);

    deps.printed.length = 0;
    await status(deps, { json: true });
    const parsed = JSON.parse(deps.printed.join("\n"));
    expect(parsed.registration.pid).toBe(4242);
    expect(parsed.readiness.ready).toBe(true);
    expect(parsed.version.skew).toBe(false);
  });

  it("(b) registered-but-dead shows PID absent plus readiness error", async () => {
    const home = mkHome();
    writePlist(home);
    writeMeta(home, {
      claude: "/opt/bin/claude",
      codex: null,
      kimi: null,
      grok: null,
      agy: null,
    });
    // Nothing listens: use a closed port via config-free deps port.
    const { deps } = ctxFor(home, {
      printImpl: () => PRINT_DEAD,
      port: 1,
    });
    const st = await collectStatus(deps);
    expect(st.registration).toMatchObject({ installed: true, loaded: true, pid: null });
    expect(st.readiness.ok).toBe(false);
    expect(st.readiness.error).toBeTruthy();
    expect(st.endpoint.url).toBe("http://127.0.0.1:1");
    expect(st.lastPoll.at).toBeNull();

    await status(deps);
    const out = deps.printed.join("\n");
    expect(out).toContain("Registration");
    expect(out).toContain("Endpoint");
    expect(out).toMatch(/unknown|unavailable/i);
  });

  it("(c) unregistered shows not installed plus install hint", async () => {
    const home = mkHome();
    const { deps } = ctxFor(home, {
      printImpl: () => {
        throw new Error("Could not find service");
      },
      port: 1,
    });
    const st = await collectStatus(deps);
    expect(st.registration.installed).toBe(false);
    expect(st.registration.loaded).toBe(false);
    await status(deps);
    const out = deps.printed.join("\n");
    expect(out).toMatch(/not installed/);
    expect(out).toContain("service install");
  });

  it("(d) version skew is flagged, never auto-fixed", async () => {
    const home = mkHome();
    writePlist(home);
    writeMeta(home, {
      claude: "/opt/bin/claude",
      codex: "/opt/bin/codex",
      kimi: "/opt/bin/kimi",
      grok: "/opt/bin/grok",
      agy: "/opt/bin/agy",
    });
    const { port } = await stubHealth({
      ok: true,
      ready: true,
      version: "0.0.20",
      exec: "/stable/quotacap",
      polling: "idle",
      lastCompletedPollAt: null,
    });
    const { deps, calls } = ctxFor(home, {
      printImpl: () => PRINT_RUNNING,
      port,
    });
    const st = await collectStatus(deps);
    expect(st.version).toMatchObject({ service: "0.0.20", cli: VERSION, skew: true });
    await status(deps);
    expect(deps.printed.join("\n")).toMatch(/skew/);
    // Read-only: status only ever prints, never bootstraps, enables or reinstalls.
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c[0]).toBe("print");
  });

  it("(e) missing provider binaries are listed with repair text", async () => {
    const home = mkHome();
    writePlist(home);
    writeMeta(home, {
      claude: "/opt/bin/claude",
      codex: null,
      kimi: null,
      grok: "/opt/bin/grok",
      agy: null,
    });
    const { port } = await stubHealth({
      ok: true,
      ready: true,
      version: VERSION,
      exec: "/stable/quotacap",
      polling: "idle",
      lastCompletedPollAt: null,
    });
    const { deps } = ctxFor(home, {
      printImpl: () => PRINT_RUNNING,
      port,
    });
    const st = await collectStatus(deps);
    expect(st.providers.missing.sort()).toEqual(["agy", "codex", "kimi"]);
    await status(deps);
    const out = deps.printed.join("\n");
    expect(out).toContain("codex");
    expect(out).toMatch(/re-run/);
  });
});
