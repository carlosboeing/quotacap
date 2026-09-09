#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { VERSION } from "../version.js";
import { openDb, migrate } from "../store/db.js";
import { getDbPath } from "../config.js";
import { registerRuntimeCommands } from "./runtime.js";
import { registerClientCommands } from "./clients.js";
function ensureDbDir(){ try{ const d=path.dirname(getDbPath()); fs.mkdirSync(d, {recursive:true, mode:0o700}); try{ fs.chmodSync(d,0o700);}catch{} }catch{} }
const program = new Command();
program.name("quotacap").version(VERSION);
program.command("version").action(()=> console.log(VERSION));
program.command("ingest").requiredOption("--provider <p>").requiredOption("--text <t>").action(async (o)=>{
  ensureDbDir(); const db=openDb(getDbPath()); migrate(db);
  const { parseManualUsage } = await import("../adapters/manual.js");
  const { upsertQuota } = await import("../store/quotas.js");
  upsertQuota(db, parseManualUsage(o.provider, o.text));
  console.log("ingested");
});
program.command("init").action(async()=>{
  const { readConfig, writeConfig } = await import("../config.js");
  const c=await readConfig(); await writeConfig(c); console.log(JSON.stringify(c,null,2));
});
program.command("mcp").description("start MCP server (stdio over HTTP)").action(async()=>{
  const mod=await import("../mcp/server.js");
  // if run with --help, commander handles it before action; this is the real server
  await mod.runMcpServer();
});
registerRuntimeCommands(program);
registerClientCommands(program);
program.parseAsync();
