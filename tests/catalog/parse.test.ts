import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { agyBucketForModelId, parseAgyModels } from "../../src/catalog/agy.js";
import { parseGrokModels } from "../../src/catalog/grok.js";
import { parseKimiProviderList } from "../../src/catalog/kimi.js";
import { parseClaudeModelSlash } from "../../src/catalog/claude.js";
import { parseCodexDebugModels } from "../../src/catalog/codex.js";
import { parseMuseModelPicker } from "../../src/catalog/muse.js";

const fx = (name: string) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");

describe("agyBucketForModelId", () => {
  it("classifies gemini to agy, claude/gpt to agy:3p, case-insensitively", () => {
    expect(agyBucketForModelId("gemini-3.8-flash-high")).toBe("agy");
    expect(agyBucketForModelId("Gemini-3.1-pro-low")).toBe("agy");
    expect(agyBucketForModelId("claude-sonnet-4-6")).toBe("agy:3p");
    expect(agyBucketForModelId("gpt-oss-120b-medium")).toBe("agy:3p");
    expect(agyBucketForModelId("GPT-6-Astra")).toBe("agy:3p");
    expect(agyBucketForModelId("llama-4-405b")).toBeNull();
  });
});

describe("parseAgyModels", () => {
  it("splits the 14-row spike fixture into 11 agy + 3 agy:3p", () => {
    const out = parseAgyModels(fx("agy-models.txt"));
    expect(out.agy).toHaveLength(11);
    expect(out["agy:3p"]).toHaveLength(3);
    expect(out["agy:3p"].map((m) => m.id)).toEqual([
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
    ]);
    expect(out.agy.every((m) => m.id.startsWith("gemini-"))).toBe(true);
    expect(out.agy.map((m) => m.id)).toContain("gemini-3.8-flash-high");
    const sonnet = out["agy:3p"][0];
    expect(sonnet.displayName).toBe("Claude Sonnet 4.6 (Thinking)");
    expect(sonnet.default).toBeUndefined();
    expect(sonnet.efforts).toBeUndefined();
  });

  it("skips a leading 'Fetching available models...' line", () => {
    const out = parseAgyModels("Fetching available models...\n" + fx("agy-models.txt"));
    expect(out.agy).toHaveLength(11);
    expect(out["agy:3p"]).toHaveLength(3);
  });

  it("throws on empty stdout", () => {
    expect(() => parseAgyModels("")).toThrow();
    expect(() => parseAgyModels("  \n\n")).toThrow();
    expect(() => parseAgyModels("Fetching available models...\n")).toThrow();
  });

  it("throws when rows exist but every id is unmatched", () => {
    const stdout = "llama-4-405b\tLlama 4\nmistral-large\tMistral Large\n";
    expect(() => parseAgyModels(stdout)).toThrow();
  });

  it("omits unmatched ids but keeps matched buckets, always returning both keys", () => {
    const out = parseAgyModels("gemini-3.8-flash-high\tGemini 3.8 Flash (High)\nllama-4-405b\tLlama 4\n");
    expect(out.agy.map((m) => m.id)).toEqual(["gemini-3.8-flash-high"]);
    expect(out["agy:3p"]).toEqual([]);
  });
});

describe("parseGrokModels", () => {
  it("parses the spike fixture, ignoring the login preamble", () => {
    const models = parseGrokModels(fx("grok-models.txt"));
    expect(models).toHaveLength(2);
    expect(models[0]).toEqual({ id: "grok-4.6", displayName: "grok-4.6", default: true });
    expect(models[1]).toEqual({ id: "grok-4.5", displayName: "grok-4.5" });
  });

  it("throws when no model bullet lines are present", () => {
    expect(() => parseGrokModels("You are logged in with grok.com.\n")).toThrow();
  });
});

