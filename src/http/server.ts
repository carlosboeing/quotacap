import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// per-app state registry for backward-compat helpers
const appStates = new WeakMap<FastifyInstance, { lastPollAt: string | null; lastRefreshAt: number; lastRefreshResult: any }>();
const allStates = new Set<{ lastPollAt: string | null; lastRefreshAt: number; lastRefreshResult: any }>();

export function buildApp(db: any): FastifyInstance {
  const state = { lastPollAt: null as string | null, lastRefreshAt: 0, lastRefreshResult: null as any };
  const app = Fastify({ logger: false });
  appStates.set(app, state);
  allStates.add(state);
  // expose for per-app helpers
  (app as any)._quotacapState = state;

  app.get("/health", async () => ({ ok: true, uptime: process.uptime(), lastPollAt: state.lastPollAt }));

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
      return recommend(quotas, task);
    } catch (e: any) {
      return { use: quotas[0]?.provider ?? "none", reason: `advisory error: ${e?.message ?? String(e)}`, alternatives: quotas };
    }
  });

  app.post("/api/refresh", async () => {
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
    return reply.type("text/html").send(`<!doctype html><title>QuotaCap</title><div id=app>loading…</div>`);
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
