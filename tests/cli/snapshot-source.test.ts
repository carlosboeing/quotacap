import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  projectQuotasResponse,
  projectRecommendationResponse,
} from "../../src/advisory/snapshot.js";
import { createServiceClient, ServiceError, ServiceUnavailable } from "../../src/runtime/client.js";
import { VERSION } from "../../src/version.js";
import { openDb } from "../../src/store/db.js";
import { renderWide, renderNarrow } from "../../src/format/terminal.js";
import {
  ClientError,
  emptySnapshot,
  openOfflineDb,
  resolveSnapshot,
  toClientError,
} from "../../src/cli/snapshot-source.js";
import { ENABLED, FIXED_NOW, exampleStateSnapshot, exampleStateSnapshotJson } from "../fixtures/stable-state.js";
import { seedEmptyDb, seedFileDb, seedLegacyDb } from "./helpers.js";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

async function startStub(routes: Record<string, Handler>): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const handler = routes[req.url ?? ""];
    if (handler) handler(req, res);
    else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

async function closedPort(): Promise<number> {
  const stub = await startStub({});
  const { port } = stub;
  await stub.close();
  return port;
}

const tmpDirs: string[] = [];
function tmpDb(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qc-snap-"));
  tmpDirs.push(dir);
  return path.join(dir, name);
}
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function catchError(fn: () => Promise<unknown>): Promise<any> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected to throw");
}

describe("online snapshot", () => {
  it("returns the service snapshot with source service", async () => {
    const stub = await startStub({
      "/api/state": (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(exampleStateSnapshotJson);
      },
    });
    try {
      const dbPath = tmpDb("missing.db");
      const resolved = await resolveSnapshot({
        client: createServiceClient({ port: stub.port, timeoutMs: 2000 }),
        dbPath,
        enabledProviders: ENABLED,
        now: FIXED_NOW,
      });
      expect(resolved.source).toBe("service");
      expect(resolved.snapshot).toEqual(exampleStateSnapshot);
      expect(resolved.asOf).toBe(exampleStateSnapshot.asOf);
      expect(fs.existsSync(dbPath)).toBe(false);
    } finally {
      await stub.close();
    }
  });

  // A service predating the naming standard omits displayName, vendor,
  // harness and description. Render sites treat displayName as always
  // present, so an unfilled field crashes `status` outright.
  it("fills naming fields a pre-naming service omits", async () => {
    const legacy = JSON.parse(exampleStateSnapshotJson);
    for (const p of legacy.providers) {
      delete p.displayName;
      delete p.vendor;
      delete p.harness;
      delete p.description;
    }
    const stub = await startStub({
      "/api/state": (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(legacy));
      },
    });
    try {
      const resolved = await resolveSnapshot({
        client: createServiceClient({ port: stub.port, timeoutMs: 2000 }),
        dbPath: tmpDb("missing.db"),
        enabledProviders: ENABLED,
        now: FIXED_NOW,
      });
      expect(resolved.source).toBe("service");
      expect(resolved.snapshot.providers.length).toBeGreaterThan(0);
      for (const p of resolved.snapshot.providers) {
        expect(p.displayName).toBe(p.id);
        expect(p.vendor).toBeNull();
        expect(p.harness).toBeNull();
        expect(p.description).toBeNull();
      }
      // The crash was in the width calculation, so render for real.
      expect(() => renderWide(resolved.snapshot, { now: FIXED_NOW })).not.toThrow();
      expect(() => renderNarrow(resolved.snapshot, { now: FIXED_NOW })).not.toThrow();
    } finally {
      await stub.close();
    }
  });
});

