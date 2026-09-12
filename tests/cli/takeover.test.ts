import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkSkew,
  compareVersions,
  execSkewWarning,
  formatWedged,
  olderCliWarning,
  parseVersion,
  takeoverManaged,
  takeoverUnmanaged,
  TakeoverError,
  unmanagedSkewWarning,
  upgradedMessage,
  waitForHealthy,
  waitForRelease,
  WedgedError,
} from "../../src/cli/takeover.js";
import { ServiceError, ServiceUnavailable } from "../../src/runtime/client.js";
import { VERSION } from "../../src/version.js";

const CLI = "0.0.22";
const EXEC = "/stable/quotacap";

describe("compareVersions", () => {
  it("compares numeric tuples with leading-v tolerance", () => {
    expect(compareVersions("0.0.22", "0.0.22")).toBe(0);
    expect(compareVersions("v0.0.22", "0.0.22")).toBe(0);
    expect(compareVersions("0.0.23", "0.0.22")).toBe(1);
    expect(compareVersions("0.0.22", "0.0.23")).toBe(-1);
    expect(compareVersions("0.1.0", "0.0.99")).toBe(1);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
  });

  it("falls back to string order when unparseable", () => {
    expect(compareVersions("test", "test")).toBe(0);
    expect(compareVersions("0.0.0-stale", "0.0.0-stale")).toBe(0);
    expect(compareVersions("b", "a")).toBe(1);
    expect(compareVersions("0.0.22", "test")).toBe(-1);
  });

  it("parseVersion accepts dotted numerics only", () => {
    expect(parseVersion("0.0.22")).toEqual([0, 0, 22]);
    expect(parseVersion("v1.2")).toEqual([1, 2]);
    expect(parseVersion("test")).toBeNull();
    expect(parseVersion("0.0.0-stale")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });
});

describe("checkSkew", () => {
  it("matches on equal version and exec", () => {
    expect(checkSkew({ ok: true, version: CLI, exec: EXEC }, CLI, EXEC)).toBe("match");
    expect(checkSkew({ ok: true, version: `v${CLI}`, exec: EXEC }, CLI, EXEC)).toBe("match");
    expect(checkSkew({ ok: true, version: CLI }, CLI, EXEC)).toBe("match");
  });

  it("flags exec-only skew on same version with different exec", () => {
    expect(checkSkew({ ok: true, version: CLI, exec: "/other/q" }, CLI, EXEC)).toBe("exec-only");
  });

  it("flags cli-newer when the CLI sorts above the daemon", () => {
    expect(checkSkew({ ok: true, version: "0.0.21", exec: EXEC }, CLI, EXEC)).toBe("cli-newer");
    expect(checkSkew({ ok: true, version: "0.0.0-stale", exec: "/other/q" }, CLI, EXEC)).toBe("cli-newer");
    expect(checkSkew({ ok: true, exec: EXEC }, CLI, EXEC)).toBe("cli-newer");
  });

  it("flags cli-older when the daemon sorts above the CLI", () => {
    expect(checkSkew({ ok: true, version: "0.0.23", exec: EXEC }, CLI, EXEC)).toBe("cli-older");
    expect(checkSkew({ ok: true, version: "9.9.9", exec: "/other/q" }, CLI, EXEC)).toBe("cli-older");
  });

  it("never reports cli-newer when the CLI version does not parse", () => {
    expect(checkSkew({ ok: true, version: "0.0.22", exec: EXEC }, "test", EXEC)).toBe("cli-older");
    expect(checkSkew({ ok: true, version: "test", exec: EXEC }, "test", EXEC)).toBe("match");
  });
});

describe("skew messages", () => {
  it("pins the exact user-facing strings", () => {
    expect(olderCliWarning("0.0.23")).toBe("daemon is newer (0.0.23); run 'quotacap update' to match it");
    expect(upgradedMessage("0.0.21", "0.0.22", "service")).toBe(
      "Upgraded daemon from 0.0.21 to 0.0.22 (service restarted)",
    );
    expect(upgradedMessage("0.0.21", "0.0.22", "daemon")).toBe(
      "Upgraded daemon from 0.0.21 to 0.0.22 (daemon restarted)",
    );
    expect(execSkewWarning("/other/q", CLI, EXEC)).toContain("/other/q");
    expect(execSkewWarning("/other/q", CLI, EXEC)).toContain(CLI);
    expect(unmanagedSkewWarning("0.0.21")).toContain("0.0.21");
    expect(unmanagedSkewWarning("0.0.21")).toContain("quotacap web");
  });

  it("formats wedged recovery without ever killing by PID", () => {
    const claim = {
      nonce: "n",
      pid: 4242,
      startedAt: "2026-09-11T00:00:00.000Z",
      version: "0.0.21",
      exec: "/old/quotacap",
      lastBeat: new Date().toISOString(),
    };
    const managed = formatWedged({ claim, port: 8787, managed: true });
    expect(managed).toContain("8787");
    expect(managed).toContain("quotacap service restart");
    expect(managed).not.toContain("kill");
    const unmanaged = formatWedged({ claim, port: 8787, managed: false });
    expect(unmanaged).toContain("/old/quotacap");
    expect(unmanaged).toContain("0.0.21");
    expect(unmanaged).toContain("4242");
    expect(unmanaged).toContain("ps -p 4242");
    const noClaim = formatWedged({ claim: null, port: 8787, managed: false });
    expect(noClaim).toContain("8787");
    expect(noClaim).not.toContain("kill <");
  });
});

describe("waitForHealthy / waitForRelease", () => {
  const instant = async () => {};

  it("waitForHealthy resolves once the CLI version reports ready", async () => {
    let calls = 0;
    const h = await waitForHealthy(1, "9.9.9-x", {
      sleep: instant,
      timeoutMs: 1000,
      createClient: () => ({
        get: async () => {
          calls++;
          return calls < 3
            ? { ok: true, ready: false, version: "old" }
            : { ok: true, ready: true, version: "9.9.9-x" };
        },
        post: async () => {
          throw new Error("unused");
        },
      }),
    });
    expect(h?.version).toBe("9.9.9-x");
    expect(calls).toBe(3);
  });

  it("waitForHealthy returns null on deadline", async () => {
    const h = await waitForHealthy(1, "9.9.9-x", {
      sleep: instant,
      timeoutMs: 30,
      createClient: () => ({
        get: async () => ({ ok: true, ready: true, version: "old" }),
        post: async () => {
          throw new Error("unused");
        },
      }),
    });
    expect(h).toBeNull();
  });

  it("waitForRelease needs both the port and the claim gone", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qc-takeover-"));
    try {
      // Claim present but port down: not released.
      fs.writeFileSync(
        path.join(dir, "service.lock"),
        JSON.stringify({ nonce: "n", pid: 1, lastBeat: new Date().toISOString() }),
      );
      const refusing = {
        get: async () => {
          throw new ServiceUnavailable("down");
        },
        post: async () => {
          throw new Error("unused");
        },
      };
      const stuck = await waitForRelease(1, dir, {
        sleep: instant,
        timeoutMs: 30,
        createClient: () => refusing,
      });
      expect(stuck).toBe(false);
      // Both gone: released.
      fs.rmSync(path.join(dir, "service.lock"));
      const free = await waitForRelease(1, dir, {
        sleep: instant,
        timeoutMs: 1000,
        createClient: () => refusing,
      });
      expect(free).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("takeoverManaged", () => {
  const instant = async () => {};

  it("restarts, verifies the CLI version, and reports the upgrade", async () => {
    const restarts: string[][] = [];
    let version = "0.0.21";
    const r = await takeoverManaged({
      port: 1,
      health: { ok: true, version: "0.0.21", exec: EXEC },
      cliVersion: CLI,
      sleep: instant,
      timeoutMs: 1000,
      execService: async (args) => {
        restarts.push(args);
        version = CLI;
        return 0;
      },
      createClient: () => ({
        get: async () => ({ ok: true, ready: true, version }),
        post: async () => {
          throw new Error("unused");
        },
      }),
    });
    expect(restarts).toEqual([["restart"]]);
    expect(r.oldVersion).toBe("0.0.21");
    expect(r.message).toBe(`Upgraded daemon from 0.0.21 to ${CLI} (service restarted)`);
  });

  it("fails loudly when restart exits nonzero", async () => {
    await expect(
      takeoverManaged({
        port: 1,
        health: { ok: true, version: "0.0.21" },
        cliVersion: CLI,
        sleep: instant,
        execService: async () => 1,
      }),
    ).rejects.toThrow(/service restart exited 1/);
  });

  it("refreshes the registration via install with the expected version", async () => {
    const calls: Array<{ args: string[]; opts?: Record<string, any> }> = [];
    let version = "0.0.21";
    const r = await takeoverManaged({
      port: 1,
      health: { ok: true, version: "0.0.21", exec: EXEC },
      cliVersion: CLI,
      refreshRegistration: true,
      sleep: instant,
      timeoutMs: 1000,
      execService: async (args, opts) => {
        calls.push({ args, opts });
        version = CLI;
        return 0;
      },
      createClient: () => ({
        get: async () => ({ ok: true, ready: true, version }),
        post: async () => {
          throw new Error("unused");
        },
      }),
    });
    expect(calls).toEqual([{ args: ["install"], opts: { version: CLI } }]);
    expect(r.oldVersion).toBe("0.0.21");
    expect(r.message).toBe(`Upgraded daemon from 0.0.21 to ${CLI} (service restarted)`);
  });

  it("fails loudly when the refresh install exits nonzero", async () => {
    await expect(
      takeoverManaged({
        port: 1,
        health: { ok: true, version: "0.0.21" },
        cliVersion: CLI,
        refreshRegistration: true,
        sleep: instant,
        execService: async () => 1,
      }),
    ).rejects.toThrow(/service install exited 1/);
  });

  it("fails loudly when the new version never reports", async () => {
    await expect(
      takeoverManaged({
        port: 1,
        health: { ok: true, version: "0.0.21" },
        cliVersion: CLI,
        sleep: instant,
        timeoutMs: 30,
        execService: async () => 0,
        createClient: () => ({
          get: async () => ({ ok: true, ready: true, version: "0.0.21" }),
          post: async () => {
            throw new Error("unused");
          },
        }),
      }),
    ).rejects.toThrow(TakeoverError);
  });
});

describe("takeoverUnmanaged", () => {
  const instant = async () => {};
  const health = { ok: true, version: "0.0.21", exec: EXEC };

  function releasedClient() {
    return {
      get: async () => {
        throw new ServiceUnavailable("down");
      },
      post: async () => ({ ok: true, restarting: true }),
    };
  }

  it("posts restart with the CLI identity and waits for release", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qc-takeover-u-"));
    try {
      const posts: Array<{ p: string; b: unknown }> = [];
      const seen: Array<{ token?: string }> = [];
      const r = await takeoverUnmanaged({
        port: 1,
        health,
        dataDir: dir,
        cliVersion: CLI,
        cliExec: EXEC,
        sleep: instant,
        timeoutMs: 1000,
        readToken: () => "tok",
        createClient: (o) => {
          seen.push(o);
          return {
            get: async () => {
              throw new ServiceUnavailable("down");
            },
            post: async (p: string, b?: unknown) => {
              posts.push({ p, b });
              return { ok: true, restarting: true };
            },
          };
        },
      });
      expect(r.oldVersion).toBe("0.0.21");
      expect(posts).toEqual([{ p: "/api/restart", b: { version: CLI, exec: EXEC } }]);
      expect(seen.some((o) => o.token === "tok")).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps a 404 restart to the wedged path with recovery text", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qc-takeover-404-"));
    try {
      const err = await takeoverUnmanaged({
        port: 1,
        health,
        dataDir: dir,
        cliVersion: CLI,
        sleep: instant,
        readToken: () => "tok",
        createClient: () => ({
          get: async () => ({ ok: true }),
          post: async () => {
            throw new ServiceError(404, "not found");
          },
        }),
      }).then(
        () => {
          throw new Error("unexpected success");
        },
        (e) => e,
      );
      expect(err).toBeInstanceOf(WedgedError);
      expect(String(err.message)).toContain("existing service mismatch");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps a missing token to the wedged path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qc-takeover-tok-"));
    try {
      const err = await takeoverUnmanaged({
        port: 1,
        health,
        dataDir: dir,
        cliVersion: CLI,
        sleep: instant,
        readToken: () => undefined,
      }).then(
        () => {
          throw new Error("unexpected success");
        },
        (e) => e,
      );
      expect(err).toBeInstanceOf(WedgedError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails loudly when the port never releases", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qc-takeover-hang-"));
    try {
      await expect(
        takeoverUnmanaged({
          port: 1,
          health,
          dataDir: dir,
          cliVersion: CLI,
          sleep: instant,
          timeoutMs: 30,
          readToken: () => "tok",
          createClient: () => ({
            get: async () => ({ ok: true, ready: true }),
            post: async () => ({ ok: true, restarting: true }),
          }),
        }),
      ).rejects.toThrow(/did not stop within/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the real CLI version by default", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
