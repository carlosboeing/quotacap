import { describe, it, expect, vi, afterEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectChannel,
  platformAssetName,
  printUpdateFooter,
  printVersionLine,
  readUpdateCache,
  refreshUpdateCache,
  releasesPageUrl,
  resolveLatestVersion,
  resolveLatestVersionDetailed,
  UPDATE_FAILURE_RETRY_MS,
  updateCacheStale,
  updateFooter,
  updateNpm,
  updateStandalone,
  verifyChecksum,
  writeUpdateCache,
} from "../../src/runtime/updates.js";

const savedEnv = { ...process.env };

afterEach(() => {
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
});

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("detectChannel", () => {
  const noPrefix = () => {
    throw new Error("must not consult prefixes");
  };

  it("npx wins on transient paths in exec or argv", () => {
    expect(
      detectChannel({ execPath: "/x/_npx/abc/quotacap", argv1: undefined, brewPrefix: noPrefix, npmPrefix: noPrefix }),
    ).toBe("npx");
    expect(
      detectChannel({
        execPath: "/usr/bin/node",
        argv1: "/Users/u/.npm/_npx/abc/node_modules/quotacap/dist/cli/index.js",
        brewPrefix: noPrefix,
        npmPrefix: noPrefix,
      }),
    ).toBe("npx");
  });

  it("brew matches Cellar shapes without subprocesses, else the brew prefix", () => {
    expect(
      detectChannel({
        execPath: "/opt/homebrew/Cellar/quotacap/0.0.22/bin/quotacap",
        argv1: undefined,
        brewPrefix: noPrefix,
        npmPrefix: noPrefix,
      }),
    ).toBe("brew");
    expect(
      detectChannel({
        execPath: "/foo/bin/quotacap",
        argv1: undefined,
        brewPrefix: () => "/foo",
        npmPrefix: noPrefix,
      }),
    ).toBe("brew");
    expect(
      detectChannel({
        execPath: "/foo/bin/quotacap",
        argv1: undefined,
        brewPrefix: () => null,
        npmPrefix: () => null,
      }),
    ).toBe("standalone");
  });

  it("source matches checkouts via src/cli/index.ts or .git, never bare words", () => {
    const root = tmpDir("qc-src-");
    try {
      fs.mkdirSync(path.join(root, "src", "cli"), { recursive: true });
      const entry = path.join(root, "dist", "cli", "index.js");
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(path.join(root, "src", "cli", "index.ts"), "x");
      fs.writeFileSync(entry, "x");
      // Source beats npm even under a matching prefix.
      expect(
        detectChannel({ execPath: "/usr/bin/node", argv1: entry, npmPrefix: () => root }),
      ).toBe("source");

      const wt = tmpDir("qc-wt-");
      try {
        fs.writeFileSync(path.join(wt, ".git"), "gitdir: elsewhere");
        const bin = path.join(wt, "run.mjs");
        fs.writeFileSync(bin, "x");
        expect(detectChannel({ execPath: "/usr/bin/node", argv1: bin })).toBe("source");
      } finally {
        fs.rmSync(wt, { recursive: true, force: true });
      }

      // A bare subcommand word is not a path, even inside a checkout.
      expect(
        detectChannel({ execPath: "/home/u/.local/bin/quotacap", argv1: "update" }),
      ).toBe("standalone");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("pnpm and yarn match their global markers", () => {
    expect(
      detectChannel({
        execPath: "/usr/bin/node",
        argv1: "/home/u/.local/share/pnpm/global/5/node_modules/quotacap/dist/cli/index.js",
      }),
    ).toBe("pnpm");
    expect(
      detectChannel({
        execPath: "/usr/bin/node",
        argv1: "/home/u/.local/share/pnpm/dist/cli/index.js",
      }),
    ).toBe("pnpm");
    expect(
      detectChannel({
        execPath: "/usr/bin/node",
        argv1: "/home/u/.config/yarn/global/node_modules/quotacap/dist/cli/index.js",
      }),
    ).toBe("yarn");
    expect(
      detectChannel({
        execPath: "/usr/bin/node",
        argv1: "/home/u/.yarn/releases/x.cjs",
      }),
    ).toBe("yarn");
  });

  it("npm needs a .js launcher under the global prefix", () => {
    expect(
      detectChannel({
        execPath: "/usr/bin/node",
        argv1: "/prefix/lib/node_modules/quotacap/dist/cli/index.js",
        npmPrefix: () => "/prefix",
      }),
    ).toBe("npm");
    // Same launcher outside the prefix is unknown, never npm.
    expect(
      detectChannel({
        execPath: "/usr/bin/node",
        argv1: "/other/app.js",
        npmPrefix: () => "/prefix",
      }),
    ).toBe("unknown");
    expect(
      detectChannel({
        execPath: "/usr/bin/node",
        argv1: "/prefix/lib/node_modules/quotacap/dist/cli/index.js",
        npmPrefix: () => null,
      }),
    ).toBe("unknown");
  });

  it("standalone needs a quotacap basename with no JS launcher", () => {
    expect(
      detectChannel({ execPath: "/home/u/.local/bin/quotacap", argv1: undefined }),
    ).toBe("standalone");
    expect(detectChannel({ execPath: "/usr/bin/node", argv1: undefined })).toBe("unknown");
  });

  it("npx beats source for transient paths inside checkouts", () => {
    const root = tmpDir("qc-npxsrc-");
    try {
      fs.mkdirSync(path.join(root, ".git"));
      const argv1 = path.join(root, "_npx", "x", "run.js");
      fs.mkdirSync(path.dirname(argv1), { recursive: true });
      fs.writeFileSync(argv1, "x");
      expect(detectChannel({ execPath: "/usr/bin/node", argv1 })).toBe("npx");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveLatestVersion", () => {
  function fakeFetch(body: unknown, ok = true, status = 200) {
    return (async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch;
  }

  it("reads the tag from the redirect Location without following it", async () => {
    delete process.env.QUOTACAP_RELEASE_BASE_URL;
    const seen: Array<{ url: string; init: any }> = [];
    const location = "https://github.com/carlosboeing/quotacap/releases/tag/v0.0.25";
    const r = await resolveLatestVersion({
      fetchFn: (async (url: any, init: any) => {
        seen.push({ url: String(url), init });
        return { ok: false, status: 302, headers: { location } };
      }) as unknown as typeof fetch,
    });
    expect(r).toEqual({ version: "0.0.25", url: location });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(releasesPageUrl());
    expect(seen[0].url).not.toContain("api.github.com");
    expect(seen[0].init?.redirect).toBe("manual");
  });

  it("accepts real Headers and any 3xx with a tag Location", async () => {
    delete process.env.QUOTACAP_RELEASE_BASE_URL;
    const location = "https://github.com/carlosboeing/quotacap/releases/tag/v1.2.3";
    const r = await resolveLatestVersion({
      fetchFn: (async () => ({
        ok: false,
        status: 301,
        headers: new Headers({ location }),
      })) as unknown as typeof fetch,
    });
    expect(r).toEqual({ version: "1.2.3", url: location });
  });

  it("returns null when the redirect is unusable, never throwing", async () => {
    delete process.env.QUOTACAP_RELEASE_BASE_URL;
    const redirectFetch = (status: number, location?: string) =>
      (async () => ({
        ok: status >= 200 && status < 300,
        status,
        headers: location ? { location } : {},
      })) as unknown as typeof fetch;
    // 200 with no redirect.
    expect(await resolveLatestVersion({ fetchFn: redirectFetch(200) })).toBeNull();
    // Redirect without a Location.
    expect(await resolveLatestVersion({ fetchFn: redirectFetch(302) })).toBeNull();
    // Location that is not a release tag.
    expect(
      await resolveLatestVersion({
        fetchFn: redirectFetch(302, "https://github.com/carlosboeing/quotacap"),
      }),
    ).toBeNull();
    // Tag that is not a version.
    expect(
      await resolveLatestVersion({
        fetchFn: redirectFetch(
          302,
          "https://github.com/carlosboeing/quotacap/releases/tag/not-a-version",
        ),
      }),
    ).toBeNull();
    // Network failure.
    expect(
      await resolveLatestVersion({
        fetchFn: (async () => {
          throw new Error("boom");
        }) as unknown as typeof fetch,
      }),
    ).toBeNull();
  });

  it("keeps the JSON behaviour when QUOTACAP_RELEASE_BASE_URL is set", async () => {
    process.env.QUOTACAP_RELEASE_BASE_URL = "http://127.0.0.1:9";
    const r = await resolveLatestVersion({
      fetchFn: fakeFetch({ tag_name: "v0.0.23", html_url: "https://x/notes" }),
    });
    expect(r).toEqual({ version: "0.0.23", url: "https://x/notes" });
  });

  it("returns null on the JSON path when the release cannot be resolved", async () => {
    process.env.QUOTACAP_RELEASE_BASE_URL = "http://127.0.0.1:9";
    expect(await resolveLatestVersion({ fetchFn: fakeFetch({}) })).toBeNull();
    expect(
      await resolveLatestVersion({ fetchFn: fakeFetch({ tag_name: "not-a-version" }) }),
    ).toBeNull();
    expect(
      await resolveLatestVersion({ fetchFn: fakeFetch({}, false, 404) }),
    ).toBeNull();
    expect(
      await resolveLatestVersion({
        fetchFn: (async () => {
          throw new Error("boom");
        }) as unknown as typeof fetch,
      }),
    ).toBeNull();
  });

  it("honors QUOTACAP_RELEASE_BASE_URL for hermetic simulations", async () => {
    process.env.QUOTACAP_RELEASE_BASE_URL = "http://127.0.0.1:9";
    const seen: string[] = [];
    await resolveLatestVersion({
      fetchFn: (async (url: any) => {
        seen.push(String(url));
        throw new Error("down");
      }) as unknown as typeof fetch,
      timeoutMs: 100,
    });
    expect(seen).toEqual(["http://127.0.0.1:9/api/releases/latest"]);
  });
});

describe("resolveLatestVersionDetailed", () => {
  const RESET = 1786840560; // fixed unix seconds; expectations derive from it

  function rateLimitedFetch(extraHeaders: Record<string, string> = {}) {
    return (async () => ({
      ok: false,
      status: 403,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(RESET),
        ...extraHeaders,
      },
    })) as unknown as typeof fetch;
  }

  it("reports ok with the parsed release", async () => {
    delete process.env.QUOTACAP_RELEASE_BASE_URL;
    const location = "https://github.com/carlosboeing/quotacap/releases/tag/v1.2.3";
    const r = await resolveLatestVersionDetailed({
      fetchFn: (async () => ({
        ok: false,
        status: 302,
        headers: { location },
      })) as unknown as typeof fetch,
    });
    expect(r).toEqual({ status: "ok", release: { version: "1.2.3", url: location } });
  });

  it("reports rate-limited with the reset time from headers", async () => {
    process.env.QUOTACAP_RELEASE_BASE_URL = "http://127.0.0.1:9";
    const r = await resolveLatestVersionDetailed({ fetchFn: rateLimitedFetch() });
    expect(r).toEqual({ status: "rate-limited", resetsAtMs: RESET * 1000 });
  });

  it("reports rate-limited without a reset when the header is missing or bad", async () => {
    process.env.QUOTACAP_RELEASE_BASE_URL = "http://127.0.0.1:9";
    const missing = await resolveLatestVersionDetailed({
      fetchFn: (async () => ({
        ok: false,
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      })) as unknown as typeof fetch,
    });
    expect(missing).toEqual({ status: "rate-limited", resetsAtMs: null });
    const bad = await resolveLatestVersionDetailed({
      fetchFn: rateLimitedFetch({ "x-ratelimit-reset": "soon" }),
    });
    expect(bad).toEqual({ status: "rate-limited", resetsAtMs: null });
  });

  it("reports unavailable for generic failures, never throwing", async () => {
    process.env.QUOTACAP_RELEASE_BASE_URL = "http://127.0.0.1:9";
    const notFound = await resolveLatestVersionDetailed({
      fetchFn: (async () => ({
        ok: false,
        status: 404,
        json: async () => ({}),
      })) as unknown as typeof fetch,
    });
    expect(notFound).toEqual({ status: "unavailable" });
    const down = await resolveLatestVersionDetailed({
      fetchFn: (async () => {
        throw new Error("boom");
      }) as unknown as typeof fetch,
    });
    expect(down).toEqual({ status: "unavailable" });
  });
});

describe("update cache", () => {
  it("round-trips valid caches and rejects invalid ones", () => {
    const dir = tmpDir("qc-cache-");
    try {
      const p = path.join(dir, ".quotacap", "updates.json");
      expect(readUpdateCache(p)).toBeNull();
      const cache = {
        checkedAt: new Date().toISOString(),
        latest: "0.0.23",
        channel: "standalone",
        current: "0.0.22",
      };
      writeUpdateCache(cache, p);
      expect(readUpdateCache(p)).toEqual(cache);
      fs.writeFileSync(p, "not json");
      expect(readUpdateCache(p)).toBeNull();
      fs.writeFileSync(p, JSON.stringify({ ...cache, latest: "bogus" }));
      expect(readUpdateCache(p)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("staleness is 24 hours or absent", () => {
    expect(updateCacheStale(null)).toBe(true);
    const now = Date.now();
    const fresh = {
      checkedAt: new Date(now - 1000).toISOString(),
      latest: "0.0.23",
      channel: "standalone",
      current: "0.0.22",
    };
    expect(updateCacheStale(fresh, now)).toBe(false);
    const old = { ...fresh, checkedAt: new Date(now - 25 * 3600 * 1000).toISOString() };
    expect(updateCacheStale(old, now)).toBe(true);
  });

  it("refresh skips fresh caches, writes new ones, keeps old on failure", async () => {
    process.env.QUOTACAP_RELEASE_BASE_URL = "http://127.0.0.1:9";
    const dir = tmpDir("qc-refresh-");
    try {
      const p = path.join(dir, "updates.json");
      const failFetch = (async () => {
        throw new Error("must not fetch");
      }) as unknown as typeof fetch;
      const fresh = {
        checkedAt: new Date().toISOString(),
        latest: "0.0.23",
        channel: "standalone",
        current: "0.0.22",
      };
      writeUpdateCache(fresh, p);
      expect(
        await refreshUpdateCache({ channel: "standalone", current: "0.0.22", cachePath: p, fetchFn: failFetch }),
      ).toEqual(fresh);

      const okFetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ tag_name: "v0.0.24", html_url: "https://x" }),
      })) as unknown as typeof fetch;
      const old = { ...fresh, checkedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString() };
      writeUpdateCache(old, p);
      const next = await refreshUpdateCache({
        channel: "standalone",
        current: "0.0.22",
        cachePath: p,
        fetchFn: okFetch,
      });
      expect(next?.latest).toBe("0.0.24");
      expect(readUpdateCache(p)?.latest).toBe("0.0.24");

      // Failure keeps the old latest and stamps the attempt for backoff.
      writeUpdateCache(old, p);
      const kept = await refreshUpdateCache({
        channel: "standalone",
        current: "0.0.22",
        cachePath: p,
        fetchFn: failFetch,
      });
      expect(kept).toMatchObject({ latest: old.latest, checkedAt: old.checkedAt });
      expect(kept?.lastFailureAt).toBeDefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads caches that predate lastFailureAt, rejects malformed stamps", () => {
    const dir = tmpDir("qc-cache-compat-");
    try {
      const p = path.join(dir, "updates.json");
      const legacy = {
        checkedAt: new Date().toISOString(),
        latest: "0.0.23",
        channel: "standalone",
        current: "0.0.22",
      };
      fs.writeFileSync(p, JSON.stringify(legacy));
      expect(readUpdateCache(p)).toEqual(legacy);
      fs.writeFileSync(p, JSON.stringify({ ...legacy, lastFailureAt: "not-a-date" }));
      expect(readUpdateCache(p)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backs off failed refreshes inside the retry floor without losing latest", async () => {
    process.env.QUOTACAP_RELEASE_BASE_URL = "http://127.0.0.1:9";
    const dir = tmpDir("qc-negcache-");
    try {
      const p = path.join(dir, "updates.json");
      const stale = {
        checkedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString(),
        latest: "0.0.23",
        channel: "standalone",
        current: "0.0.22",
      };
      writeUpdateCache(stale, p);
      let calls = 0;
      const failFetch = (async () => {
        calls++;
        throw new Error("down");
      }) as unknown as typeof fetch;
      const now = new Date();
      const first = await refreshUpdateCache({
        channel: "standalone",
        current: "0.0.22",
        cachePath: p,
        fetchFn: failFetch,
        now: () => now,
      });
      expect(calls).toBe(1);
      // checkedAt and latest untouched; only the failure stamp recorded.
      expect(first).toMatchObject({ checkedAt: stale.checkedAt, latest: "0.0.23" });
      expect(first?.lastFailureAt).toBe(now.toISOString());
      expect(readUpdateCache(p)).toEqual(first);

      // Second attempt inside the floor: no network call at all, latest kept.
      const second = await refreshUpdateCache({
        channel: "standalone",
        current: "0.0.22",
        cachePath: p,
        fetchFn: failFetch,
        now: () => new Date(now.getTime() + 60 * 1000),
      });
      expect(calls).toBe(1);
      expect(second).toEqual(first);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a late failure never clobbers an intervening successful write", async () => {
    process.env.QUOTACAP_RELEASE_BASE_URL = "http://127.0.0.1:9";
    const dir = tmpDir("qc-race-");
    try {
      const p = path.join(dir, "updates.json");
      writeUpdateCache(
        {
          checkedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString(),
          latest: "0.0.24",
          channel: "standalone",
          current: "0.0.22",
        },
        p,
      );
      let releaseA!: () => void;
      const gateA = new Promise<void>((r) => {
        releaseA = r;
      });
      const slowFail = (async () => {
        await gateA;
        throw new Error("down");
      }) as unknown as typeof fetch;
      const okFetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ tag_name: "v0.0.26", html_url: "https://x" }),
      })) as unknown as typeof fetch;

      // A starts first and blocks in the network; B runs to completion first.
      const pendingA = refreshUpdateCache({
        channel: "standalone",
        current: "0.0.22",
        cachePath: p,
        fetchFn: slowFail,
      });
      const b = await refreshUpdateCache({
        channel: "standalone",
        current: "0.0.22",
        cachePath: p,
        fetchFn: okFetch,
      });
      expect(b?.latest).toBe("0.0.26");
      releaseA();
      const a = await pendingA;
      // A's late failure preserves B's successful write, stamp-free.
      expect(a?.latest).toBe("0.0.26");
      expect(a).not.toHaveProperty("lastFailureAt");
      expect(readUpdateCache(p)).toEqual(a);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retries the network once the floor expires and clears the stamp on success", async () => {
    process.env.QUOTACAP_RELEASE_BASE_URL = "http://127.0.0.1:9";
    const dir = tmpDir("qc-negretry-");
    try {
      const p = path.join(dir, "updates.json");
      const now = Date.now();
      writeUpdateCache(
        {
          checkedAt: new Date(now - 25 * 3600 * 1000).toISOString(),
          latest: "0.0.23",
          channel: "standalone",
          current: "0.0.22",
          lastFailureAt: new Date(now - UPDATE_FAILURE_RETRY_MS - 1000).toISOString(),
        },
        p,
      );
      const okFetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ tag_name: "v0.0.24", html_url: "https://x" }),
      })) as unknown as typeof fetch;
      const next = await refreshUpdateCache({
        channel: "standalone",
        current: "0.0.22",
        cachePath: p,
        fetchFn: okFetch,
        now: () => new Date(now),
      });
      expect(next?.latest).toBe("0.0.24");
      expect(next).not.toHaveProperty("lastFailureAt");
      expect(readUpdateCache(p)).toEqual(next);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("update footer", () => {
  it("shows only when a newer latest is known", () => {
    expect(updateFooter("0.0.22", "0.0.23")).toBe(
      "Update available: 0.0.22 -> 0.0.23. Run 'quotacap update' to upgrade.",
    );
    expect(updateFooter("0.0.23", "0.0.23")).toBeNull();
    expect(updateFooter("0.0.24", "0.0.23")).toBeNull();
    expect(updateFooter("0.0.22", null)).toBeNull();
  });

  it("prints to stderr only on TTY and never under --json", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const desc = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    try {
      Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
      printUpdateFooter({}, "Update available: 0.0.22 -> 0.0.23. Run 'quotacap update' to upgrade.");
      expect(errSpy).toHaveBeenCalledTimes(1);
      printUpdateFooter({ json: true }, "x");
      expect(errSpy).toHaveBeenCalledTimes(1);
      printUpdateFooter({}, null);
      expect(errSpy).toHaveBeenCalledTimes(1);
      Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
      printUpdateFooter({}, "x");
      expect(errSpy).toHaveBeenCalledTimes(1);
    } finally {
      if (desc) Object.defineProperty(process.stderr, "isTTY", desc);
    }
  });

  it("prints the CLI version, naming the daemon only when it differs", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const desc = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    try {
      Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
      printVersionLine({}, "0.0.26", "0.0.26");
      expect(errSpy).toHaveBeenCalledWith("quotacap 0.0.26");
      printVersionLine({}, "0.0.26", "99.0.0");
      expect(errSpy).toHaveBeenCalledWith("quotacap 0.0.26 · daemon 99.0.0");
      for (const unknown of [null, undefined, "", 42]) {
        errSpy.mockClear();
        printVersionLine({}, "0.0.26", unknown);
        expect(errSpy).toHaveBeenCalledWith("quotacap 0.0.26");
      }
    } finally {
      if (desc) Object.defineProperty(process.stderr, "isTTY", desc);
    }
  });

  it("stays silent under --json, --compact, and piped stderr", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const desc = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    try {
      Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
      printVersionLine({ json: true }, "0.0.26", "0.0.26");
      printVersionLine({ compact: true }, "0.0.26", "0.0.26");
      expect(errSpy).not.toHaveBeenCalled();
      Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
      printVersionLine({}, "0.0.26", "0.0.26");
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      if (desc) Object.defineProperty(process.stderr, "isTTY", desc);
    }
  });
});

describe("verifyChecksum", () => {
  const data = Buffer.from("fake-tarball-bytes");
  const hex = crypto.createHash("sha256").update(data).digest("hex");

  it("matches install.sh semantics", () => {
    expect(verifyChecksum(data, `${hex}  quotacap-darwin-arm64.tar.gz\n`, "quotacap-darwin-arm64.tar.gz")).toBe(true);
    expect(verifyChecksum(data, `${hex.toUpperCase()} *quotacap-darwin-arm64.tar.gz\r\n`, "quotacap-darwin-arm64.tar.gz")).toBe(true);
    expect(verifyChecksum(data, `${"0".repeat(64)}  quotacap-darwin-arm64.tar.gz\n`, "quotacap-darwin-arm64.tar.gz")).toBe(false);
    expect(verifyChecksum(data, `${hex}  other.tar.gz\n`, "quotacap-darwin-arm64.tar.gz")).toBe(false);
  });
});

describe("platformAssetName", () => {
  it("maps node platforms to release assets", () => {
    expect(platformAssetName("darwin", "arm64")).toBe("quotacap-darwin-arm64.tar.gz");
    expect(platformAssetName("linux", "x64")).toBe("quotacap-linux-x64.tar.gz");
    expect(() => platformAssetName("win32", "x64")).toThrow(/unsupported platform/);
  });
});

describe("updateStandalone", () => {
  const asset = "quotacap-darwin-arm64.tar.gz";
  const tarball = Buffer.from("fake-tarball-bytes");

  function sumsFor(buf: Buffer): string {
    const hex = crypto.createHash("sha256").update(buf).digest("hex");
    return `${hex}  ${asset}\n`;
  }

  function fakeFetch(tar: Buffer, status = 200, sumOf: Buffer = tar) {
    return (async (url: any) => {
      const u = String(url);
      if (u.endsWith("/SHA256SUMS")) {
        return { ok: status === 200, status, text: async () => sumsFor(sumOf) };
      }
      return {
        ok: status === 200,
        status,
        arrayBuffer: async () => tar,
      };
    }) as unknown as typeof fetch;
  }

  function fakeExtract(files: Record<string, string>) {
    return (tarballPath: string, destDir: string) => {
      expect(fs.existsSync(tarballPath)).toBe(true);
      for (const [rel, content] of Object.entries(files)) {
        const p = path.join(destDir, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
      }
    };
  }

  it("swaps the binary and both sidecars after verifying", async () => {
    const root = tmpDir("qc-swap-");
    try {
      const binDir = path.join(root, "bin");
      fs.mkdirSync(binDir, { recursive: true });
      const execPath = path.join(binDir, "quotacap");
      fs.writeFileSync(execPath, "old-binary");
      const r = await updateStandalone({
        target: "0.0.23",
        execPath,
        homeDir: root,
        platform: "darwin",
        arch: "arm64",
        fetchFn: fakeFetch(tarball),
        extractTar: fakeExtract({
          quotacap: "new-binary",
          "pty/node-pty/prebuilds/darwin-arm64/spawn-helper": "helper",
        }),
      });
      expect(r).toEqual({ ok: true });
      expect(fs.readFileSync(execPath, "utf8")).toBe("new-binary");
      expect(fs.statSync(execPath).mode & 0o111).toBe(0o111);
      expect(fs.readFileSync(path.join(binDir, "pty", "node-pty", "prebuilds", "darwin-arm64", "spawn-helper"), "utf8")).toBe("helper");
      expect(
        fs.readFileSync(path.join(root, ".local", "share", "quotacap", "pty", "node-pty", "prebuilds", "darwin-arm64", "spawn-helper"), "utf8"),
      ).toBe("helper");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("aborts before touching the binary on checksum mismatch", async () => {
    const root = tmpDir("qc-swapsum-");
    try {
      const binDir = path.join(root, "bin");
      fs.mkdirSync(binDir, { recursive: true });
      const execPath = path.join(binDir, "quotacap");
      fs.writeFileSync(execPath, "old-binary");
      let extracted = false;
      const r = await updateStandalone({
        target: "0.0.23",
        execPath,
        homeDir: root,
        platform: "darwin",
        arch: "arm64",
        fetchFn: fakeFetch(Buffer.from("tampered-bytes"), 200, tarball),
        extractTar: () => {
          extracted = true;
        },
      });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/checksum mismatch/);
      expect(extracted).toBe(false);
      expect(fs.readFileSync(execPath, "utf8")).toBe("old-binary");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses unwritable install dirs with the installer remedy", async () => {
    const root = tmpDir("qc-swapro-");
    try {
      const binDir = path.join(root, "bin");
      fs.mkdirSync(binDir, { recursive: true });
      const execPath = path.join(binDir, "quotacap");
      fs.writeFileSync(execPath, "old-binary");
      fs.chmodSync(binDir, 0o555);
      try {
        const r = await updateStandalone({
          target: "0.0.23",
          execPath,
          homeDir: root,
          platform: "darwin",
          arch: "arm64",
          fetchFn: fakeFetch(tarball),
        });
        expect(r.ok).toBe(false);
        expect(r.error).toContain(binDir);
        expect(r.error).toMatch(/re-run the installer/);
      } finally {
        fs.chmodSync(binDir, 0o755);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses targets that are not quotacap binaries", async () => {
    const root = tmpDir("qc-swapguard-");
    try {
      const other = path.join(root, "node");
      fs.writeFileSync(other, "precious-runtime");
      const r = await updateStandalone({
        target: "0.0.23",
        execPath: other,
        homeDir: root,
        platform: "darwin",
        arch: "arm64",
        fetchFn: fakeFetch(tarball),
      });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/not a quotacap binary/);
      expect(fs.readFileSync(other, "utf8")).toBe("precious-runtime");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails loudly on download errors and missing binaries", async () => {
    const root = tmpDir("qc-swapdl-");
    try {
      const binDir = path.join(root, "bin");
      fs.mkdirSync(binDir, { recursive: true });
      const execPath = path.join(binDir, "quotacap");
      fs.writeFileSync(execPath, "old-binary");
      const dl = await updateStandalone({
        target: "0.0.23",
        execPath,
        homeDir: root,
        platform: "darwin",
        arch: "arm64",
        fetchFn: fakeFetch(tarball, 404),
      });
      expect(dl.ok).toBe(false);
      expect(dl.error).toMatch(/download failed/);
      const missing = await updateStandalone({
        target: "0.0.23",
        execPath,
        homeDir: root,
        platform: "darwin",
        arch: "arm64",
        fetchFn: fakeFetch(tarball),
        extractTar: fakeExtract({ "pty/nothing": "x" }),
      });
      expect(missing.ok).toBe(false);
      expect(missing.error).toMatch(/did not contain the quotacap binary/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("updateNpm", () => {
  it("warns on shadow binaries and spawns the global install", async () => {
    const root = tmpDir("qc-npm-");
    try {
      const shadowDir = path.join(root, ".local", "bin");
      fs.mkdirSync(shadowDir, { recursive: true });
      const shadow = path.join(shadowDir, "quotacap");
      fs.writeFileSync(shadow, "stale-binary");
      const spawns: string[][] = [];
      const r = await updateNpm({
        target: "latest",
        execPath: "/prefix/bin/node",
        homeDir: root,
        spawnNpm: async (args) => {
          spawns.push(args);
          return 0;
        },
      });
      expect(r.ok).toBe(true);
      expect(spawns).toEqual([["install", "-g", "quotacap@latest"]]);
      expect(r.shadowWarning).toContain(shadow);
      expect(r.shadowWarning).toMatch(/remove one of them/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("stays silent without shadows and reports spawn failures", async () => {
    const root = tmpDir("qc-npm2-");
    try {
      const ok = await updateNpm({
        target: "0.0.23",
        execPath: "/prefix/bin/node",
        homeDir: root,
        spawnNpm: async () => 0,
      });
      expect(ok).toEqual({ ok: true, shadowWarning: undefined });
      const bad = await updateNpm({
        target: "latest",
        execPath: "/prefix/bin/node",
        homeDir: root,
        spawnNpm: async () => 1,
      });
      expect(bad.ok).toBe(false);
      expect(bad.error).toContain("exited 1");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
