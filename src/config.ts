import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export function getConfigPath(p?: string): string {
  if (p) return p;
  return path.join(process.env.QUOTACAP_HOME ?? os.homedir(), ".quotacap", "config.json");
}
export function getDbPath(p?: string): string {
  if (p) return p;
  return path.join(process.env.QUOTACAP_HOME ?? os.homedir(), ".quotacap", "quotacap.db");
}

const ConfigSchema = z.object({
  port: z.number().default(8787),
  pollMinutes: z.number().default(15),
  enabledProviders: z.array(z.string()).default(["claude"]),
});

export type Config = z.infer<typeof ConfigSchema>;

export async function readConfig(p?: string): Promise<Config> {
  try {
    const raw = await fs.readFile(getConfigPath(p), "utf8");
    return ConfigSchema.parse(JSON.parse(raw));
  } catch {
    return ConfigSchema.parse({});
  }
}

export async function writeConfig(c: Config, p?: string): Promise<void> {
  await fs.mkdir(path.dirname(getConfigPath(p)), { recursive: true });
  await fs.writeFile(getConfigPath(p), JSON.stringify(c, null, 2));
}
