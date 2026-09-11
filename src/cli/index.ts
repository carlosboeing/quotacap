#!/usr/bin/env node
import { Command } from "commander";
import { VERSION } from "../version.js";
import { launchWeb, registerRuntimeCommands } from "./runtime.js";
import { registerClientCommands } from "./clients.js";
import { registerInitCommand } from "./init.js";
import { registerUpdateCommand } from "./update.js";
const program = new Command();
program.name("quotacap").version(VERSION);
program.command("version").action(()=> console.log(VERSION));
registerInitCommand(program);
program.command("mcp").description("start MCP server (stdio over HTTP)").action(async()=>{
  const mod=await import("../mcp/server.js");
  // if run with --help, commander handles it before action; this is the real server
  await mod.runMcpServer();
});
registerRuntimeCommands(program);
registerClientCommands(program);
registerUpdateCommand(program);
// Bare `quotacap` with no arguments at all opens the dashboard through the
// shared launcher; flags and subcommands keep Commander behavior.
if (process.argv.length === 2) {
  launchWeb({});
} else {
  program.parseAsync();
}
