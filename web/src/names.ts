// Display names for known server provider IDs. Arbitrary manual IDs render
// verbatim, so unknown IDs degrade gracefully instead of crashing.
// Map, not a plain object: Object.prototype keys such as __proto__ and
// constructor would otherwise resolve as inherited values, not literals.

const KNOWN = new Map<string, string>([
  ["claude", "Claude"],
  ["codex", "Codex"],
  ["kimi", "Kimi"],
  ["grok", "Grok"],
  ["agy", "Agy"],
  ["agy:3p", "Agy 3P"],
]);

export function displayName(id: string): string {
  return KNOWN.get(id) ?? id;
}

/** True for the five CLI-backed adapters; manual ids take generic copy. */
export function isKnownProvider(id: string): boolean {
  return KNOWN.has(id);
}
