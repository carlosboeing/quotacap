import { adapters } from "../adapters/index.js";
import {
  projectQuotasResponse,
  projectRecommendationResponse,
} from "../advisory/snapshot.js";
import type { StateSnapshot } from "../advisory/types.js";
import { validateForecastProvider, validateTask } from "../advisory/validate.js";
import { getDbPath, readConfig } from "../config.js";
import { forecastText, stateWord } from "../format/rows.js";
import { renderMarkdownTable, renderRecommendationSummary } from "../format/markdown.js";
import { createServiceClientForBase, type ServiceClient } from "../runtime/client.js";
import { VERSION } from "../version.js";
import {
  ClientError,
  OFFLINE_LABEL,
  resolveSnapshot,
  type SnapshotSource,
} from "../cli/snapshot-source.js";

export const tools = [
  { name:"get_quotas", description:"All quotas with resets and health", inputSchema:{type:"object",properties:{}, required:[]} },
  { name:"get_recommendation", description:"Which provider to use next (same advice for every task)", inputSchema:{type:"object",properties:{task:{type:"string",enum:["any","heavy","light"]}}} },
  { name:"forecast", description:"Burn (24h + window avg) vs ideal + waste for a provider", inputSchema:{type:"object",properties:{provider:{type:"string"}}, required:["provider"]} },
];

// QUOTACAP_URL is used as configured: scheme, authority, effective port and
// path prefix all survive, so HTTPS and reverse-proxied services still work.
function clientFromUrl(): ServiceClient {
  const base = process.env.QUOTACAP_URL ?? "http://localhost:8787";
  return createServiceClientForBase(base, { timeoutMs: 5000 });
}

async function resolveState(): Promise<{ snapshot: StateSnapshot; source: SnapshotSource }> {
  const cfg = await readConfig();
  try {
    return await resolveSnapshot({
      client: clientFromUrl(),
      dbPath: getDbPath(),
      enabledProviders: cfg.enabledProviders,
      providerNames: cfg.providerNames,
      now: new Date(),
    });
  } catch (e) {
    if (e instanceof ClientError && e.kind === "no-data") {
      throw new Error("service-unavailable: no stored readings and the service is unreachable - start it (quotacap web)");
    }
    throw e;
  }
}

function rejectMissingProvider(args: any): void {
  try {
    validateForecastProvider(args?.provider, { registered: [], storedIds: [] });
  } catch (e: any) {
    // Only the missing-argument case is context-free; unknown-provider and
    // missing-reading need the snapshot, so they resolve first below.
    if (String(e?.message ?? "").startsWith("invalid-argument")) throw e;
  }
}

export async function handleTool(name:string, args:any){
  if(name==="get_quotas") {
    const { snapshot, source } = await resolveState();
    if (source === "offline") console.error(OFFLINE_LABEL);
    const now = new Date();
    return {
      content: [
        { type:"text", text: renderMarkdownTable(snapshot, now) },
        { type:"text", text: JSON.stringify(projectQuotasResponse(snapshot), null, 2) },
      ],
    };
  }
  if(name==="get_recommendation") {
    const task = validateTask(args?.task ?? "any");
    const { snapshot, source } = await resolveState();
    if (source === "offline") console.error(OFFLINE_LABEL);
    return {
      content: [
        { type:"text", text: renderRecommendationSummary(snapshot) },
        { type:"text", text: JSON.stringify(projectRecommendationResponse(snapshot, task), null, 2) },
      ],
    };
  }
  if(name==="forecast") {
    rejectMissingProvider(args);
    const { snapshot, source } = await resolveState();
    if (source === "offline") console.error(OFFLINE_LABEL);
    const storedIds = snapshot.providers.filter((p) => p.quota !== null).map((p) => p.id);
    const id = validateForecastProvider(args?.provider, {
      registered: [...Object.keys(adapters), "agy:3p"],
      storedIds,
    });
    const ps = snapshot.providers.find((p) => p.id === id)!;
    const body = {
      quota: ps.quota,
      advisory: ps.advisory,
      evidence: ps.evidence,
      exclusionReason: ps.exclusionReason,
      state: stateWord(ps),
      forecast: forecastText(ps, new Date()),
      lastAttempt: ps.lastAttempt,
    };
    return { content: [{ type:"text", text: JSON.stringify(body, null, 2) }] };
  }
  throw new Error(`unknown tool ${name}`);
}

export async function runMcpServer(){
  // Minimal MCP JSON-RPC stdio server — handles initialize, tools/list, tools/call, ping
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const respond = (id:any, result:any) => {
    process.stdout.write(JSON.stringify({ jsonrpc:"2.0", id, result })+"\n");
  };
  const error = (id:any, code:number, message:string) => {
    process.stdout.write(JSON.stringify({ jsonrpc:"2.0", id, error:{code, message} })+"\n");
  };
  rl.on("line", async (line:string)=>{
    if (!line.trim()) return;
    let msg:any;
    try { msg = JSON.parse(line); } catch { return; }
    const { id, method, params } = msg;
    // notifications have no id — no response
    const isNotification = id === undefined;
    try {
      if (method==="initialize") {
        if (!isNotification) respond(id, { protocolVersion:"2024-11-05", capabilities:{ tools:{} }, serverInfo:{ name:"quotacap", version:VERSION } });
      } else if (method==="notifications/initialized") {
        // no-op
      } else if (method==="tools/list") {
        if (!isNotification) respond(id, { tools });
      } else if (method==="tools/call") {
        const toolName = params?.name;
        const toolArgs = params?.arguments ?? {};
        try {
          const result = await handleTool(toolName, toolArgs);
          const content = Array.isArray(result?.content) ? result.content : [{ type:"text", text: JSON.stringify(result, null, 2) }];
          if (!isNotification) respond(id, { content });
        } catch (e:any) {
          const content = [{ type:"text", text: e?.message ?? String(e) }];
          if (!isNotification) respond(id, { content, isError:true });
        }
      } else if (method==="ping") {
        if (!isNotification) respond(id, {});
      } else {
        if (!isNotification) error(id, -32601, `Method not found: ${method}`);
      }
    } catch (e:any) {
      if (!isNotification) error(id, -32603, e?.message ?? String(e));
    }
  });
  // keep alive
  process.stdin.resume();
}
