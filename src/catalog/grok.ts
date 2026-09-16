import { trackedExecFile } from "../runtime/spawn.js";
import type { CatalogFetcher, ListedModel } from "./types.js";

// `grok models` prints a login preamble, a "Default model:" line, then an
// "Available models:" list of `* id (default)` / `- id` bullets (design §6.2).
export function parseGrokModels(stdout: string): ListedModel[] {
  const models: ListedModel[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*[* -]\s+(\S+)/);
    if (!m) continue;
    const id = m[1];
    const entry: ListedModel = { id, displayName: id };
    if (/\(default\)/i.test(line)) entry.default = true;
    models.push(entry);
  }
  if (models.length === 0) throw new Error("grok: no models found in `grok models` output");
  return models;
}

const EXEC_TIMEOUT_MS = 8000;

export const grokCatalogFetcher: CatalogFetcher = {
  id: "grok",
  async fetch() {
    // Per-fetch catalog-owned signal: never the usage poll's shared controller.
    const { stdout } = await trackedExecFile("grok", "grok", ["models"], {
      timeout: EXEC_TIMEOUT_MS,
      signal: new AbortController().signal,
    });
    try {
      return { grok: parseGrokModels(stdout) };
    } catch (e) {
      throw new Error(`grok: failed to parse \`grok models\` output: ${(e as Error)?.message ?? e}`);
    }
  },
};
