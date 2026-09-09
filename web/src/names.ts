// Display names for known server provider IDs. Arbitrary manual IDs render
// verbatim, so unknown IDs degrade gracefully instead of crashing.

const KNOWN: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  kimi: "Kimi",
  grok: "Grok",
  agy: "Agy",
  "agy:3p": "Agy 3P",
};

export function displayName(id: string): string {
  return KNOWN[id] ?? id;
}
