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
      vendor: null,
      harness: null,
      description: "A quota you pasted in by hand. QuotaCap does not poll it.",
    });
  });

  it("pre-seeds muse for the concurrent adapter stream", () => {
    expect(providerIdentity("muse")).toEqual({
      displayName: "Muse",
      vendor: "Meta",
      harness: "Muse Code",
      description:
        "Meta's Muse Code subscription, running Muse Spark models, metered as a weekly window with a shorter current window inside it.",
    });
  });

  it("falls back to the raw id with null metadata for unknown ids", () => {
    expect(providerIdentity("my-plan")).toEqual({
      displayName: "my-plan",
      vendor: null,
      harness: null,
      description: null,
    });
  });

  it("treats Object.prototype keys as literal ids, not inherited values", () => {
    for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(providerIdentity(id)).toEqual({
        displayName: id,
        vendor: null,
        harness: null,
        description: null,
      });
    }
  });
});
