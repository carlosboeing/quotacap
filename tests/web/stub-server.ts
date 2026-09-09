import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Test-local HTTP stub. Serves Track A fixture JSON verbatim at the daemon's
 * API routes plus the real Vite build with an SPA fallback, so the dashboard
 * suite exercises production assets without touching server source.
 */

export interface StubRouteBehavior {
  status?: number;
  body?: unknown;
}

export interface StubOptions {
  /** Served verbatim at GET /api/state. */
  state: unknown;
  token?: string;
  refresh?: StubRouteBehavior & { nextState?: unknown };
  ingest?: StubRouteBehavior;
  /** Delay before GET /api/state answers (loading-skeleton capture). */
  stateDelayMs?: number;
  distDir?: string;
}

export interface StubRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

export interface StubHandle {
  url: string;
  stop: () => Promise<void>;
  requests: StubRequest[];
  setState: (state: unknown) => void;
  setRefresh: (behavior: StubOptions["refresh"]) => void;
  setIngest: (behavior: StubRouteBehavior) => void;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function defaultDistDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "web", "dist");
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
  });
}

export async function startStub(opts: StubOptions): Promise<StubHandle> {
  let state = opts.state;
  let refreshBehavior = opts.refresh;
  let ingestBehavior = opts.ingest;
  const token = opts.token ?? "test-token";
  const distDir = opts.distDir ?? defaultDistDir();
  const requests: StubRequest[] = [];

  const indexHtml = (): Buffer | null => {
    try {
      return fs.readFileSync(path.join(distDir, "index.html"));
    } catch {
      return null;
    }
  };

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;

    const sendJson = (status: number, body: unknown) => {
      const payload = typeof body === "string" ? body : JSON.stringify(body);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(payload);
    };

    if (method === "GET" && pathname === "/api/state") {
      if (opts.stateDelayMs) await new Promise((r) => setTimeout(r, opts.stateDelayMs));
      sendJson(200, state);
      return;
    }
    if (method === "GET" && pathname === "/api/token") {
      sendJson(200, { token });
      return;
    }
    if (method === "POST" && (pathname === "/api/refresh" || pathname === "/api/ingest")) {
      const body = await readBody(req);
      requests.push({ method, url: pathname, headers: req.headers, body });
      if (req.headers["x-quotacap-token"] !== token) {
        sendJson(401, { error: "unauthorized: missing or invalid X-QuotaCap-Token header" });
        return;
      }
      if (pathname === "/api/refresh") {
        if (refreshBehavior?.nextState !== undefined) state = refreshBehavior.nextState;
        sendJson(refreshBehavior?.status ?? 200, refreshBehavior?.body ?? { ok: true });
        return;
      }
      sendJson(ingestBehavior?.status ?? 200, ingestBehavior?.body ?? { ok: true });
      return;
    }
    if (pathname.startsWith("/api/")) {
      sendJson(404, { error: "not found" });
      return;
    }

    // Static production assets with an SPA fallback for /setup.
    const rel = pathname === "/" || pathname === "/setup" ? "index.html" : pathname.slice(1);
    const candidate = path.resolve(distDir, rel);
    if (candidate === distDir || candidate.startsWith(distDir + path.sep)) {
      try {
        const data = fs.readFileSync(candidate);
        const type = CONTENT_TYPES[path.extname(candidate)] ?? "application/octet-stream";
        res.writeHead(200, { "Content-Type": type });
        res.end(data);
        return;
      } catch {
        // Fall through to the SPA fallback below.
      }
    }
    const fallback = indexHtml();
    if (fallback) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fallback);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("no build: run vite build first");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
    requests,
    setState: (s: unknown) => {
      state = s;
    },
    setRefresh: (b) => {
      refreshBehavior = b;
    },
    setIngest: (b) => {
      ingestBehavior = b;
    },
  };
}
