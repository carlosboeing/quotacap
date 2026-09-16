import type { ListedModel } from "./types.js";

// `kimi provider list --json` (design §6.3): top-level `models` map keyed by
// "<provider>/<key>"; every entry is on the live picker. id is the entry's
// `model` when present, else the key's trailing segment. `default` only when a
// top-level defaultModel names the key (the 2026-09-16 spike JSON had none).
export function parseKimiProviderList(jsonText: string): ListedModel[] {
  const data = JSON.parse(jsonText);
  const models = data?.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) {
    throw new Error("kimi: provider list JSON has no models object");
  }
  const defaultModel = typeof data.defaultModel === "string" ? data.defaultModel : null;
  const out: ListedModel[] = [];
  for (const [key, v] of Object.entries<any>(models)) {
    if (!v || typeof v !== "object") continue;
    const id =
      typeof v.model === "string" && v.model ? v.model : (key.split("/").pop() ?? key);
    const entry: ListedModel = {
      id,
      displayName: typeof v.displayName === "string" && v.displayName ? v.displayName : id,
    };
    if (Array.isArray(v.supportEfforts)) {
      const efforts = v.supportEfforts.filter((e: any) => typeof e === "string");
      if (efforts.length > 0) entry.efforts = efforts;
    }
    if (defaultModel !== null && key === defaultModel) entry.default = true;
    out.push(entry);
  }
  if (out.length === 0) throw new Error("kimi: provider list JSON contained no models");
  return out;
}
