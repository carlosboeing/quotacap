import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { buildFixtureDb } from "../fixtures/stable-state.js";
import { VERSION } from "../../src/version.js";

/**
 * Live smoke suite. Spawns the real daemon (`node dist/cli/index.js daemon`)
 * on an isolated QUOTACAP_HOME seeded with Track A fixture rows, loads the
 * real dashboard in Chromium, and asserts provider cards render from live
 * daemon state with zero browser console errors. Requires `npm run build`
 * first; independent of the stub-server tests/web/dashboard.e2e.ts suite.
 */

const specDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(specDir, "../..");

const PROVIDERS = ["kimi", "claude", "grok", "codex", "agy"];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function seedDb(home: string): void {
  const dir = path.join(home, ".quotacap");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "quotacap.db");
  try {
    fs.rmSync(filePath);
  } catch {
    /* VACUUM INTO refuses an existing target */
  }
  const db = buildFixtureDb();
  try {
    db.exec(`VACUUM INTO '${filePath.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

async function waitForHealth(port: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const body = (await res.json()) as { ok?: unknown; ready?: unknown };
      if (res.ok && body.ok === true && body.ready === true) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() >= deadline) {
      throw new Error(`daemon on port ${port} never became ready`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function stopDaemon(child: ChildProcess, timeoutMs = 15000): Promise<number | null> {
  const exited = new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  child.kill("SIGTERM");
  return exited;
}

test("live dashboard renders provider cards with zero console errors", async ({ page }) => {
  const port = await freePort();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "qc-smoke-"));
  const dir = path.join(home, ".quotacap");
  fs.mkdirSync(dir, { recursive: true });
  // All five fixture providers enabled so their stored rows render as
  // cards. The async initial poll may spawn real provider CLIs in the
  // background; it never blocks readiness and shutdown kills survivors.
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({
      port,
      pollMinutes: 60,
      enabledProviders: ["claude", "codex", "kimi", "grok", "agy"],
    }),
  );
  seedDb(home);

  const child = spawn("node", ["dist/cli/index.js", "daemon"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --no-warnings`.trim(),
      QUOTACAP_HOME: home,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let daemonOutput = "";
  child.stdout?.on("data", (d) => {
    daemonOutput += String(d);
  });
  child.stderr?.on("data", (d) => {
    daemonOutput += String(d);
  });
  try {
    await waitForHealth(port);

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => {
      pageErrors.push(String(err?.message ?? err));
    });

    const stateResponse = page.waitForResponse(
      (r) => r.url().includes("/api/state") && r.request().method() === "GET",
    );
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
    const state = await stateResponse;
    expect(state.status()).toBe(200);

    await expect(page.getByTestId("dashboard-root")).toBeVisible();
    await expect(page.getByTestId("state-unavailable")).toHaveCount(0);
    for (const id of PROVIDERS) {
      await expect(page.getByTestId(`provider-card-${id}`)).toBeVisible();
    }
    await expect(page.locator("footer.sitefoot")).toContainText(`QuotaCap v${VERSION}`);
    expect(consoleErrors, `browser console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
    expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
  } finally {
    const code = await stopDaemon(child);
    expect(code, `daemon did not shut down gracefully; output:\n${daemonOutput}`).toBe(0);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
