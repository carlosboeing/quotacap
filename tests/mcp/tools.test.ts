import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { projectQuotasResponse, projectRecommendationResponse } from "../../src/advisory/snapshot.js";
import { stateWord } from "../../src/format/rows.js";
import { handleTool, tools } from "../../src/mcp/server.js";
import { OFFLINE_LABEL } from "../../src/cli/snapshot-source.js";
import { FIXED_NOW, exampleStateSnapshot, exampleStateSnapshotJson } from "../fixtures/stable-state.js";
import { seedFileDb } from "../cli/helpers.js";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

async function startStub(routes: Record<string, Handler>): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const handler = routes[req.url ?? ""];
    if (handler) handler(req, res);
    else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

async function closedPort(): Promise<number> {
  const stub = await startStub({});
  const { port } = stub;
  await stub.close();
  return port;
}

function serveState(stateJson: string): Record<string, Handler> {
  return {
    "/api/state": (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(stateJson);
    },
  };
}

const tmpDirs: string[] = [];
let savedHome: string | undefined;
let savedUrl: string | undefined;

beforeEach(() => {
  savedHome = process.env.QUOTACAP_HOME;
  savedUrl = process.env.QUOTACAP_URL;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "qc-mcp-"));
  tmpDirs.push(home);
  process.env.QUOTACAP_HOME = home;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.QUOTACAP_HOME;
  else process.env.QUOTACAP_HOME = savedHome;
  if (savedUrl === undefined) delete process.env.QUOTACAP_URL;
  else process.env.QUOTACAP_URL = savedUrl;
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("tool surface", () => {
  it("keeps tool names and schemas unchanged", () => {
    expect(tools).toEqual([
      {
        name: "get_quotas",
        description: expect.any(String),
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "get_recommendation",
        description: expect.any(String),
        inputSchema: {
          type: "object",
          properties: { task: { type: "string", enum: ["any", "heavy", "light"] } },
        },
      },
      {
        name: "forecast",
        description: expect.any(String),
        inputSchema: {
          type: "object",
          properties: { provider: { type: "string" } },
          required: ["provider"],
        },
      },
    ]);
  });

  it("get_recommendation promises no task-specific ranking", () => {
    const tool = tools.find((t) => t.name === "get_recommendation")!;
    expect(tool.description).not.toMatch(/task-specific|ranked|tailored|optimized/i);
    expect(tool.description).toMatch(/same advice for every task/);
  });
});

describe("get_quotas", () => {
  it("shares numbers, STATE words, and exclusion labels with the terminal renderers", async () => {
    const stub = await startStub(serveState(exampleStateSnapshotJson));
    process.env.QUOTACAP_URL = `http://127.0.0.1:${stub.port}`;
    try {
      const res: any = await handleTool("get_quotas", {});
      expect(res.isError).toBeUndefined();
      const [markdown, json] = res.content;
      expect(markdown.type).toBe("text");
      expect(markdown.text).toContain("| Provider | Used | Elapsed | Pace (%/day avg · 24h) | Resets | State | Forecast |");
      for (const p of exampleStateSnapshot.providers) {
        if (p.quota) expect(markdown.text).toContain(`| ${Math.round(p.quota.usedPct)}% |`);
        expect(markdown.text).toContain(`| ${stateWord(p)} |`);
      }
      expect(markdown.text).toContain("stale 3h ago");
      expect(markdown.text).toContain("invalid reading");
      expect(json.type).toBe("text");
      expect(JSON.parse(json.text)).toEqual(projectQuotasResponse(exampleStateSnapshot));
    } finally {
      await stub.close();
    }
  });
});

describe("get_recommendation", () => {
  it("returns the shared recommendation with a use: reason summary", async () => {
    const stub = await startStub(serveState(exampleStateSnapshotJson));
    process.env.QUOTACAP_URL = `http://127.0.0.1:${stub.port}`;
    try {
      const res: any = await handleTool("get_recommendation", { task: "any" });
      expect(res.isError).toBeUndefined();
      expect(res.content[0].text).toBe("my-plan: 76% waste in 7.0d");
      expect(JSON.parse(res.content[1].text)).toEqual(
        projectRecommendationResponse(exampleStateSnapshot, "any"),
      );
    } finally {
      await stub.close();
    }
  });

  it("rejects bogus tasks and returns the same body for every valid task", async () => {
    const stub = await startStub(serveState(exampleStateSnapshotJson));
    process.env.QUOTACAP_URL = `http://127.0.0.1:${stub.port}`;
    try {
      await expect(handleTool("get_recommendation", { task: "bogus" })).rejects.toThrow(/invalid-argument/);
      const bodies: string[] = [];
      for (const task of ["any", "heavy", "light"]) {
        const res: any = await handleTool("get_recommendation", { task });
        bodies.push(res.content[1].text);
      }
      expect(bodies[1]).toBe(bodies[0]);
      expect(bodies[2]).toBe(bodies[0]);
      expect(JSON.parse(bodies[0]).recommendationBasis).toBe(
        exampleStateSnapshot.recommendation.recommendationBasis,
      );
    } finally {
      await stub.close();
    }
  });
});

