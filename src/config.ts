import os from "node:os";
import path from "node:path";
export function getConfigPath(): string {
  return path.join(os.homedir(), ".quotacap", "config.json");
}
export function getDbPath(): string {
  return path.join(os.homedir(), ".quotacap", "quotacap.db");
}
