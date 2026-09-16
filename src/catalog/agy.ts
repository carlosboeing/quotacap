import type { ListedModel } from "./types.js";

// Pinned split rule (design §6.1): one `agy models` list covers both quota
// buckets; the id prefix decides which. Unmatched ids are omitted from both.
export function agyBucketForModelId(id: string): "agy" | "agy:3p" | null {
  const s = id.trim().toLowerCase();
  if (s.startsWith("gemini")) return "agy";
  if (s.startsWith("claude") || s.startsWith("gpt")) return "agy:3p";
  return null;
}

export function parseAgyModels(stdout: string): Record<"agy" | "agy:3p", ListedModel[]> {
  const out: Record<"agy" | "agy:3p", ListedModel[]> = { agy: [], "agy:3p": [] };
  const rows: ListedModel[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (/^Fetching available models/i.test(t)) continue;
    const tab = t.indexOf("\t");
    const id = (tab < 0 ? t : t.slice(0, tab)).trim();
    const displayName = (tab < 0 ? "" : t.slice(tab + 1).trim()) || id;
    if (id) rows.push({ id, displayName });
  }
  // Empty stdout after a successful exit is a parse failure, not an empty picker.
  if (rows.length === 0) throw new Error("agy: no model rows in `agy models` output");
  let matched = 0;
  for (const row of rows) {
    const bucket = agyBucketForModelId(row.id);
    if (!bucket) continue;
    matched++;
    out[bucket].push(row);
  }
  // Rows came back but the classifier recognized none: the picker drifted.
  if (matched === 0) throw new Error("agy: no `agy models` row matched the bucket classifier");
  return out;
}
