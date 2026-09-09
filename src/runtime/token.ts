// Single token implementation for the service and HTTP (unifies the
// daemon.ts and server.ts copies).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDbPath } from "../config.js";

export function tokenFile(dataDir = path.dirname(getDbPath())): string {
  return path.join(dataDir, "token");
}

export function ensureToken(file = tokenFile()): string {
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {}
  } catch {}
  try {
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, "utf8").trim();
      if (existing.length > 0) return existing;
    }
  } catch {}
  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600, encoding: "utf8" });
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
  return token;
}

export function readToken(file = tokenFile()): string | undefined {
  try {
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, "utf8").trim();
      if (existing.length > 0) return existing;
    }
  } catch {}
  return undefined;
}
