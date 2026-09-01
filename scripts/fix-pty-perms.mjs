#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prebuilds = path.join(__dirname, "..", "node_modules", "node-pty", "prebuilds");

if (process.platform === "win32") process.exit(0);

try {
  if (!fs.existsSync(prebuilds)) process.exit(0);
  for (const entry of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, entry, "spawn-helper");
    if (fs.existsSync(helper)) {
      try {
        fs.chmodSync(helper, 0o755);
      } catch {}
    }
  }
} catch {}
