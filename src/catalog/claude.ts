import type { ListedModel } from "./types.js";

// `Current model: `Name`` short names onto picker aliases (design §6.4).
const CLAUDE_SHORT_NAMES: Record<string, string> = {
  opus: "opus",
  sonnet: "sonnet",
  haiku: "haiku",
  fable: "fable",
};

// `claude -p /model --output-format json` with no extra arg lists aliases in
// the result text. A positive num_turns / total_cost_usd means a real model
// turn ran (the print-mode failure mode), not the slash listing.
export function parseClaudeModelSlash(jsonText: string): ListedModel[] {
  const data = JSON.parse(jsonText);
  if (typeof data?.num_turns === "number" && data.num_turns > 0) {
    throw new Error("claude: /model JSON is a model turn (num_turns > 0), not a catalog");
  }
  if (typeof data?.total_cost_usd === "number" && data.total_cost_usd > 0) {
    throw new Error("claude: /model JSON is a model turn (total_cost_usd > 0), not a catalog");
  }
  const result = data?.result;
  if (typeof result !== "string" || !result) {
    throw new Error("claude: /model JSON has no result text");
  }
  const availIdx = result.indexOf("Available:");
  if (availIdx < 0) throw new Error("claude: /model result has no Available list");
  let tail = result.slice(availIdx + "Available:".length);
  const stop = tail.search(/,\s*or a full model ID/i);
  if (stop >= 0) tail = tail.slice(0, stop);
  const ids = tail
    .split(",")
    .map((t) => t.trim().replace(/[.\s]+$/g, ""))
    .filter((t) => t.length > 0 && t.toLowerCase() !== "default");
  if (ids.length === 0) throw new Error("claude: /model Available list had no usable aliases");

  let defaultAlias: string | null = null;
  const cur = result.match(/Current model:\s*`([^`]+)`/i);
  if (cur) {
    const first = cur[1].trim().split(/\s+/)[0]?.toLowerCase();
    if (first && CLAUDE_SHORT_NAMES[first]) defaultAlias = CLAUDE_SHORT_NAMES[first];
  }
  return ids.map((id) => {
    const entry: ListedModel = { id, displayName: id };
    if (defaultAlias !== null && id === defaultAlias) entry.default = true;
    return entry;
  });
}