describe("parseKimiProviderList", () => {
  it("parses every model in the spike JSON with displayName and efforts", () => {
    const models = parseKimiProviderList(fx("kimi-provider-list.json"));
    expect(models.map((m) => m.id)).toEqual([
      "kimi-for-coding",
      "kimi-for-coding-highspeed",
      "k3",
      "k3-256k",
    ]);
    expect(models.map((m) => m.displayName)).toEqual([
      "K2.8 Preview",
      "K2.7 Code Highspeed",
      "K3",
      "K3-256k",
    ]);
    expect(models[2].efforts).toEqual(["low", "high", "max"]);
    expect(models[1].efforts).toBeUndefined();
    // The spike JSON has no top-level defaultModel: no default flags.
    expect(models.every((m) => m.default === undefined)).toBe(true);
  });

  it("falls back to the key's trailing segment when model is absent", () => {
    const models = parseKimiProviderList(
      JSON.stringify({ models: { "kimi-code/k3": { displayName: "K3" } } }),
    );
    expect(models[0].id).toBe("k3");
    expect(models[0].displayName).toBe("K3");
  });

  it("marks default when a top-level defaultModel matches a key", () => {
    const models = parseKimiProviderList(
      JSON.stringify({
        defaultModel: "kimi-code/k3",
        models: {
          "kimi-code/kimi-for-coding": { model: "kimi-for-coding", displayName: "K2.8 Preview" },
          "kimi-code/k3": { model: "k3", displayName: "K3" },
        },
      }),
    );
    expect(models.find((m) => m.id === "k3")?.default).toBe(true);
    expect(models.find((m) => m.id === "kimi-for-coding")?.default).toBeUndefined();
  });

  it("throws when models is missing or not an object", () => {
    expect(() => parseKimiProviderList("{}")).toThrow();
    expect(() => parseKimiProviderList(JSON.stringify({ models: [] }))).toThrow();
    expect(() => parseKimiProviderList("not json")).toThrow();
  });
});

describe("parseClaudeModelSlash", () => {
  it("parses the spike slash JSON, drops the default token, keeps opus", () => {
    const models = parseClaudeModelSlash(fx("claude-model.json"));
    const ids = models.map((m) => m.id);
    expect(ids).toEqual([
      "sonnet",
      "opus",
      "haiku",
      "fable",
      "best",
      "sonnet[1m]",
      "opus[1m]",
      "fable[1m]",
      "opusplan",
    ]);
    expect(ids).not.toContain("default");
    expect(ids).toContain("opus");
    expect(models.every((m) => m.displayName === m.id)).toBe(true);
  });

  it("maps Current model onto an alias as default: true", () => {
    const models = parseClaudeModelSlash(fx("claude-model.json"));
    expect(models.find((m) => m.id === "opus")?.default).toBe(true);
    expect(models.filter((m) => m.default)).toHaveLength(1);
  });

  it("sets no default when Current model does not map to an alias", () => {
    const json = JSON.stringify({
      num_turns: 0,
      total_cost_usd: 0,
      result: "Current model: `Kestrel 2`\nUsage: /model <name>. Available: sonnet, opus, default, or a full model ID.",
    });
    const models = parseClaudeModelSlash(json);
    expect(models.map((m) => m.id)).toEqual(["sonnet", "opus"]);
    expect(models.every((m) => m.default === undefined)).toBe(true);
  });

  it("throws when a real model turn leaked into print mode", () => {
    expect(() =>
      parseClaudeModelSlash(JSON.stringify({ num_turns: 1, total_cost_usd: 0, result: "Available: opus" })),
    ).toThrow();
    expect(() =>
      parseClaudeModelSlash(JSON.stringify({ num_turns: 0, total_cost_usd: 0.42, result: "Available: opus" })),
    ).toThrow();
  });

  it("throws on the extra-arg 'Model not found' shape", () => {
    const json = JSON.stringify({
      num_turns: 0,
      total_cost_usd: 0,
      result: "Model 'gpt-9' not found.",
    });
    expect(() => parseClaudeModelSlash(json)).toThrow();
  });
});

