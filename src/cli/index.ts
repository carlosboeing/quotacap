#!/usr/bin/env node
import { Command } from "commander";
import { VERSION } from "../version.js";
import { registerRuntimeCommands } from "./runtime.js";
import { registerClientCommands } from "./clients.js";
const program = new Command();
program.name("quotacap").version(VERSION);
program.command("version").action(()=> console.log(VERSION));
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
