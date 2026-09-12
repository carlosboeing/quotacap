import { describe, it, expect } from "vitest";
import { adapters } from "../../src/adapters/index.js";
import { providerIdentity } from "../../src/advisory/provider-names.js";

const POLLING_IDS = ["claude", "codex", "kimi", "grok", "agy"];

describe("provider naming registry", () => {
  it("registers every adapter id and agy:3p with a display name and description", () => {
    for (const id of [...Object.keys(adapters), "agy:3p"]) {
      const identity = providerIdentity(id);
      expect(identity.displayName.length).toBeGreaterThan(0);
      expect(identity.description).not.toBeNull();
    }
  });

  it("gives every polling adapter and agy:3p a vendor and harness", () => {
    for (const id of [...POLLING_IDS, "agy:3p"]) {
      const identity = providerIdentity(id);
      expect(identity.vendor).not.toBeNull();
      expect(identity.harness).not.toBeNull();
    }
  });

  it("names agy and agy:3p under the standard", () => {
    expect(providerIdentity("agy").displayName).toBe("Antigravity");
    expect(providerIdentity("agy:3p").displayName).toBe("Antigravity 3P");
    expect(providerIdentity("agy:3p").vendor).toBe("Google");
    expect(providerIdentity("agy:3p").harness).toBe("Antigravity");
  });

  it("names manual without a vendor or harness", () => {
    expect(providerIdentity("manual")).toEqual({
      displayName: "Manual",
      builtinName: "Manual",
      vendor: null,
      harness: null,
      description: "A quota you pasted in by hand. QuotaCap does not poll it.",
    });
  });

  it("pre-seeds muse for the concurrent adapter stream", () => {
    expect(providerIdentity("muse")).toEqual({
      displayName: "Muse",
      builtinName: "Muse",
      vendor: "Meta",
      harness: "Muse Code",
      description:
        "Meta's Muse Code subscription, running Muse Spark models, metered as a weekly window with a shorter current window inside it.",
    });
  });

  it("falls back to the raw id with null metadata for unknown ids", () => {
    expect(providerIdentity("my-plan")).toEqual({
      displayName: "my-plan",
      builtinName: null,
      vendor: null,
      harness: null,
      description: null,
    });
  });

  it("treats Object.prototype keys as literal ids, not inherited values", () => {
    for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(providerIdentity(id)).toEqual({
        displayName: id,
        builtinName: null,
        vendor: null,
        harness: null,
        description: null,
      });
    }
  });

  describe("user overrides", () => {
    it("resolves override over built-in name while preserving builtinName", () => {
      const identity = providerIdentity("muse", { muse: "Work Muse" });
      expect(identity.displayName).toBe("Work Muse");
      expect(identity.builtinName).toBe("Muse");
      expect(identity.vendor).toBe("Meta");
      expect(identity.harness).toBe("Muse Code");
    });

    it("resolves override over raw id for unregistered provider with null builtinName", () => {
      const identity = providerIdentity("custom-llm", { "custom-llm": "My Local LLM" });
      expect(identity.displayName).toBe("My Local LLM");
      expect(identity.builtinName).toBeNull();
      expect(identity.vendor).toBeNull();
      expect(identity.harness).toBeNull();
    });

    it("ignores inert overrides for non-matching ids", () => {
      const identity = providerIdentity("claude", { other: "Something Else" });
      expect(identity.displayName).toBe("Claude");
      expect(identity.builtinName).toBe("Claude");
    });

    it("allows duplicate display names across different providers", () => {
      const overrides = { claude: "Daily Driver", codex: "Daily Driver" };
      expect(providerIdentity("claude", overrides).displayName).toBe("Daily Driver");
      expect(providerIdentity("codex", overrides).displayName).toBe("Daily Driver");
    });
  });
});