describe("parseCodexDebugModels", () => {
  it("keeps visibility list rows and omits gpt-reserve (hide)", () => {
    const models = parseCodexDebugModels(fx("codex-debug-models.json"));
    expect(models.map((m) => m.id)).toEqual(["gpt-6-astra", "gpt-5.5"]);
    expect(models.find((m) => m.id === "gpt-reserve")).toBeUndefined();
  });

  it("projects only id, displayName, efforts — no prompt-template keys", () => {
    const models = parseCodexDebugModels(fx("codex-debug-models.json"));
    const astra = models[0];
    expect(astra.displayName).toBe("GPT-6-Astra");
    expect(astra.efforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(Object.keys(astra).sort()).toEqual(["displayName", "efforts", "id"]);
    expect(Object.keys(models[1]).sort()).toEqual(["displayName", "id"]);
    const serialized = JSON.stringify(models);
    for (const key of ["model_messages", "instructions_template", "description", "availability_nux", "visibility"]) {
      expect(serialized).not.toContain(key);
    }
  });

  it("throws when models is not an array", () => {
    expect(() => parseCodexDebugModels("{}")).toThrow();
    expect(() => parseCodexDebugModels(JSON.stringify({ models: null }))).toThrow();
    expect(() => parseCodexDebugModels("not json")).toThrow();
  });

  it("throws when a slug-bearing row lacks a string visibility", () => {
    const json = JSON.stringify({
      models: [{ slug: "gpt-6-astra", display_name: "GPT-6-Astra" }],
    });
    expect(() => parseCodexDebugModels(json)).toThrow();
  });

  it("returns [] for a well-formed all-hide dump", () => {
    const json = JSON.stringify({
      models: [
        { slug: "gpt-reserve", display_name: "GPT-Reserve", visibility: "hide" },
        { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide" },
      ],
    });
    expect(parseCodexDebugModels(json)).toEqual([]);
  });
});

describe("parseMuseModelPicker", () => {
  it("yields the four spike ids after Choose model, not the statusline singleton", () => {
    const models = parseMuseModelPicker(fx("muse-model-picker.txt"));
    expect(models.map((m) => m.id)).toEqual([
      "muse-spark-1.3",
      "muse-spark-1.3-contributor",
      "muse-spark-1.2",
      "muse-spark-1.2-contributor",
    ]);
  });

  it("marks the statusline id as default when it also appears in the picker", () => {
    const models = parseMuseModelPicker(fx("muse-model-picker.txt"));
    expect(models.find((m) => m.id === "muse-spark-1.3")?.default).toBe(true);
    expect(models.filter((m) => m.default)).toHaveLength(1);
  });

  it("throws on a statusline-only transcript (no Choose model)", () => {
    const transcript = "Muse Code 2.1 · High Usage · 35% used · muse-spark-1.3·max\n~/  ready\n";
    expect(() => parseMuseModelPicker(transcript)).toThrow();
  });

  it("throws when the picker opens but lists no muse-spark ids", () => {
    const transcript = "muse-spark-1.3·max\n\n> /model\n\nChoose model\n  (loading...)\n";
    expect(() => parseMuseModelPicker(transcript)).toThrow();
  });

  it("sets no default when the statusline id is not in the picker", () => {
    const transcript =
      "statusline muse-spark-9.9·max\n\nChoose model\n  ❯ muse-spark-1.3\n    muse-spark-1.2\n";
    const models = parseMuseModelPicker(transcript);
    expect(models.map((m) => m.id)).toEqual(["muse-spark-1.3", "muse-spark-1.2"]);
    expect(models.every((m) => m.default === undefined)).toBe(true);
  });

  it("strips ANSI before slicing the picker", () => {
    const transcript =
      "\x1b[38;5;244mmuse-spark-1.3·max\x1b[0m\n\x1b[1mChoose model\x1b[0m\n  ❯ \x1b[32mmuse-spark-1.3\x1b[0m\n    muse-spark-1.2\n";
    const models = parseMuseModelPicker(transcript);
    expect(models.map((m) => m.id)).toEqual(["muse-spark-1.3", "muse-spark-1.2"]);
    expect(models[0].default).toBe(true);
  });
});
