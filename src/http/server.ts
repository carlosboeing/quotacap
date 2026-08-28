import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let lastPollAt: string | null = null;
let lastRefreshAt = 0;
let lastRefreshResult: any = null;

export function buildApp(db: any): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ ok: true, uptime: process.uptime(), lastPollAt }));

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
    if (now - lastRefreshAt < 60_000 && lastRefreshResult) {
      return lastRefreshResult;
    }
    try {
      const { pollOnce } = await import("../daemon.js");
      const { readConfig } = await import("../config.js");
      const cfg = await readConfig();
      const results: any[] = await pollOnce(db, cfg.enabledProviders);
      const fulfilled = results.filter((r: any) => r.status === "fulfilled").map((r: any) => r.value);
      const rejected = results.filter((r: any) => r.status === "rejected").map((r: any) => ({ provider: r.provider, reason: String(r.reason?.message ?? r.reason) }));
      lastPollAt = new Date().toISOString();
      lastRefreshAt = now;
      lastRefreshResult = { fulfilled, rejected, lastPollAt, results, degraded: rejected.length > 0 };
      return lastRefreshResult;
    } catch (e: any) {
      return { fulfilled: [], rejected: [{ provider: "all", reason: String(e?.message ?? e) }], lastPollAt, degraded: true, error: String(e?.message ?? e) };
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

export function getLastPollAt() { return lastPollAt; }
export function resetRefreshState() { lastPollAt = null; lastRefreshAt = 0; lastRefreshResult = null; }
