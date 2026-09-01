import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { webHtml } from "../webHtml.js";
import { webAssets } from "../webAssets.js";

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

export function getTokenPath(): string {
  return path.join(process.env.QUOTACAP_HOME ?? os.homedir(), ".quotacap", "token");
}

export function readToken(tokenPath = getTokenPath()): string | undefined {
  try {
    if (fs.existsSync(tokenPath)) {
      const existing = fs.readFileSync(tokenPath, "utf8").trim();
      if (existing.length > 0) return existing;
    }
  } catch {}
  return undefined;
}

export function ensureToken(tokenPath = getTokenPath()): string {
  const existing = readToken(tokenPath);
  if (existing) return existing;
  const token = crypto.randomBytes(32).toString("hex");
  try {
    const dir = path.dirname(tokenPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch {}
    fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600, encoding: "utf8" });
    try { fs.chmodSync(tokenPath, 0o600); } catch {}
  } catch {}
  return token;
}

export function isValidToken(received: unknown, expected: string): boolean {
  if (typeof received !== "string" || !received.trim() || !expected) return false;
  const recBuf = Buffer.from(received.trim());
  const expBuf = Buffer.from(expected.trim());
  if (recBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(recBuf, expBuf);
}

// per-app state registry for backward-compat helpers
const appStates = new WeakMap<FastifyInstance, { lastPollAt: string | null; lastRefreshAt: number; lastRefreshResult: any; token: string }>();
const allStates = new Set<{ lastPollAt: string | null; lastRefreshAt: number; lastRefreshResult: any; token: string }>();

export interface BuildAppOptions {
  token?: string;
}

export function buildApp(db: any, opts?: BuildAppOptions): FastifyInstance {
  const token = opts?.token ?? ensureToken();
  const state = { lastPollAt: null as string | null, lastRefreshAt: 0, lastRefreshResult: null as any, token };
  const app = Fastify({ logger: false });
  appStates.set(app, state);
  allStates.add(state);
  app.addHook("onClose", async () => {
    appStates.delete(app);
    allStates.delete(state);
  });
  app.addHook("onRequest", async (req, reply) => {
    const host = hostnameFromHostHeader(req.headers.host);
    if (!isLoopbackHostname(host)) {
      return reply.status(403).send({ error: "forbidden host" });
    }
    if (!isAllowedOrigin(req.headers.origin)) {
      return reply.status(403).send({ error: "forbidden origin" });
    }
  });

  // expose for per-app helpers
  (app as any)._quotacapState = state;

  app.get("/health", async () => ({ ok: true, uptime: process.uptime(), lastPollAt: state.lastPollAt }));

  app.get("/api/token", async () => ({ token: state.token }));

  app.get("/api/quotas", async () => {
    const { getAllLatest } = await import("../store/quotas.js");
    const quotas = getAllLatest(db);
    const now = Date.now();
    return quotas.map((q: any) => {
      const fetched = q.fetchedAt ? new Date(q.fetchedAt).getTime() : 0;
      const ageMs = fetched ? now - fetched : Infinity;
      const stale = ageMs > 60 * 60 * 1000;
      return { ...q, stale, ageMs };
    });
  });

  app.get("/api/recommendation", async (req: any) => {
    const { getAllLatest } = await import("../store/quotas.js");
    const quotas = getAllLatest(db);
    if (!quotas.length) {
      return { use: "none", reason: "no quotas yet", alternatives: [], advisories: [] };
    }
    let recommend: any;
    try {
      recommend = (await import("../advisory/engine.js")).recommend;
    } catch {
      return { use: quotas[0]?.provider ?? "none", reason: "advisory not yet implemented", alternatives: quotas };
    }
    try {
      const task = (req.query?.task as string) ?? "any";
      const { getBurnRates } = await import("../store/quotas.js");
      const burnByProvider = getBurnRates(db);
      return recommend(quotas, task, burnByProvider);
    } catch (e: any) {
      return { use: quotas[0]?.provider ?? "none", reason: `advisory error: ${e?.message ?? String(e)}`, alternatives: quotas };
    }
  });

  app.post("/api/refresh", async (req: any, reply) => {
    const headerToken = req.headers["x-quotacap-token"];
    if (!isValidToken(headerToken, state.token)) {
      return reply.status(401).send({ error: "unauthorized: missing or invalid X-QuotaCap-Token header" });
    }
    const now = Date.now();
    if (now - state.lastRefreshAt < 60_000 && state.lastRefreshResult) {
      return state.lastRefreshResult;
    }
    try {
      const { pollOnce } = await import("../daemon.js");
      const { readConfig } = await import("../config.js");
      const cfg = await readConfig();
      const results: any[] = await pollOnce(db, cfg.enabledProviders);
      const fulfilled = results.filter((r: any) => r.status === "fulfilled").map((r: any) => r.value);
      const rejected = results.filter((r: any) => r.status === "rejected").map((r: any) => ({ provider: r.provider, reason: String(r.reason?.message ?? r.reason) }));
      state.lastPollAt = new Date().toISOString();
      state.lastRefreshAt = now;
      state.lastRefreshResult = { fulfilled, rejected, lastPollAt: state.lastPollAt, results, degraded: rejected.length > 0 };
      return state.lastRefreshResult;
    } catch (e: any) {
      return { fulfilled: [], rejected: [{ provider: "all", reason: String(e?.message ?? e) }], lastPollAt: state.lastPollAt, degraded: true, error: String(e?.message ?? e) };
    }
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
    const candidates = [
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist/index.html"),
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../../web/index.html"),
      path.join(process.cwd(), "web/dist/index.html"),
      path.join(process.cwd(), "web/index.html"),
    ];
    for (const p of candidates) {
      try {
        const html = fs.readFileSync(p, "utf8");
        return reply.type("text/html").send(html);
      } catch {}
    }
    return reply.type("text/html").send(webHtml ?? `<!doctype html><title>QuotaCap</title><div id=app>loading…</div>`);
  });

  return app;
}

export function getLastPollAt(app?: FastifyInstance) {
  if (app && appStates.has(app)) return appStates.get(app)!.lastPollAt;
  // fallback: most recent state (for tests without app arg)
  let last: string | null = null;
  for (const s of allStates) last = s.lastPollAt;
  return last;
}
export function resetRefreshState(app?: FastifyInstance) {
  if (app && appStates.has(app)) {
    const s = appStates.get(app)!;
    s.lastPollAt = null; s.lastRefreshAt = 0; s.lastRefreshResult = null;
    return;
  }
  for (const s of allStates) { s.lastPollAt = null; s.lastRefreshAt = 0; s.lastRefreshResult = null; }
}
