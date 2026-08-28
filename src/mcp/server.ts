export const tools = [
  { name:"get_quotas", description:"All quotas with resets", inputSchema:{type:"object",properties:{}} },
  { name:"get_recommendation", description:"Which provider to use next", inputSchema:{type:"object",properties:{task:{type:"string",enum:["any","heavy","light"]}}} },
  { name:"forecast", description:"Burn vs ideal for a provider", inputSchema:{type:"object",properties:{provider:{type:"string"}}} },
];
async function fetchJson(path:string){
  const base = process.env.QUOTACAP_URL ?? "http://localhost:8787";
  const r = await fetch(`${base}${path}`);
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
export async function handleTool(name:string, args:any){
  if(name==="get_quotas") return fetchJson("/api/quotas");
  if(name==="get_recommendation") return fetchJson(`/api/recommendation?task=${args.task??"any"}`);
  if(name==="forecast") {
    const quotas = await fetchJson("/api/quotas");
    const q = quotas.find((x:any)=> x.provider===args.provider);
    const rec = await fetchJson(`/api/recommendation`);
    return { quota:q, advisory: rec.advisories?.find((a:any)=>a.provider===args.provider) };
  }
  throw new Error(`unknown tool ${name}`);
}
