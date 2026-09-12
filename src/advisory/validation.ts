// Security-relevant display name validation for provider overrides.
// Strings are rendered in terminal and web surfaces; unescaped ANSI sequences
// or control characters would allow terminal escape injection.

// Matches ASCII control characters (0x00-0x1F, 0x7F) and C1 control characters (0x80-0x9F).
const CONTROL_OR_NEWLINE_REGEX = /[\x00-\x1f\x7f-\x9f]/;

// Explicit ANSI escape sequence pattern matching standard CSI / OSC / Fe sequences.
const ANSI_ESCAPE_REGEX = /(?:\x1b[@-Z\\-_]|\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/;

// Matches Unicode bidirectional control characters and invisible zero-width formatting characters.
const BIDI_OR_INVISIBLE_REGEX = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/;

export const MAX_DISPLAY_NAME_LENGTH = 32;

/**
 * Validates a user-supplied provider display name override.
 * Rejects non-strings, empty/whitespace strings, strings > 32 characters,
 * strings with control characters/newlines, strings with ANSI escape sequences,
 * and strings with bidirectional override or invisible formatting characters.
 * Returns the trimmed valid name.
 */
export function validateDisplayName(name: unknown): string {
  if (typeof name !== "string") {
    throw new Error("Provider display name must be a string");
  }

  if (CONTROL_OR_NEWLINE_REGEX.test(name)) {
    throw new Error("Provider display name must not contain control characters or newlines");
  }

  if (ANSI_ESCAPE_REGEX.test(name)) {
    throw new Error("Provider display name must not contain ANSI escape sequences");
  }

  if (BIDI_OR_INVISIBLE_REGEX.test(name)) {
    throw new Error(
      "Provider display name must not contain bidirectional override or invisible characters",
    );
  }

  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error("Provider display name must not be empty or whitespace-only");
  }

  if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new Error(
      `Provider display name must not exceed ${MAX_DISPLAY_NAME_LENGTH} characters (got ${trimmed.length})`,
    );
  }

  return trimmed;
}