describe("forecast", () => {
  it("returns quota plus advisory with additive state keys", async () => {
    const stub = await startStub(serveState(exampleStateSnapshotJson));
    process.env.QUOTACAP_URL = `http://127.0.0.1:${stub.port}`;
    try {
      const res: any = await handleTool("forecast", { provider: "kimi" });
      expect(Object.keys(res)).toEqual(["content"]);
      expect(res.content).toHaveLength(1);
      expect(Object.keys(res.content[0])).toEqual(["type", "text"]);
      expect(res.content[0].type).toBe("text");
      const body = JSON.parse(res.content[0].text);
      expect(body.quota.provider).toBe("kimi");
      expect(body.advisory.provider).toBe("kimi");
      expect(body.evidence).toEqual(["window-average"]);
      expect(body.exclusionReason).toBeNull();
      expect(body.state).toBe("Behind pace");
      expect(body.forecast).toBe("56% waste in 7.0d");
    } finally {
      await stub.close();
    }
  });

  it("validates manual IDs by storage and group IDs by their own row", async () => {
    const stub = await startStub(serveState(exampleStateSnapshotJson));
    process.env.QUOTACAP_URL = `http://127.0.0.1:${stub.port}`;
    try {
      const manual: any = await handleTool("forecast", { provider: "my-plan" });
      expect(JSON.parse(manual.content[0].text).quota.provider).toBe("my-plan");
      const group: any = await handleTool("forecast", { provider: "agy:3p" });
      const groupBody = JSON.parse(group.content[0].text);
      expect(groupBody.exclusionReason).toBe("stale");
      expect(groupBody.state).toBe("Not reporting");
    } finally {
      await stub.close();
    }
  });

  it("rejects unknown providers, missing readings, and missing args", async () => {
    const stub = await startStub(serveState(exampleStateSnapshotJson));
    process.env.QUOTACAP_URL = `http://127.0.0.1:${stub.port}`;
    try {
      await expect(handleTool("forecast", { provider: "nope" })).rejects.toThrow(/unknown-provider/);
      // Display names are output only: the argument stays id-based.
      await expect(handleTool("forecast", { provider: "Kimi" })).rejects.toThrow(/unknown-provider/);
      await expect(handleTool("forecast", {})).rejects.toThrow(/invalid-argument/);
      await expect(handleTool("forecast", { provider: "" })).rejects.toThrow(/invalid-argument/);
    } finally {
      await stub.close();
    }
  });

  it("needs a stored row even for registered IDs and agy group parents", async () => {
    const withoutCodex = JSON.parse(exampleStateSnapshotJson);
    withoutCodex.providers.find((p: any) => p.id === "codex").quota = null;
    const withoutGroup = JSON.parse(exampleStateSnapshotJson);
    withoutGroup.providers.find((p: any) => p.id === "agy:3p").quota = null;
    let mode = "codex";
    const stub = await startStub({
      "/api/state": (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(mode === "codex" ? withoutCodex : withoutGroup));
      },
    });
    process.env.QUOTACAP_URL = `http://127.0.0.1:${stub.port}`;
    try {
      await expect(handleTool("forecast", { provider: "codex" })).rejects.toThrow(/missing-reading/);
      mode = "group";
      await expect(handleTool("forecast", { provider: "agy:3p" })).rejects.toThrow(/missing-reading/);
    } finally {
      await stub.close();
    }
  });
});

