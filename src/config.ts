import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { adapters } from "./adapters/index.js";

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
  enabledProviders: z.array(z.string()).default(["claude", "codex", "kimi", "grok", "agy"]),
  // Optional, omitted from defaults and `init` output. Manual ingest stays
  // in-tree but is not a public surface until the product design lands.
  experimentalIngest: z.boolean().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

function envFlag(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return undefined;
}

/**
 * Manual ingest (CLI `ingest`, POST /api/ingest) is off unless this returns
 * true. Env `QUOTACAP_EXPERIMENTAL_INGEST` wins; otherwise the optional
 * config key. Do not document this as a supported product flag.
 */
export function isExperimentalIngestEnabled(
  config?: Pick<Config, "experimentalIngest">,
  env: NodeJS.Dict<string> = process.env,
): boolean {
  const fromEnv = envFlag(env.QUOTACAP_EXPERIMENTAL_INGEST);
  if (fromEnv !== undefined) return fromEnv;
  if (config) return config.experimentalIngest === true;
  try {
    const parsed = JSON.parse(fsSync.readFileSync(getConfigPath(), "utf8"));
    return parsed?.experimentalIngest === true;
  } catch {
    return false;
  }
}

export async function readConfig(p?: string): Promise<Config> {
  try {
    const raw = await fs.readFile(getConfigPath(p), "utf8");
    return ConfigSchema.parse(JSON.parse(raw));
  } catch {
    return ConfigSchema.parse({});
  }
}

// Strict service-start validation (decision D6): a missing file still means
// defaults, but a present-but-invalid file fails startup naming the field.
// One-shot clients keep the lenient readConfig above.
const VALID_PROVIDER_IDS = Object.keys(adapters).sort();

const ServiceConfigSchema = z.object({
  port: z.number().int().min(1).max(65535),
  pollMinutes: z.number().finite().positive(),
  enabledProviders: z
    .array(z.string())
    .superRefine((ids, ctx) => {
      const bad = ids.filter((id) => !(id in adapters));
      if (bad.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `unknown provider id(s): ${bad.join(", ")} (valid: ${VALID_PROVIDER_IDS.join(", ")})`,
        });
      }
    }),
  experimentalIngest: z.boolean().optional(),
});

export async function readServiceConfig(p?: string): Promise<Config> {
  const file = getConfigPath(p);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return ConfigSchema.parse({});
    throw new Error(`invalid config: cannot read ${file}: ${err?.message ?? err}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err: any) {
    throw new Error(`invalid config: ${file} is not valid JSON: ${err?.message ?? err}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`invalid config: ${file} must contain a JSON object`);
  }
  const withDefaults = { ...ConfigSchema.parse({}), ...parsed };
  try {
    return ServiceConfigSchema.parse(withDefaults);
  } catch (err: any) {
    const issue = err?.issues?.[0];
    const field = issue?.path?.length ? String(issue.path.join(".")) : "config";
    throw new Error(`invalid config: ${field}: ${issue?.message ?? err?.message ?? err}`);
  }
}

export async function writeConfig(c: Config, p?: string): Promise<void> {
  await fs.mkdir(path.dirname(getConfigPath(p)), { recursive: true });
  await fs.writeFile(getConfigPath(p), JSON.stringify(c, null, 2));
}

// Private service metadata: install identity plus resolved provider paths
// only — never tokens, secrets, or environment dumps.
export interface ServiceMetadata {
  version: string;
  exec: string;
  entry?: string;
  providerPaths: Record<string, string | null>;
  installedAt: string;
}

export function serviceMetadataPath(dataDir = path.dirname(getDbPath())): string {
  return path.join(dataDir, "service.json");
}

export function writeServiceMetadata(
  m: ServiceMetadata,
  dataDir = path.dirname(getDbPath()),
): void {
  const file = serviceMetadataPath(dataDir);
  try {
    fsSync.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      fsSync.chmodSync(path.dirname(file), 0o700);
    } catch {}
  } catch {}
  fsSync.writeFileSync(file, JSON.stringify(m, null, 2), {
    mode: 0o600,
    encoding: "utf8",
  });
  try {
    fsSync.chmodSync(file, 0o600);
  } catch {}
}

export function readServiceMetadata(
  dataDir = path.dirname(getDbPath()),
): ServiceMetadata | null {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(serviceMetadataPath(dataDir), "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.version !== "string" ||
      typeof parsed.exec !== "string" ||
      typeof parsed.providerPaths !== "object" ||
      parsed.providerPaths === null ||
      typeof parsed.installedAt !== "string"
    ) {
      return null;
    }
    return parsed as ServiceMetadata;
  } catch {
    return null;
  }
}
