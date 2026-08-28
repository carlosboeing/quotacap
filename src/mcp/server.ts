export const tools = [
  { name:"get_quotas", description:"All quotas with resets and health", inputSchema:{type:"object",properties:{}, required:[]} },
  { name:"get_recommendation", description:"Which provider to use next", inputSchema:{type:"object",properties:{task:{type:"string",enum:["any","heavy","light"]}}} },
  { name:"forecast", description:"Burn vs ideal + waste for a provider", inputSchema:{type:"object",properties:{provider:{type:"string"}}, required:["provider"]} },
];
async function fetchJson(path:string){
  const base = process.env.QUOTACAP_URL ?? "http://localhost:8787";
  try {
    const r = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) });
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  } catch (e:any) {
    // any transport failure (node or bun wording) is a daemon-down situation
    throw new Error(`daemon not running, run quotacap web — ${e?.message ?? String(e)}`);
  }
}
export async function handleTool(name:string, args:any){
  if(name==="get_quotas") return fetchJson("/api/quotas");
  if(name==="get_recommendation") return fetchJson(`/api/recommendation?task=${args?.task??"any"}`);
  if(name==="forecast") {
    if(!args?.provider) throw new Error("provider required");
    const [quotas, rec] = await Promise.all([fetchJson("/api/quotas"), fetchJson(`/api/recommendation`)]);
    const q = quotas.find((x:any)=> x.provider===args.provider);
    if (!q) throw new Error(`unknown provider ${args.provider}`);
    return { quota:q, advisory: rec.advisories?.find((a:any)=>a.provider===args.provider) };
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
        if (!isNotification) respond(id, { protocolVersion:"2024-11-05", capabilities:{ tools:{} }, serverInfo:{ name:"quotacap", version:"0.0.1" } });
      } else if (method==="notifications/initialized") {
        // no-op
      } else if (method==="tools/list") {
        if (!isNotification) respond(id, { tools });
      } else if (method==="tools/call") {
        const toolName = params?.name;
        const toolArgs = params?.arguments ?? {};
        try {
          const result = await handleTool(toolName, toolArgs);
          const content = [{ type:"text", text: JSON.stringify(result, null, 2) }];
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