describe("QUOTACAP_URL is used as configured", () => {
  it("keeps the scheme, effective port, path prefix, and IPv6 authority", async () => {
    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      seen.push(String(input));
      return new Response(exampleStateSnapshotJson, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    for (const base of [
      "https://quota.example.com",
      "http://example.com/quotacap/",
      "http://[::1]:8787",
    ]) {
      process.env.QUOTACAP_URL = base;
      await handleTool("get_quotas", {});
    }
    expect(seen).toEqual([
      "https://quota.example.com/api/state",
      "http://example.com/quotacap/api/state",
      "http://[::1]:8787/api/state",
    ]);
  });

  it("reaches a path-prefixed service over a real socket", async () => {
    const stub = await startStub({
      "/quotacap/api/state": (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(exampleStateSnapshotJson);
      },
    });
    process.env.QUOTACAP_URL = `http://127.0.0.1:${stub.port}/quotacap`;
    try {
      const res: any = await handleTool("get_quotas", {});
      expect(res.isError).toBeUndefined();
      expect(JSON.parse(res.content[1].text)).toEqual(projectQuotasResponse(exampleStateSnapshot));
    } finally {
      await stub.close();
    }
  });
});

describe("offline fallback", () => {
  it("serves the labeled offline snapshot instead of isError", async () => {
    process.env.QUOTACAP_URL = `http://127.0.0.1:${await closedPort()}`;
    seedFileDb(path.join(process.env.QUOTACAP_HOME!, ".quotacap", "quotacap.db"));
    const res: any = await handleTool("get_quotas", {});
    expect(res.isError).toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(OFFLINE_LABEL);
    expect(res.content[0].text).toContain("Not reporting");
    expect(res.content[0].text).toContain("stale");
    const rows = JSON.parse(res.content[1].text);
    expect(rows.find((r: any) => r.provider === "kimi").exclusionReason).toBe("stale");
    const rec: any = await handleTool("get_recommendation", {});
    expect(rec.isError).toBeUndefined();
    expect(JSON.parse(rec.content[1].text).use).toBe("none");
  });

  it("reports service-unavailable when no readings are stored either", async () => {
    process.env.QUOTACAP_URL = `http://127.0.0.1:${await closedPort()}`;
    await expect(handleTool("get_quotas", {})).rejects.toThrow(/service-unavailable/);
  });
});

describe("provider failure observability in MCP", () => {
  const failedState = () => {
    const s = JSON.parse(exampleStateSnapshotJson);
    const codex = s.providers.find((p: any) => p.id === "codex");
    codex.reporting = false;
    codex.exclusionReason = "provider-failed";
    codex.lastAttempt = {
      provider: "codex",
      attemptedAt: FIXED_NOW.toISOString(),
      completedAt: FIXED_NOW.toISOString(),
      succeededAt: null,
      success: false,
      failureCategory: "unknown",
      diagnosticCode: "terminal_error",
      summary: "Unable to open Codex session",
      action: "Open Codex directly in your terminal to check whether it starts.",
      errorDetail: "pty exited during settle (code 1): stdin is not a terminal",
    };
    return s;
  };

  it("includes exact lastAttempt in forecast response", async () => {
    const stub = await startStub(serveState(JSON.stringify(failedState())));
    process.env.QUOTACAP_URL = `http://127.0.0.1:${stub.port}`;
    try {
      const res: any = await handleTool("forecast", { provider: "codex" });
      expect(res.isError).toBeUndefined();
      const body = JSON.parse(res.content[0].text);
      expect(body.forecast).toBe("Unable to open Codex session");
      expect(body.lastAttempt).toEqual(failedState().providers.find((p: any) => p.id === "codex").lastAttempt);
    } finally {
      await stub.close();
    }
  });

  it("get_quotas renders friendly summary in markdown table and leaves JSON quota keys unchanged", async () => {
    const stub = await startStub(serveState(JSON.stringify(failedState())));
    process.env.QUOTACAP_URL = `http://127.0.0.1:${stub.port}`;
    try {
      const res: any = await handleTool("get_quotas", {});
      expect(res.isError).toBeUndefined();
      const [markdown, json] = res.content;
      expect(markdown.text).toContain("Unable to open Codex session");
      const rows = JSON.parse(json.text);
      const codexRow = rows.find((r: any) => r.provider === "codex");
      expect(Object.keys(codexRow)).toEqual(
        Object.keys(projectQuotasResponse(JSON.parse(exampleStateSnapshotJson)).find((r) => r.provider === "codex")!),
      );
      expect(codexRow.diagnosticCode).toBeUndefined();
      expect(codexRow.summary).toBeUndefined();
    } finally {
      await stub.close();
    }
  });

  it("preserves missing-reading rejection for failed provider without quota", async () => {
    const state = failedState();
    state.providers.find((p: any) => p.id === "codex").quota = null;
    const stub = await startStub(serveState(JSON.stringify(state)));
    process.env.QUOTACAP_URL = `http://127.0.0.1:${stub.port}`;
    try {
      await expect(handleTool("forecast", { provider: "codex" })).rejects.toThrow(/missing-reading/);
    } finally {
      await stub.close();
    }
  });
});