describe("offline fallback (D3, D10)", () => {
  it("falls back to the seeded file DB with identical projector output", async () => {
    const dbPath = seedFileDb(tmpDb("offline.db"));
    const resolved = await resolveSnapshot({
      client: createServiceClient({ port: await closedPort(), timeoutMs: 1000 }),
      dbPath,
      enabledProviders: ENABLED,
      now: FIXED_NOW,
    });
    expect(resolved.source).toBe("offline");
    expect(resolved.asOf).toBe(FIXED_NOW.toISOString());
    expect(resolved.snapshot.runtime.available).toBe(false);
    expect(projectQuotasResponse(resolved.snapshot)).toEqual(projectQuotasResponse(exampleStateSnapshot));
    expect(projectRecommendationResponse(resolved.snapshot)).toEqual(exampleStateSnapshot.recommendation);
  });

  it("missing DB file is no-data, never an error, and creates nothing", async () => {
    const dbPath = tmpDb("absent.db");
    const port = await closedPort();
    const err = await catchError(() =>
      resolveSnapshot({
        client: createServiceClient({ port, timeoutMs: 1000 }),
        dbPath,
        enabledProviders: ENABLED,
        now: FIXED_NOW,
      }),
    );
    expect(err).toBeInstanceOf(ClientError);
    expect(err.kind).toBe("no-data");
    expect(err.message).toMatch(/no quotas yet/);
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it("empty and zero-byte databases are no-data", async () => {
    const emptyPath = seedEmptyDb(tmpDb("empty.db"));
    const zeroPath = tmpDb("zero.db");
    fs.writeFileSync(zeroPath, "");
    const port = await closedPort();
    for (const dbPath of [emptyPath, zeroPath]) {
      const err = await catchError(() =>
        resolveSnapshot({
          client: createServiceClient({ port, timeoutMs: 1000 }),
          dbPath,
          enabledProviders: ENABLED,
          now: FIXED_NOW,
        }),
      );
      expect(err).toBeInstanceOf(ClientError);
      expect(err.kind).toBe("no-data");
    }
  });

  it("legacy schema yields incompatible-schema and leaves the file byte-identical", async () => {
    const dbPath = seedLegacyDb(tmpDb("legacy.db"));
    const before = fs.readFileSync(dbPath);
    const port = await closedPort();
    const err = await catchError(() =>
      resolveSnapshot({
        client: createServiceClient({ port, timeoutMs: 1000 }),
        dbPath,
        enabledProviders: ENABLED,
        now: FIXED_NOW,
      }),
    );
    expect(err).toBeInstanceOf(ClientError);
    expect(err.kind).toBe("incompatible-schema");
    expect(err.message).toMatch(/incompatible-schema/);
    expect(err.message).toMatch(/quotacap web/);
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
  });

  it("offline handles reject writes (PRAGMA query_only proof)", () => {
    const dbPath = seedFileDb(tmpDb("readonly.db"));
    const db = openOfflineDb(dbPath);
    try {
      expect(db.prepare("PRAGMA query_only").get()).toEqual({ query_only: 1 });
      expect(() =>
        db.prepare("INSERT INTO quotas(provider) VALUES(?)").run("probe"),
      ).toThrow();
      expect(() => db.exec("CREATE TABLE probe(x)")).toThrow();
    } finally {
      db.close();
    }
  });

  it("reads pre-observability schema offline without migrating and leaves file byte-identical", async () => {
    const dbPath = tmpDb("pre-observability.db");
    const db = openDb(dbPath);
    db.exec(`CREATE TABLE quotas(id INTEGER PRIMARY KEY, provider TEXT, plan TEXT, used_pct REAL, resets_at TEXT, period_start TEXT, source TEXT, fetched_at TEXT, credits_usd REAL, resets_at_estimated INTEGER, session_pct REAL);
             CREATE TABLE snapshots(day TEXT, provider TEXT, used_pct REAL, burn_rate REAL, ideal_rate REAL, PRIMARY KEY(day, provider));
             CREATE TABLE adapter_attempts(provider TEXT PRIMARY KEY, attempted_at TEXT NOT NULL, completed_at TEXT, succeeded_at TEXT, success INTEGER NOT NULL, failure_category TEXT);
             CREATE INDEX idx_quotas_provider ON quotas(provider);`);
    db.exec(`INSERT INTO quotas(provider, plan, used_pct, resets_at, period_start, source, fetched_at, session_pct)
             VALUES('kimi', 'p', 30, '2026-09-14T06:00:00+10:00', '2026-08-31T06:00:00+10:00', 'cli', '${FIXED_NOW.toISOString()}', 10)`);
    db.exec(`INSERT INTO adapter_attempts(provider, attempted_at, completed_at, succeeded_at, success, failure_category)
             VALUES('kimi', '${FIXED_NOW.toISOString()}', '${FIXED_NOW.toISOString()}', NULL, 0, 'parse')`);
    db.close();

    const before = fs.readFileSync(dbPath);
    const resolved = await resolveSnapshot({
      client: createServiceClient({ port: await closedPort(), timeoutMs: 1000 }),
      dbPath,
      enabledProviders: ["kimi"],
      now: FIXED_NOW,
    });

    expect(resolved.source).toBe("offline");
    const kimi = resolved.snapshot.providers.find((p) => p.id === "kimi")!;
    expect(kimi.lastAttempt?.failureCategory).toBe("parse");
    expect(kimi.lastAttempt?.diagnosticCode).toBeNull();
    expect(kimi.lastAttempt?.summary).toBeNull();
    expect(kimi.lastAttempt?.action).toBeNull();
    expect(kimi.lastAttempt?.errorDetail).toBeNull();
    expect(kimi.lastAttempt?.error).toBeNull();

    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
  });
});

describe("live-service failures never fall back", () => {
  it("HTTP 500 yields service-error with no fallback", async () => {
    const dbPath = seedFileDb(tmpDb("ignored.db"));
    const stub = await startStub({
      "/api/state": (_req, res) => {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: "boom" }));
      },
    });
    try {
      const err = await catchError(() =>
        resolveSnapshot({
          client: createServiceClient({ port: stub.port, timeoutMs: 2000 }),
          dbPath,
          enabledProviders: ENABLED,
          now: FIXED_NOW,
        }),
      );
      expect(err).toBeInstanceOf(ClientError);
      expect(err.kind).toBe("service-error");
      expect(err.message).toMatch(/service-error/);
      expect(err.message).toMatch(/500/);
    } finally {
      await stub.close();
    }
  });

  it("/api/state 404 with an old /health version yields incompatible-service naming both", async () => {
    const stub = await startStub({
      "/api/state": (_req, res) => {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
      },
      "/health": (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, version: "0.0.1" }));
      },
    });
    try {
      const err = await catchError(() =>
        resolveSnapshot({
          client: createServiceClient({ port: stub.port, timeoutMs: 2000 }),
          dbPath: tmpDb("unused.db"),
          enabledProviders: ENABLED,
          now: FIXED_NOW,
        }),
      );
      expect(err).toBeInstanceOf(ClientError);
      expect(err.kind).toBe("incompatible-service");
      expect(err.message).toMatch(/incompatible-service/);
      expect(err.message).toMatch(/0\.0\.1/);
      expect(err.message).toMatch(new RegExp(VERSION.replace(/\./g, "\\.")));
    } finally {
      await stub.close();
    }
  });

  it("unversioned old services are incompatible, current-version 404s are service errors", async () => {
    const noHealth = await startStub({
      "/api/state": (_req, res) => {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
      },
    });
    try {
      const err = await catchError(() =>
        resolveSnapshot({
          client: createServiceClient({ port: noHealth.port, timeoutMs: 2000 }),
          dbPath: tmpDb("unused.db"),
          enabledProviders: ENABLED,
          now: FIXED_NOW,
        }),
      );
      expect(err).toBeInstanceOf(ClientError);
      expect(err.kind).toBe("incompatible-service");
      expect(err.message).toMatch(/unknown/);
    } finally {
      await noHealth.close();
    }
    const current = await startStub({
      "/api/state": (_req, res) => {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
      },
      "/health": (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, version: VERSION }));
      },
    });
    try {
      const err = await catchError(() =>
        resolveSnapshot({
          client: createServiceClient({ port: current.port, timeoutMs: 2000 }),
          dbPath: tmpDb("unused.db"),
          enabledProviders: ENABLED,
          now: FIXED_NOW,
        }),
      );
      expect(err).toBeInstanceOf(ClientError);
      expect(err.kind).toBe("service-error");
    } finally {
      await current.close();
    }
  });

  it("malformed 200 bodies are version-checked, not trusted", async () => {
    const stub = await startStub({
      "/api/state": (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ nope: true }));
      },
      "/health": (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, version: "0.0.1" }));
      },
    });
    try {
      const err = await catchError(() =>
        resolveSnapshot({
          client: createServiceClient({ port: stub.port, timeoutMs: 2000 }),
          dbPath: tmpDb("unused.db"),
          enabledProviders: ENABLED,
          now: FIXED_NOW,
        }),
      );
      expect(err).toBeInstanceOf(ClientError);
      expect(err.kind).toBe("incompatible-service");
    } finally {
      await stub.close();
    }
  });
});

