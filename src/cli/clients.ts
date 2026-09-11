// Client command registration (status, advise, optional ingest). Mirrors B's
// registerRuntimeCommands on the same program with injectable deps so tests
// can fix the clock, width, client, and database opener.
import type { Command } from "commander";
import type { ServiceClient } from "../runtime/client.js";
import { isExperimentalIngestEnabled } from "../config.js";
import { registerStatusCommand } from "./status.js";
import { registerAdviseCommand } from "./advise.js";
import { registerIngestCommand } from "./ingest.js";
import type { SleepFn } from "./takeover.js";

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
  execService?: (args: string[], opts?: Record<string, any>) => Promise<number>;
  isManaged?: () => Promise<boolean>;
  takeoverOpts?: {
    sleep?: SleepFn;
    timeoutMs?: number;
    readToken?: () => string | undefined;
  };
}

export function registerClientCommands(program: Command, deps?: ClientCommandDeps): void {
  registerStatusCommand(program, deps ?? {});
  registerAdviseCommand(program, deps ?? {});
  if (isExperimentalIngestEnabled()) {
    registerIngestCommand(program, deps ?? {});
  }
}
