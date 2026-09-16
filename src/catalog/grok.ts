import type { ListedModel } from "./types.js";

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
