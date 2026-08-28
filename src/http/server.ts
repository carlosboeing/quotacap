import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function buildApp(db: any): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ ok: true, uptime: process.uptime() }));

  app.get("/api/quotas", async () => {
    const { getAllLatest } = await import("../store/quotas.js");
    return getAllLatest(db);
  });

  app.get("/api/recommendation", async (req: any) => {
    const { getAllLatest } = await import("../store/quotas.js");
    const quotas = getAllLatest(db);
    try {
      // @ts-ignore — advisory engine not yet implemented (Task 6); fallback keeps Task 5 green and tsc clean
      const { recommend } = await import("../advisory/engine.js");
      const task = (req.query?.task as string) ?? "any";
      return recommend(quotas, task);
    } catch {
      return { use: quotas[0]?.provider ?? "none", reason: "advisory not yet implemented", alternatives: quotas };
    }
  });

  app.post("/api/refresh", async () => {
    const { pollOnce } = await import("../daemon.js");
    const { readConfig } = await import("../config.js");
    const cfg = await readConfig();
    return pollOnce(db, cfg.enabledProviders);
  });

  app.get("/", async (_req, reply) => {
    const candidates = [
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../../web/index.html"),
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
