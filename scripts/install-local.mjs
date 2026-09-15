// scripts/install-local.mjs — compile and install unreleased local builds into
// the user's bin directory (~/.local/bin) and restart the background daemon if running.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function getTargetName(platform = process.platform, arch = process.arch) {
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(`Unsupported platform: ${platform}. Only macOS (darwin) and Linux are supported.`);
  }
  if (arch === "arm64" || arch === "aarch64") {
    return `${platform}-arm64`;
  }
  if (arch === "x64" || arch === "x86_64" || arch === "amd64") {
    return `${platform}-x64`;
  }
  throw new Error(`Unsupported architecture: ${arch}`);
}

export function getBinDir(env = process.env) {
  return env.QUOTACAP_BIN_DIR || path.join(os.homedir(), ".local", "bin");
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(s, d);
    } else if (entry.isSymbolicLink()) {
      const link = fs.readlinkSync(s);
      fs.symlinkSync(link, d);
    } else {
      fs.copyFileSync(s, d);
      try {
        const stat = fs.statSync(s);
        fs.chmodSync(d, stat.mode);
      } catch {}
    }
  }
}

export function installBinary({ binDir, sourceBin, sourcePty }) {
  if (!fs.existsSync(sourceBin)) {
    throw new Error(`Source binary not found: ${sourceBin}`);
  }

  fs.mkdirSync(binDir, { recursive: true });

  const targetBin = path.join(binDir, "quotacap");
  const tmpBin = path.join(binDir, `quotacap.tmp.${Date.now()}.${process.pid}`);

  fs.copyFileSync(sourceBin, tmpBin);
  try {
    fs.chmodSync(tmpBin, 0o755);
  } catch {}
  fs.renameSync(tmpBin, targetBin);

  let installedPty;
  if (sourcePty && fs.existsSync(sourcePty)) {
    const targetPty = path.join(binDir, "pty");
    fs.rmSync(targetPty, { recursive: true, force: true });
    copyDirSync(sourcePty, targetPty);
    installedPty = targetPty;
  }

  return { installedBin: targetBin, installedPty };
}

export function reloadServiceIfRunning(binPath = "quotacap", execFn = execFileSync) {
  try {
    const statusOut = execFn(binPath, ["service", "status"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const statusText = typeof statusOut === "string" ? statusOut : statusOut.toString("utf-8");
    if (/installed and loaded/i.test(statusText) || /is loaded/i.test(statusText)) {
      execFn(binPath, ["service", "restart"], { stdio: "inherit" });
      return true;
    }
  } catch {}
  return false;
}

export async function main() {
  const target = getTargetName();
  const binDir = getBinDir();

  console.log("\x1b[1mquotacap install:local\x1b[0m");
  console.log(`Target:  ${target}`);
  console.log(`Bin dir: ${binDir}\n`);

  console.log("1. Building dashboard and embedding assets (`npm run build`)...");
  execFileSync("npm", ["run", "build"], { stdio: "inherit" });

  console.log(`\n2. Compiling standalone binary with Bun (\`bun-${target}\`)...`);
  execFileSync("node", ["scripts/build-binary.mjs", `bun-${target}`], { stdio: "inherit" });

  console.log("\n3. Installing binary and sidecar...");
  const sourceBin = path.join("dist-bin", `quotacap-${target}`);
  const sourcePty = path.join("dist-bin", "pty");
  const { installedBin } = installBinary({ binDir, sourceBin, sourcePty });
  console.log(`✓ Installed binary to ${installedBin}`);

  console.log("\n4. Checking background service...");
  const reloaded = reloadServiceIfRunning(installedBin);
  if (reloaded) {
    console.log("✓ Background service restarted on new binary.");
  } else {
    console.log("• Background service is not loaded (run 'quotacap service start' to start it).");
  }

  console.log(`\n\x1b[32m✔ Successfully installed local quotacap build to ${binDir}.\x1b[0m`);
}

// Execute CLI runner when called directly
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\x1b[31merror:\x1b[0m ${err.message}`);
    process.exit(1);
  });
}
