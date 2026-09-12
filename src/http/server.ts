import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { webHtml } from "../webHtml.js";
import { webAssets } from "../webAssets.js";
import {
  buildSnapshot,
  projectQuotasResponse,
  projectRecommendationResponse,
} from "../advisory/snapshot.js";
import type { StateSnapshot } from "../advisory/types.js";
import { validateTask } from "../advisory/validate.js";
import { readUpdateCache } from "../runtime/updates.js";
import { compareVersions } from "../runtime/versions.js";
import { parseManualUsage } from "../adapters/manual.js";
import { upsertQuota } from "../store/quotas.js";
import {
  createCoordinator,
  ServiceClosing,
  type Coordinator,
  type RejectedAttempt,
} from "../runtime/poll.js";
import { classifyFailure } from "../diagnostics/failure.js";
import { validateDisplayName } from "../advisory/validation.js";
import { providerIdentity } from "../advisory/provider-names.js";
import { readConfig, writeConfig } from "../config.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function hostnameFromHostHeader(hostHeader: unknown): string | null {
  if (typeof hostHeader !== "string" || !hostHeader.trim()) return null;
  const trimmed = hostHeader.trim();
  if (trimmed.startsWith("[")) {
    const closing = trimmed.indexOf("]");
    if (closing === -1) return null;
    const bracketed = trimmed.slice(0, closing + 1);
    const rest = trimmed.slice(closing + 1);
    if (rest.length > 0) {
      if (!rest.startsWith(":")) return null;
      const portStr = rest.slice(1);
      if (!/^\d+$/.test(portStr)) return null;
    }
    return bracketed.toLowerCase();
  }
  const parts = trimmed.split(":");
  if (parts.length === 1) {
    return parts[0].toLowerCase();
  }
  if (parts.length === 2) {
    const portStr = parts[1];
    if (!/^\d+$/.test(portStr)) return null;
    return parts[0].toLowerCase();
  }
  return null;
}

export function isLoopbackHostname(hostname: string | null): boolean {
  return hostname !== null && LOOPBACK_HOSTS.has(hostname);
}

