#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { buildApp } from "../http/server.js";
import { openDb, migrate } from "../store/db.js";
import { getDbPath, readConfig } from "../config.js";
function ensureDbDir(){ try{ fs.mkdirSync(path.dirname(getDbPath()), {recursive:true}); }catch{} }
const program = new Command();
program.name("quotacap").version("0.0.1");
program.command("status").option("--json","json").action(async (opts)=>{
  ensureDbDir(); const db=openDb(getDbPath()); migrate(db);
  const { getAllLatest } = await import("../store/quotas.js");
  const quotas=getAllLatest(db);
  if(opts.json) console.log(JSON.stringify(quotas,null,2)); else console.table(quotas);
});
program.command("advise").option("--json","json").option("--task <t>","task","any").action(async (opts)=>{
  ensureDbDir(); const db=openDb(getDbPath()); migrate(db);
  try {
    const r=await fetch(`http://localhost:${(await readConfig()).port}/api/recommendation?task=${opts.task}`, {signal: AbortSignal.timeout(2000)});
    const j=await r.json(); console.log(opts.json? JSON.stringify(j,null,2) : `${j.use}: ${j.reason}`);
  } catch {
    const { recommend } = await import("../advisory/engine.js");
    const { getAllLatest } = await import("../store/quotas.js");
    const quotas=getAllLatest(db);
    if(!quotas.length){ console.log(opts.json? JSON.stringify({use:"none",reason:"no quotas yet"},null,2) : "none: no quotas yet"); return; }
    const rec=recommend(quotas, opts.task);
    console.log(opts.json? JSON.stringify(rec,null,2) : `${rec.use}: ${rec.reason}`);
  }
});
program.command("ingest").requiredOption("--provider <p>").requiredOption("--text <t>").action(async (o)=>{
  ensureDbDir(); const db=openDb(getDbPath()); migrate(db);
  const { parseManualUsage } = await import("../adapters/manual.js");
  const { upsertQuota } = await import("../store/quotas.js");
  upsertQuota(db, parseManualUsage(o.provider, o.text));
  console.log("ingested");
});
program.command("web").option("--port <n>").action(async (o)=>{
  ensureDbDir(); const db=openDb(getDbPath()); migrate(db);
  const app=buildApp(db);
  const port=o.port?parseInt(o.port): (await readConfig()).port;
  await app.listen({port, host:"127.0.0.1"});
  console.log(`QuotaCap at http://localhost:${port}`);
});
program.command("init").action(async()=>{
  const { readConfig, writeConfig } = await import("../config.js");
  const c=await readConfig(); await writeConfig(c); console.log(JSON.stringify(c,null,2));
});
program.command("daemon").option("--foreground","keep foreground").action(async()=>{
  const { startDaemon } = await import("../daemon.js");
  const { timer } = await startDaemon();
  console.log("QuotaCap daemon started");
  // keep alive until SIGINT/SIGTERM
  process.on("SIGINT", ()=> { clearInterval(timer as any); process.exit(0); });
  process.on("SIGTERM", ()=> { clearInterval(timer as any); process.exit(0); });
});
program.command("mcp").description("start MCP server (stdio over HTTP)").action(async()=>{
  const mod=await import("../mcp/server.js"); console.log(JSON.stringify({tools: mod.tools}));
});
program.parseAsync();
