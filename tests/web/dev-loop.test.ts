import { describe, it, expect, vi, afterEach } from "vitest";
import net from "node:net";
import { isPortInUse, shouldAutoOpen } from "../../scripts/dev.mjs";

afterEach(() => {
  vi.unstubAllEnvs();
});

function loopbackTarget(t: unknown): URL {
  expect(typeof t).toBe("string");
  const u = new URL(t as string);
  expect(u.protocol === "http:" || u.protocol === "https:").toBe(true);
  expect(["127.0.0.1", "localhost", "::1"]).toContain(u.hostname);
  return u;
}

function proxyTable(config: { server?: { proxy?: unknown } }): Record<string, unknown> {
  expect(config.server?.proxy).toBeDefined();
  return config.server?.proxy as Record<string, unknown>;
}

describe("dev loop", () => {
  it("proxies API traffic to the loopback daemon by default", async () => {
    vi.resetModules();
    vi.stubEnv("QUOTACAP_DEV_API", "");
    const { default: config } = await import("../../web/vite.config.js");
    expect(config.server?.port).toBe(5173);
    const proxy = proxyTable(config);
    expect(loopbackTarget(proxy["/api"]).href).toBe("http://127.0.0.1:8787/");
    expect(loopbackTarget(proxy["/health"]).href).toBe("http://127.0.0.1:8787/");
  });

  it("honors QUOTACAP_DEV_API for non-default daemon ports", async () => {
    vi.resetModules();
    vi.stubEnv("QUOTACAP_DEV_API", "http://127.0.0.1:8788");
    const { default: config } = await import("../../web/vite.config.js");
    expect(loopbackTarget(proxyTable(config)["/api"]).href).toBe("http://127.0.0.1:8788/");
  });

  it("detects a bound port and a free one", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      expect(await isPortInUse(port)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // A freed ephemeral port can be re-grabbed instantly by a parallel
    // worker's server, so poll until it reads free instead of asserting once.
    const start = Date.now();
    let free = false;
    while (!free && Date.now() - start < 5000) {
      free = !(await isPortInUse(port));
      if (!free) await new Promise((r) => setTimeout(r, 50));
    }
    expect(free).toBe(true);
  });

  it("opens a browser only with --open and no QUOTACAP_NO_OPEN veto", () => {
    expect(shouldAutoOpen([], {})).toBe(false);
    expect(shouldAutoOpen(["--open"], {})).toBe(true);
    expect(shouldAutoOpen(["--open"], { QUOTACAP_NO_OPEN: "1" })).toBe(false);
    expect(shouldAutoOpen(["--open"], { QUOTACAP_NO_OPEN: "0" })).toBe(true);
  });
});
