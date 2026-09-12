import { describe, it, expect } from "vitest";
import { validateDisplayName } from "../../src/advisory/validation.js";

describe("validateDisplayName", () => {
  it("accepts valid provider display names and trims outer whitespace", () => {
    expect(validateDisplayName("Work Muse")).toBe("Work Muse");
    expect(validateDisplayName("  Google 3P  ")).toBe("Google 3P");
    expect(validateDisplayName("A")).toBe("A");
    expect(validateDisplayName("a".repeat(32))).toBe("a".repeat(32));
  });

  it("rejects non-string values", () => {
    expect(() => validateDisplayName(null)).toThrow(/must be a string/i);
    expect(() => validateDisplayName(undefined)).toThrow(/must be a string/i);
    expect(() => validateDisplayName(123)).toThrow(/must be a string/i);
    expect(() => validateDisplayName({})).toThrow(/must be a string/i);
  });

  it("rejects empty or whitespace-only names", () => {
    expect(() => validateDisplayName("")).toThrow(/empty/i);
    expect(() => validateDisplayName("   ")).toThrow(/empty/i);
    expect(() => validateDisplayName("\t  \t")).toThrow();
  });

  it("rejects names exceeding 32 characters", () => {
    expect(() => validateDisplayName("a".repeat(33))).toThrow(/32 characters/i);
    expect(() => validateDisplayName("   " + "a".repeat(33) + "   ")).toThrow(/32 characters/i);
  });

  it("rejects names containing control characters or newlines", () => {
    expect(() => validateDisplayName("Hello\nWorld")).toThrow(/control character/i);
    expect(() => validateDisplayName("Hello\rWorld")).toThrow(/control character/i);
    expect(() => validateDisplayName("Hello\tWorld")).toThrow(/control character/i);
    expect(() => validateDisplayName("Hello\x00World")).toThrow(/control character/i);
    expect(() => validateDisplayName("Hello\x07World")).toThrow(/control character/i);
    expect(() => validateDisplayName("Hello\x7fWorld")).toThrow(/control character/i);
    expect(() => validateDisplayName("Hello\x1bWorld")).toThrow(/control character/i);
  });

  it("rejects names containing ANSI escape sequences (terminal injection prevention)", () => {
    expect(() => validateDisplayName("\x1b[31mRed\x1b[0m")).toThrow();
    expect(() => validateDisplayName("\x1b[2JClear")).toThrow();
    expect(() => validateDisplayName("Provider\x1b[HHome")).toThrow();
  });

  it("rejects names containing bidirectional override or invisible characters", () => {
    // Right-to-Left Override (RLO)
    expect(() => validateDisplayName("claude\u202Ecodex")).toThrow(/bidirectional override or invisible/i);
    // Left-to-Right Override (LRO)
    expect(() => validateDisplayName("claude\u202Dcodex")).toThrow(/bidirectional override or invisible/i);
    // Bidi marks (LRM / RLM)
    expect(() => validateDisplayName("claude\u200E")).toThrow(/bidirectional override or invisible/i);
    expect(() => validateDisplayName("claude\u200F")).toThrow(/bidirectional override or invisible/i);
    // Zero-width space, joiner, non-joiner
    expect(() => validateDisplayName("claude\u200Bcodex")).toThrow(/bidirectional override or invisible/i);
    expect(() => validateDisplayName("claude\u200Ccodex")).toThrow(/bidirectional override or invisible/i);
    expect(() => validateDisplayName("claude\u200Dcodex")).toThrow(/bidirectional override or invisible/i);
    // Byte-order mark / zero-width no-break space
    expect(() => validateDisplayName("\uFEFFclaude")).toThrow(/bidirectional override or invisible/i);
    // Invisible math/format chars
    expect(() => validateDisplayName("claude\u2060codex")).toThrow(/bidirectional override or invisible/i);
  });
});