describe("client error taxonomy", () => {
  it("maps transport failures to service-unavailable and HTTP failures to service-error", () => {
    const down = toClientError(new ServiceUnavailable("service unavailable at x: down"), "ingest");
    expect(down).toBeInstanceOf(ClientError);
    expect(down.kind).toBe("service-unavailable");
    expect(down.message).toMatch(/^service-unavailable: /);
    const bad = toClientError(new ServiceError(400, "bad ingest"), "ingest");
    expect(bad.kind).toBe("service-error");
    expect(bad.message).toMatch(/^service-error: /);
    expect(bad.message).toMatch(/400/);
    expect(bad.message).toMatch(/bad ingest/);
  });

  it("rethrows non-service errors unwrapped", () => {
    const bug = new Error("bug");
    expect(() => toClientError(bug, "ingest")).toThrow(bug);
  });

  it("emptySnapshot projects the no-data contract", () => {
    const snapshot = emptySnapshot(FIXED_NOW);
    expect(snapshot.runtime.available).toBe(false);
    expect(snapshot.runtime.version).toBe(VERSION);
    expect(projectQuotasResponse(snapshot)).toEqual([]);
    const rec = projectRecommendationResponse(snapshot);
    expect(rec.use).toBe("none");
    expect(rec.reason).toBe("no quotas yet");
  });
});
