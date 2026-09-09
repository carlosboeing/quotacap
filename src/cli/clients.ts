// Client command registration (status, advise, ingest). Mirrors B's
// registerRuntimeCommands on the same program with injectable deps so tests
// can fix the clock, width, client, and database opener.
import type { Command } from "commander";
import type { ServiceClient } from "../runtime/client.js";
import { registerStatusCommand } from "./status.js";
import { registerAdviseCommand } from "./advise.js";

export interface CreateClientOptions {
  port: number;
  token?: string;
  timeoutMs: number;
}

export interface ClientCommandDeps {
  createClient?: (opts: CreateClientOptions) => ServiceClient;
  openDb?: (dbPath: string) => any;
  resolveWidth?: () => { columns: number | undefined; tty: boolean };
  now?: () => Date;
  exit?: (code: number) => void;
}

export function registerClientCommands(program: Command, deps?: ClientCommandDeps): void {
  registerStatusCommand(program, deps ?? {});
  registerAdviseCommand(program, deps ?? {});
}
