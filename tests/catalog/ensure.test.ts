import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openDb, migrate } from "../../src/store/db.js";
import { getCatalog, upsertCatalog, markCatalogFailure } from "../../src/store/catalogs.js";
import type { CatalogFetcher, ListedModel } from "../../src/catalog/types.js";

type IndexMod = typeof import("../../src/catalog/index.js");

const T0 = Date.parse("2026-09-16T12:00:00.000Z");
const HOUR = 3600_000;

function makeDb() {
  const d = openDb(":memory:");
  migrate(d);
  return d;
}

function spyFetcher(id: string, impl: () => Promise<Record<string, ListedModel[]>>) {
  const fetch = vi.fn(impl);
  return { fetch, fetchers: { [id]: { id, fetch } as CatalogFetcher } };
}

// lastFailAt and the in-flight map are module-level process state; a fresh
// module per test keeps each case on a clean slate (process-restart shape).
let mod: IndexMod;
beforeEach(async () => {
  vi.resetModules();
  mod = await import("../../src/catalog/index.js");
});

describe("ensureCatalogs", () => {
  it("wait:false does not call fetch when TTL expired", async () => {
    const d = makeDb();
    upsertCatalog(d, "fake", [{ id: "m1", displayName: "M1" }], new Date(T0 - 7 * HOUR).toISOString());
    const { fetch, fetchers } = spyFetcher("fake", async () => ({ fake: [{ id: "m2", displayName: "M2" }] }));
    const out = await mod.ensureCatalogs({
      db: d, wait: false, providers: ["fake"], ttlHours: 6, now: () => new Date(T0), fetchers,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(out.get("fake")?.status).toBe("ok");
    expect(out.get("fake")?.listed.map((m) => m.id)).toEqual(["m1"]);
  });

  it("wait:true fetches when TTL expired", async () => {
    const d = makeDb();
    upsertCatalog(d, "fake", [{ id: "m1", displayName: "M1" }], new Date(T0 - 7 * HOUR).toISOString());
    const { fetch, fetchers } = spyFetcher("fake", async () => ({ fake: [{ id: "m2", displayName: "M2" }] }));
    const out = await mod.ensureCatalogs({
      db: d, wait: true, providers: ["fake"], ttlHours: 6, now: () => new Date(T0), fetchers,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(out.get("fake")?.status).toBe("ok");
    expect(out.get("fake")?.listed.map((m) => m.id)).toEqual(["m2"]);
    expect(getCatalog(d, "fake").fetchedAt).toBe(new Date(T0).toISOString());
  });

  it("coalesces two waiters", async () => {
    const d = makeDb();
    const { fetch, fetchers } = spyFetcher(
      "fake",
      () => new Promise((r) => setTimeout(() => r({ fake: [{ id: "m9", displayName: "M9" }] }), 50)),
    );
    const [a, b] = await Promise.all([
      mod.ensureCatalogs({ db: d, wait: true, providers: ["fake"], ttlHours: 6, now: () => new Date(T0), fetchers }),
      mod.ensureCatalogs({ db: d, wait: true, providers: ["fake"], ttlHours: 6, now: () => new Date(T0), fetchers }),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(a.get("fake")?.listed.map((m) => m.id)).toEqual(["m9"]);
    expect(b.get("fake")?.listed.map((m) => m.id)).toEqual(["m9"]);
  });

  it("stale inside TTL retries after cooldown", async () => {
    const d = makeDb();
    upsertCatalog(d, "fake", [{ id: "m1", displayName: "M1" }], new Date(T0 - HOUR).toISOString());
    let clock = T0;
    const now = () => new Date(clock);
    const { fetch, fetchers } = spyFetcher("fake", async () => {
      throw new Error("boom");
    });
    // Arm the cooldown with a failed forced refresh (ensureCatalogs itself ran
    // the fetch), not with a bare markCatalogFailure.
    await mod.ensureCatalogs({ db: d, wait: true, refresh: true, providers: ["fake"], ttlHours: 6, now, fetchers });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(getCatalog(d, "fake").status).toBe("stale");
    // Row is stale but inside TTL; the armed cooldown blocks an immediate retry.
    await mod.ensureCatalogs({ db: d, wait: true, providers: ["fake"], ttlHours: 6, now, fetchers });
    expect(fetch).toHaveBeenCalledTimes(1);
    clock += 61_000;
    await mod.ensureCatalogs({ db: d, wait: true, providers: ["fake"], ttlHours: 6, now, fetchers });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("persisted stale with empty lastFailAt retries immediately", async () => {
    const d = makeDb();
    upsertCatalog(d, "fake", [{ id: "m1", displayName: "M1" }], new Date(T0 - HOUR).toISOString());
    // Direct SQLite write, as a prior process would have left it; this module
    // instance (fresh from beforeEach) has no cooldown memory.
    markCatalogFailure(d, "fake", {
      diagnosticCode: "timeout", summary: "timed out", action: "retry", errorDetail: "timeout",
    });
    expect(getCatalog(d, "fake").status).toBe("stale");
    const { fetch, fetchers } = spyFetcher("fake", async () => ({ fake: [{ id: "m3", displayName: "M3" }] }));
    await mod.ensureCatalogs({
      db: d, wait: true, providers: ["fake"], ttlHours: 6, now: () => new Date(T0), fetchers,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(getCatalog(d, "fake").status).toBe("ok");
    expect(getCatalog(d, "fake").listed.map((m) => m.id)).toEqual(["m3"]);
  });

  it("usage-poll abort does not kill a catalog exec", async () => {
    const spawn = await import("../../src/runtime/spawn.js");
    const usageAbort = new AbortController();
    spawn.installAdapterSignal("agy", usageAbort.signal);
    const seenSignals: (AbortSignal | undefined)[] = [];
    const execSpy = vi.spyOn(spawn, "trackedExecFile").mockImplementation(async (_id, _file, _args, opts) => {
      seenSignals.push(opts?.signal);
      await new Promise((r) => setTimeout(r, 60));
      if (opts?.signal?.aborted) throw new Error("agy: aborted");
      return {
        stdout:
          "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n" +
          "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n",
        stderr: "",
      };
    });
    try {
      const d = makeDb();
      // Real agy fetcher (no injected fetchers): the wrapper must pass its own
      // signal, so aborting the usage-poll controller cannot kill this exec.
      const pending = mod.ensureCatalogs({
        db: d, wait: true, providers: ["agy:3p"], ttlHours: 6, now: () => new Date(T0),
      });
      await new Promise((r) => setTimeout(r, 20));
      usageAbort.abort();
      const out = await pending;
      expect(execSpy).toHaveBeenCalledTimes(1);
      expect(seenSignals[0]).toBeDefined();
      expect(seenSignals[0]).not.toBe(usageAbort.signal);
      expect(seenSignals[0]?.aborted).toBe(false);
      expect(out.get("agy:3p")?.status).toBe("ok");
      expect(out.get("agy:3p")?.listed.map((m) => m.id)).toEqual(["claude-sonnet-4-6"]);
      expect(getCatalog(d, "agy").listed.map((m) => m.id)).toEqual(["gemini-3.8-flash-high"]);
    } finally {
      execSpy.mockRestore();
      spawn.clearAdapterSignal("agy");
    }
  });

  it("does not use ADAPTER_TIMEOUTS", async () => {
    const src = fs.readFileSync(path.join(__dirname, "../../src/catalog/index.ts"), "utf8");
    expect(src).not.toMatch(/ADAPTER_TIMEOUTS/);
    expect(src).not.toMatch(/installAdapterSignal/);
  });

  it("fetches nothing on a waiting read when the row is ok inside TTL", async () => {
    const d = makeDb();
    upsertCatalog(d, "fake", [{ id: "m1", displayName: "M1" }], new Date(T0 - HOUR).toISOString());
    const { fetch, fetchers } = spyFetcher("fake", async () => ({ fake: [{ id: "m2", displayName: "M2" }] }));
    const out = await mod.ensureCatalogs({
      db: d, wait: true, providers: ["fake"], ttlHours: 6, now: () => new Date(T0), fetchers,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(out.get("fake")?.listed.map((m) => m.id)).toEqual(["m1"]);
  });

  it("refresh forces a fetch inside TTL", async () => {
    const d = makeDb();
    upsertCatalog(d, "fake", [{ id: "m1", displayName: "M1" }], new Date(T0 - HOUR).toISOString());
    const { fetch, fetchers } = spyFetcher("fake", async () => ({ fake: [{ id: "m2", displayName: "M2" }] }));
    await mod.ensureCatalogs({
      db: d, wait: true, refresh: true, providers: ["fake"], ttlHours: 6, now: () => new Date(T0), fetchers,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(getCatalog(d, "fake").listed.map((m) => m.id)).toEqual(["m2"]);
  });

  it("agy:3p resolves to the agy fetcher and one fetch writes both buckets", async () => {
    const d = makeDb();
    const { fetch, fetchers } = spyFetcher("agy", async () => ({
      agy: [{ id: "gemini-3.8-flash-high", displayName: "Gemini 3.8 Flash (High)" }],
      "agy:3p": [{ id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6 (Thinking)" }],
    }));
    const out = await mod.ensureCatalogs({
      db: d, wait: true, providers: ["agy:3p"], ttlHours: 6, now: () => new Date(T0), fetchers,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(getCatalog(d, "agy").status).toBe("ok");
    expect(getCatalog(d, "agy").listed.map((m) => m.id)).toEqual(["gemini-3.8-flash-high"]);
    expect(out.get("agy:3p")?.status).toBe("ok");
    expect(out.get("agy:3p")?.listed.map((m) => m.id)).toEqual(["claude-sonnet-4-6"]);
  });

  it("manual is skipped", async () => {
    const d = makeDb();
    const { fetch, fetchers } = spyFetcher("manual", async () => ({ manual: [] }));
    const out = await mod.ensureCatalogs({
      db: d, wait: true, providers: ["manual"], ttlHours: 6, now: () => new Date(T0), fetchers,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(out.get("manual")?.status).toBe("unfetched");
  });

  it("a thrown fetch marks an error row and the cooldown blocks an immediate retry", async () => {
    const d = makeDb();
    const { fetch, fetchers } = spyFetcher("fake", async () => {
      throw new Error("boom");
    });
    const out = await mod.ensureCatalogs({
      db: d, wait: true, providers: ["fake"], ttlHours: 6, now: () => new Date(T0), fetchers,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const v = out.get("fake");
    expect(v?.status).toBe("error");
    expect(v?.listed).toEqual([]);
    expect(v?.fetchedAt).toBeNull();
    expect(v?.diagnosticCode).toBeTruthy();
    await mod.ensureCatalogs({
      db: d, wait: true, providers: ["fake"], ttlHours: 6, now: () => new Date(T0), fetchers,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a thrown agy fetch marks both agy buckets", async () => {
    const d = makeDb();
    const { fetch, fetchers } = spyFetcher("agy", async () => {
      throw new Error("boom");
    });
    await mod.ensureCatalogs({
      db: d, wait: true, providers: ["agy:3p"], ttlHours: 6, now: () => new Date(T0), fetchers,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(getCatalog(d, "agy").status).toBe("error");
    expect(getCatalog(d, "agy:3p").status).toBe("error");
  });

  it("unknown providers are served from cache only", async () => {
    const d = makeDb();
    const out = await mod.ensureCatalogs({
      db: d, wait: true, providers: ["bogus"], ttlHours: 6, now: () => new Date(T0), fetchers: {},
    });
    expect(out.get("bogus")?.status).toBe("unfetched");
  });
});
