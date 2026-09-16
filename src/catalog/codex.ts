import type { ListedModel } from "./types.js";

// `codex debug models` (design §6.5): the dump is ~500KB of prompt templates;
// project to id / displayName / efforts and keep `visibility === "list"` only.
// A slug-bearing row without a string visibility means the dump's shape
// drifted: throw (caller keeps the prior list). A well-formed all-hide dump is
// a successful empty picker, [] rather than a throw.
export function parseCodexDebugModels(jsonText: string): ListedModel[] {
  const data = JSON.parse(jsonText);
  const models = data?.models;
  if (!Array.isArray(models)) throw new Error("codex: debug models JSON has no models array");
  for (const row of models) {
    if (row && typeof row === "object" && typeof row.slug === "string" && typeof row.visibility !== "string") {
      throw new Error(`codex: model row "${row.slug}" lacks a string visibility`);
    }
  }
  const out: ListedModel[] = [];
  for (const row of models) {
    if (!row || typeof row !== "object" || typeof row.slug !== "string") continue;
    if (row.visibility !== "list") continue;
    const entry: ListedModel = {
      id: row.slug,
      displayName:
        typeof row.display_name === "string" && row.display_name ? row.display_name : row.slug,
    };
    if (Array.isArray(row.supported_reasoning_levels)) {
      const efforts = row.supported_reasoning_levels
        .map((l: any) => l?.effort)
        .filter((e: any) => typeof e === "string");
      if (efforts.length > 0) entry.efforts = efforts;
    }
    out.push(entry);
  }
  return out;
}
