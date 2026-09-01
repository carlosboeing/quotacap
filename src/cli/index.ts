#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { VERSION } from "../version.js";
import { buildApp } from "../http/server.js";
import { openDb, migrate } from "../store/db.js";
import { getDbPath, readConfig } from "../config.js";
function ensureDbDir(){ try{ const d=path.dirname(getDbPath()); fs.mkdirSync(d, {recursive:true, mode:0o700}); try{ fs.chmodSync(d,0o700);}catch{} }catch{} }
const program = new Command();
program.name("quotacap").version(VERSION);
program.command("version").action(()=> console.log(VERSION));
program.command("status").option("--json","json").action(async (opts)=>{
  ensureDbDir(); const db=openDb(getDbPath()); migrate(db);
  const { getAllLatest, getBurnRates } = await import("../store/quotas.js");
  const quotas=getAllLatest(db);
  if(opts.json) console.log(JSON.stringify(quotas,null,2));
  else {
    const { recommend } = await import("../advisory/engine.js");
    const { renderQuotasTable } = await import("../format/table.js");
    const rec = quotas.length ? recommend(quotas, "any", getBurnRates(db)) : null;
    console.log(rec ? renderQuotasTable(quotas, rec.advisories) : "no quotas yet — run quotacap ingest or start the daemon");
  }
});
program.command("advise").option("--json","json").option("--task <t>","task","any").action(async (opts)=>{
  ensureDbDir(); const db=openDb(getDbPath()); migrate(db);
  try {
    const r=await fetch(`http://localhost:${(await readConfig()).port}/api/recommendation?task=${opts.task}`, {signal: AbortSignal.timeout(2000)});
    const j=await r.json(); console.log(opts.json? JSON.stringify(j,null,2) : `${j.use}: ${j.reason}`);
  } catch {
    const { recommend } = await import("../advisory/engine.js");
    const { getAllLatest, getBurnRates } = await import("../store/quotas.js");
    const quotas=getAllLatest(db);
    if(!quotas.length){ console.log(opts.json? JSON.stringify({use:"none",reason:"no quotas yet"},null,2) : "none: no quotas yet"); return; }
    const rec=recommend(quotas, opts.task, getBurnRates(db));
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
  const { isDaemonRunning, startDaemon, ensureDaemonToken } = await import("../daemon.js");
  if (!isDaemonRunning()) {
    const started = await startDaemon();
    if (!started.alreadyRunning) console.log("daemon started (auto)");
  }
  const token = ensureDaemonToken();
  const app=buildApp(db, { token });
  const port=o.port?parseInt(o.port): (await readConfig()).port;
  await app.listen({port, host:"127.0.0.1"});
  console.log(`QuotaCap at http://localhost:${port}`);
});
program.command("init").action(async()=>{
  const { readConfig, writeConfig } = await import("../config.js");
  const c=await readConfig(); await writeConfig(c); console.log(JSON.stringify(c,null,2));
});
program.command("daemon").option("--foreground","keep foreground (default: true)").action(async(o)=>{
  const { startDaemon } = await import("../daemon.js");
  const started = await startDaemon();
  if (started.alreadyRunning) {
    console.log(`daemon already running (pid ${started.alreadyRunning})`);
    return;
  }
  console.log("QuotaCap daemon started" + (o.foreground !== false ? " (foreground)" : ""));
  // keep alive until SIGINT/SIGTERM — timer is ref'd so event loop stays alive
  process.on("SIGINT", ()=> { started.stop(); process.exit(0); });
  process.on("SIGTERM", ()=> { started.stop(); process.exit(0); });
  // explicitly keep process alive if interval was somehow unref'd elsewhere
  if ((started.timer as any).ref) (started.timer as any).ref();
});
program.command("mcp").description("start MCP server (stdio over HTTP)").action(async()=>{
  const mod=await import("../mcp/server.js");
  // if run with --help, commander handles it before action; this is the real server
  await mod.runMcpServer();
});
program.parseAsync();
