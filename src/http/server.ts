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
import { parseManualUsage } from "../adapters/manual.js";
import { upsertQuota } from "../store/quotas.js";
import {
  createCoordinator,
  ServiceClosing,
  type Coordinator,
} from "../runtime/poll.js";

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
  version: string;
  exec: string;
  now?: () => Date;
}

export function testCtx(db: any, overrides?: Partial<RuntimeContext>): RuntimeContext {
  return {
    db,
    token: "test-token",
    coordinator: createCoordinator({ db, enabledProviders: [] }),
    enabledProviders: [],
    version: "test",
    exec: "test",
    ...overrides,
  };
}

function snapshotOf(ctx: RuntimeContext): StateSnapshot {
  const st = ctx.coordinator.getState();
  return buildSnapshot(ctx.db, {
    enabledProviders: ctx.enabledProviders,
    now: ctx.now?.() ?? new Date(),
    runtime: {
      available: true,
      ready: true,
      polling: st.polling,
      lastCompletedPollAt: st.lastCompletedPollAt,
      version: ctx.version,
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
      return {
        fulfilled: [],
        rejected: [{ provider: "all", reason: String(e?.message ?? e) }],
        lastPollAt: st.lastCompletedPollAt,
        degraded: true,
        shared: false,
        cooldown: false,
        error: String(e?.message ?? e),
      };
    }
  });

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
