// npm run dev — local iteration loop in one command: the backend daemon with
// auto-restart on src changes, plus the Vite HMR server proxied at the daemon
// API. One Ctrl-C stops both. Open http://localhost:5173, not :8787.
//
// The daemon binds the real API port, so the login service must be stopped
// first; this refuses to start otherwise instead of failing deep inside a
// bind. Daemon SIGHUPs are tsx restarts, not crashes.
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";

const API_PORT = 8787;
const WEB_PORT = 5173;

export function isPortInUse(port, host = "127.0.0.1", timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (inUse) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

function localBin(name) {
  return fileURLToPath(new URL(`../node_modules/.bin/${name}`, import.meta.url));
}

// Opt-in browser open (`npm run dev -- --open`). QUOTACAP_NO_OPEN=1 vetoes,
// matching the CLI's own hierarchy in src/cli/runtime.ts.
export function shouldAutoOpen(argv = process.argv.slice(2), env = process.env) {
  return argv.includes("--open") && env.QUOTACAP_NO_OPEN !== "1";
}

async function waitForPort(port, timeoutMs = 30000) {
  const start = Date.now();
  for (;;) {
    if (await isPortInUse(port)) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

function openBrowser(url) {
  const target = process.platform === "darwin" ? "open" : process.platform === "win32" ? null : "xdg-open";
  if (!target) {
    console.log(`open ${url} in your browser`);
    return;
  }
  const child = spawn(target, [url], { detached: true, stdio: "ignore" });
  child.on("error", () => console.log(`could not open a browser — open ${url} manually`));
  child.unref();
}

function run(label, cmd, args, onExit) {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => process.stdout.write(`[${label}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${label}] ${d}`));
  child.on("error", (e) => {
    console.error(`[${label}] failed to start: ${e.message}`);
    onExit(1);
  });
  child.on("exit", (code, signal) => onExit(code ?? (signal ? 1 : 0)));
  return child;
}

export async function main() {
  if (await isPortInUse(API_PORT)) {
    console.error(
      `port ${API_PORT} is already in use — stop the login service first: quotacap service stop`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`daemon → http://127.0.0.1:${API_PORT} (API, auto-restarts on src changes)`);
  console.log(`web    → http://localhost:${WEB_PORT} (dashboard with hot reload — open this)`);
  let shuttingDown = false;
  const children = [];
  const shutdown = (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const c of children) c.kill();
    process.exitCode = code;
  };
  children.push(
    run("daemon", localBin("tsx"), ["--watch", "src/cli/index.ts", "daemon", "--foreground"], shutdown),
    run("web", localBin("vite"), ["--config", "web/vite.config.ts"], shutdown),
  );
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  if (process.argv.slice(2).includes("--open")) {
    void (async () => {
      if (!shouldAutoOpen()) {
        console.log("QUOTACAP_NO_OPEN=1 — not opening a browser");
        return;
      }
      const url = `http://localhost:${WEB_PORT}`;
      if (await waitForPort(WEB_PORT)) openBrowser(url);
      else console.log(`dev server did not come up — open ${url} manually if it starts late`);
    })();
  }
  await new Promise(() => {});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