export function isAllowedOrigin(origin: unknown): boolean {
  if (origin === undefined) return true;
  if (typeof origin !== "string" || !origin.trim()) return false;
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return isLoopbackHostname(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isValidToken(received: unknown, expected: string): boolean {
  if (typeof received !== "string" || !received.trim() || !expected) return false;
  const recBuf = Buffer.from(received.trim());
  const expBuf = Buffer.from(expected.trim());
  if (recBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(recBuf, expBuf);
}

export interface RuntimeContext {
  db: any;
  token: string;
  coordinator: Coordinator;
  enabledProviders: string[];
  providerNames?: Record<string, string>;
  version: string;
  exec: string;
  now?: () => Date;
  /**
   * True while this process may still write to the database. The service
   * supplies closing state plus claim ownership; a process that lost its
   * claim must stop writing at once, not at its next scheduled poll.
   */
  canWrite?: () => boolean;
  /** Off unless experimental ingest is enabled. Unset means off. */
  ingestEnabled?: boolean;
  /**
   * Graceful-stop hook for POST /api/restart. The service wires this to its
   * normal SIGTERM path; unset in tests that only assert the response.
   */
  onRestart?: (info: { version?: string; exec?: string }) => void;
  configPath?: string;
}

// Ingest writes outside the poll path, so it needs the same fence the
// coordinator applies before a poll write.
function writable(ctx: RuntimeContext): boolean {
  if (ctx.coordinator.isClosing()) return false;
  return ctx.canWrite ? ctx.canWrite() : true;
}

export function testCtx(db: any, overrides?: Partial<RuntimeContext>): RuntimeContext {
  return {
    db,
    token: "test-token",
    coordinator: createCoordinator({ db, enabledProviders: [] }),
    enabledProviders: [],
    providerNames: {},
    version: "test",
    exec: "test",
    ingestEnabled: false,
    ...overrides,
  };
}

function snapshotOf(ctx: RuntimeContext): StateSnapshot {
  const st = ctx.coordinator.getState();
  // Additive passive update signal: the shared daily cache (written by the
  // daemon schedule and the CLI) surfaces here for the dashboard badge.
  // upToDate is true when versions match or the check never succeeded.
  const cache = readUpdateCache();
  return buildSnapshot(ctx.db, {
    enabledProviders: ctx.enabledProviders,
    providerNames: ctx.providerNames,
    now: ctx.now?.() ?? new Date(),
    runtime: {
      available: true,
      ready: true,
      polling: st.polling,
      lastCompletedPollAt: st.lastCompletedPollAt,
      version: ctx.version,
      update: {
        current: ctx.version,
        latest: cache?.latest ?? null,
        upToDate: !cache || compareVersions(cache.latest, ctx.version) <= 0,
        checkedAt: cache?.checkedAt ?? null,
      },
    },
  });
}

function readIndexHtml(): string {
  const candidates = [
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist/index.html"),
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../web/index.html"),
    path.join(process.cwd(), "web/dist/index.html"),
    path.join(process.cwd(), "web/index.html"),
  ];
  for (const p of candidates) {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {}
  }
  return webHtml ?? `<!doctype html><title>QuotaCap</title><div id=app>loading…</div>`;
}

export function buildApp(ctx: RuntimeContext): FastifyInstance {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (req, reply) => {
    const host = hostnameFromHostHeader(req.headers.host);
    if (!isLoopbackHostname(host)) {
      return reply.status(403).send({ error: "forbidden host" });
    }
    if (!isAllowedOrigin(req.headers.origin)) {
      return reply.status(403).send({ error: "forbidden origin" });
    }
  });

  app.get("/health", async () => {
    const st = ctx.coordinator.getState();
    return {
      ok: true,
      uptime: process.uptime(),
      lastPollAt: st.lastCompletedPollAt,
      version: ctx.version,
      exec: ctx.exec,
      ready: true,
      polling: st.polling,
      lastCompletedPollAt: st.lastCompletedPollAt,
    };
  });

  app.get("/api/token", async () => ({ token: ctx.token }));

  app.get("/api/state", async () => snapshotOf(ctx));

  app.get("/api/quotas", async () => projectQuotasResponse(snapshotOf(ctx)));

  app.get("/api/recommendation", async (req: any, reply) => {
    const task = req.query?.task ?? "any";
    try {
      validateTask(task);
    } catch (e: any) {
      return reply.status(400).send({ error: String(e?.message ?? e) });
    }
    return projectRecommendationResponse(snapshotOf(ctx), task);
  });

  app.post("/api/refresh", async (req: any, reply) => {
    const headerToken = req.headers["x-quotacap-token"];
    if (!isValidToken(headerToken, ctx.token)) {
      return reply.status(401).send({ error: "unauthorized: missing or invalid X-QuotaCap-Token header" });
    }
    try {
      return await ctx.coordinator.refresh();
    } catch (e: any) {
      if (e instanceof ServiceClosing) {
        return reply.status(503).send({ error: "service unavailable: closing" });
      }
      const st = ctx.coordinator.getState();
      const diagnosis = classifyFailure("all", e);
      const rejection: RejectedAttempt = {
        provider: "all",
        reason: diagnosis.errorDetail,
        category: diagnosis.category,
        diagnosticCode: diagnosis.diagnosticCode,
        summary: diagnosis.summary,
        action: diagnosis.action,
        errorDetail: diagnosis.errorDetail,
        error: diagnosis.errorDetail,
      };
      return {
        fulfilled: [],
        rejected: [rejection],
        lastPollAt: st.lastCompletedPollAt,
        results: [{ provider: "all", status: "rejected", reason: diagnosis.errorDetail }],
        degraded: true,
        shared: false,
        cooldown: false,
        error: diagnosis.errorDetail,
      };
    }
  });

  app.patch("/api/providers/:id", async (req: any, reply) => {
    const headerToken = req.headers["x-quotacap-token"];
    if (!isValidToken(headerToken, ctx.token)) {
      return reply.status(401).send({ error: "unauthorized: missing or invalid X-QuotaCap-Token header" });
    }

    const { id } = req.params;
    if (!id || typeof id !== "string") {
      return reply.status(400).send({ error: "invalid-argument: provider id is required" });
    }

    const body = (req.body ?? {}) as any;
    if (typeof body !== "object" || body === null || !("displayName" in body)) {
      return reply.status(400).send({ error: "invalid-argument: body must contain displayName" });
    }

    const { displayName } = body;
    if (displayName !== null && typeof displayName !== "string") {
      return reply.status(400).send({ error: "invalid-argument: displayName must be a string or null" });
    }

    let validatedName: string | null = null;
    if (typeof displayName === "string") {
      try {
        validatedName = validateDisplayName(displayName);
      } catch (e: any) {
        return reply.status(400).send({ error: e?.message ?? String(e) });
      }
    }

    // Update in-memory ctx
    ctx.providerNames = { ...(ctx.providerNames ?? {}) };
    if (validatedName === null) {
      delete ctx.providerNames[id];
    } else {
      ctx.providerNames[id] = validatedName;
    }

    // Persist to config.json
    try {
      const cfg = await readConfig(ctx.configPath);
      cfg.providerNames = { ...(cfg.providerNames ?? {}) };
      if (validatedName === null) {
        delete cfg.providerNames[id];
      } else {
        cfg.providerNames[id] = validatedName;
      }
      await writeConfig(cfg, ctx.configPath);
    } catch (err) {
      console.warn(`[quotacap] failed to persist providerNames to config: ${String(err)}`);
    }

    const identity = providerIdentity(id, ctx.providerNames);
    return {
      ok: true,
      id,
      displayName: identity.displayName,
      builtinName: identity.builtinName,
      override: validatedName,
    };
  });


  // Graceful-stop request for CLI-driven takeovers. The endpoint restarts
  // nothing by itself: it responds 202, then the service follows its normal
  // SIGTERM path while the CLI spawns the successor after the port releases.
  app.post("/api/restart", async (req: any, reply) => {
    const headerToken = req.headers["x-quotacap-token"];
    if (!isValidToken(headerToken, ctx.token)) {
      return reply.status(401).send({ error: "unauthorized: missing or invalid X-QuotaCap-Token header" });
    }
    const body = (req.body ?? {}) as any;
    const info = {
      version: typeof body?.version === "string" ? body.version : undefined,
      exec: typeof body?.exec === "string" ? body.exec : undefined,
    };
    if (info.version || info.exec) {
      console.log(`[quotacap] restart requested by CLI version ${info.version ?? "?"} exec ${info.exec ?? "?"}`);
    } else {
      console.log("[quotacap] restart requested");
    }
    // The 202 must flush before shutdown begins; the CLI keys its successor
    // off this response, and a reset connection would read as failure.
    reply.raw.once("finish", () => {
      setImmediate(() => ctx.onRestart?.(info));
    });
    return reply
      .status(202)
      .send({ ok: true, restarting: true, version: ctx.version, pid: process.pid });
  });

  if (ctx.ingestEnabled) {
    app.post("/api/ingest", async (req: any, reply) => {
    const headerToken = req.headers["x-quotacap-token"];
    if (!isValidToken(headerToken, ctx.token)) {
      return reply.status(401).send({ error: "unauthorized: missing or invalid X-QuotaCap-Token header" });
    }
    const body = req.body as any;
    const provider = body?.provider;
    const text = body?.text;
    if (
      typeof provider !== "string" ||
      !provider.trim() ||
      typeof text !== "string" ||
      !text
    ) {
      return reply.status(400).send({ error: "invalid-argument: provider and text are required" });
    }
    if (!writable(ctx)) {
      return reply
        .status(503)
        .send({ error: "service unavailable: not the current owner or closing" });
    }
    const parsed = parseManualUsage(provider, text);
    // Validated quota fields only: no raw text stored, no attempt row (D4).
    upsertQuota(ctx.db, {
      provider: parsed.provider,
      plan: parsed.plan,
      usedPct: parsed.usedPct,
      sessionPct: parsed.sessionPct,
      resetsAt: parsed.resetsAt,
      periodStart: parsed.periodStart,
      source: "manual",
      fetchedAt: parsed.fetchedAt,
      creditsUsd: parsed.creditsUsd,
      resetsAtEstimated: parsed.resetsAtEstimated,
    });
    return { ok: true, provider };
    });
  }

  // serve built vite assets at /assets/* (web/dist/assets/*)
  app.get("/assets/*", async (req: any, reply) => {
    const raw = String(req.params["*"] ?? "");
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return reply.status(400).send("bad path");
    }
    if (!decoded || decoded.includes("..") || path.isAbsolute(decoded)) {
      return reply.status(400).send("bad path");
    }
    const roots = [
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist/assets"),
      path.resolve(process.cwd(), "web/dist/assets"),
    ];
    for (const root of roots) {
      const candidate = path.resolve(root, decoded);
      if (candidate === root || candidate.startsWith(root + path.sep)) {
        try {
          const data = fs.readFileSync(candidate);
          const ext = path.extname(candidate);
          const type = ext === ".js" ? "application/javascript" : ext === ".css" ? "text/css" : ext === ".map" ? "application/json" : "application/octet-stream";
          return reply.type(type).send(data);
        } catch {}
      }
    }
    const embedded = webAssets[decoded];
    if (embedded !== undefined) {
      const ext = path.extname(decoded);
      const type = ext === ".js" ? "application/javascript" : ext === ".css" ? "text/css" : ext === ".map" ? "application/json" : "application/octet-stream";
      return reply.type(type).send(embedded);
    }
    return reply.status(404).send("not found");
  });

  app.get("/", async (_req, reply) => {
    return reply.type("text/html").send(readIndexHtml());
  });

  // SPA fallback for Track C history routing (/setup): non-API/non-asset
  // GETs that accept HTML get the app shell; explicit non-HTML accepts 404.
  app.get("/*", async (req: any, reply) => {
    const url = String(req.url ?? "").split("?")[0];
    if (url.startsWith("/api/") || url.startsWith("/assets/")) {
      return reply.status(404).send({ error: "not found" });
    }
    const accept = req.headers.accept;
    if (
      typeof accept === "string" &&
      !accept.includes("text/html") &&
      !accept.includes("*/*")
    ) {
      return reply.status(404).send("not found");
    }
    return reply.type("text/html").send(readIndexHtml());
  });

  return app;
}
