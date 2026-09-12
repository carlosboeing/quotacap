// One server-side home for provider identity. Unknown ids (manual pastes)
// degrade to the raw id with null metadata instead of throwing. Map, not a
// plain object: Object.prototype keys such as __proto__ and constructor would
// otherwise resolve as inherited values, not literals.

export interface ProviderIdentity {
  displayName: string;
  builtinName: string | null;
  vendor: string | null;
  harness: string | null;
  description: string | null;
}

export const REGISTRY = new Map<
  string,
  { displayName: string; vendor: string | null; harness: string | null; description: string }
>([
  [
    "claude",
    {
      displayName: "Claude",
      vendor: "Anthropic",
      harness: "Claude Code",
      description:
        "Anthropic's Claude Code subscription, metered as a weekly window with a shorter session window inside it.",
    },
  ],
  [
    "codex",
    {
      displayName: "Codex",
      vendor: "OpenAI",
      harness: "Codex CLI",
      description: "OpenAI's Codex CLI subscription, metered as weekly and 5-hour windows.",
    },
  ],
  [
    "kimi",
    {
      displayName: "Kimi",
      vendor: "Moonshot AI",
      harness: "Kimi Code",
      description: "Moonshot's Kimi Code subscription, metered as weekly and 5-hour windows.",
    },
  ],
  [
    "grok",
    {
      displayName: "Grok",
      vendor: "xAI",
      harness: "Grok CLI",
      description:
        "xAI's Grok CLI subscription, metered weekly, with a separate pay-as-you-go credit balance.",
    },
  ],
  [
    "agy",
    {
      displayName: "Antigravity",
      vendor: "Google",
      harness: "Antigravity",
      description:
        "The Gemini model pool in Google's Antigravity, metered weekly with a 5-hour window inside it.",
    },
  ],
  [
    "agy:3p",
    {
      displayName: "Antigravity 3P",
      vendor: "Google",
      harness: "Antigravity",
      description:
        "The third-party model pool in Google's Antigravity — Claude and GPT models billed against your Google plan and metered separately from Gemini.",
    },
  ],
  [
    "muse",
    {
      displayName: "Muse",
      vendor: "Meta",
      harness: "Muse Code",
      description:
        "Meta's Muse Code subscription, running Muse Spark models, metered as a weekly window with a shorter current window inside it.",
    },
  ],
  [
    "manual",
    {
      displayName: "Manual",
      vendor: null,
      harness: null,
      description: "A quota you pasted in by hand. QuotaCap does not poll it.",
    },
  ],
]);

export function providerIdentity(
  id: string,
  overrides?: Record<string, string>,
): ProviderIdentity {
  const entry = REGISTRY.get(id);
  const override =
    overrides && typeof overrides[id] === "string" && overrides[id].trim().length > 0
      ? overrides[id].trim()
      : undefined;

  if (!entry) {
    return {
      displayName: override ?? id,
      builtinName: null,
      vendor: null,
      harness: null,
      description: null,
    };
  }

  return {
    ...entry,
    displayName: override ?? entry.displayName,
    builtinName: entry.displayName,
  };
}
