// ingest: service-required manual usage submission. Registered only when
// experimental ingest is on. The running service validates and stores; this
// command never writes SQLite itself and never falls back. Provider IDs pass
// through unvalidated (forecast-side concern).
import type { Command } from "commander";
import { readConfig } from "../config.js";
import { ServiceError, ServiceUnavailable, createServiceClient } from "../runtime/client.js";
import { readToken } from "../runtime/token.js";
import { toClientError } from "./snapshot-source.js";
import type { ClientCommandDeps, CreateClientOptions } from "./clients.js";

export function registerIngestCommand(program: Command, deps: ClientCommandDeps): void {
  const createClient = deps.createClient ?? ((o: CreateClientOptions) => createServiceClient(o));
  const exit = deps.exit ?? process.exit;

  program
    .command("ingest")
    .description("submit manual usage text to the running service")
    .requiredOption("--provider <p>", "provider id (passed through to the service)")
    .requiredOption("--text <t>", "usage text to parse")
    .action(async (o) => {
      const cfg = await readConfig();
      const client = createClient({ port: cfg.port, token: readToken(), timeoutMs: 5000 });
      try {
        await client.post("/api/ingest", { provider: o.provider, text: o.text });
      } catch (e) {
        if (e instanceof ServiceUnavailable || e instanceof ServiceError) {
          console.error(toClientError(e, "ingest").message);
        } else {
          console.error(e instanceof Error ? e.message : String(e));
        }
        exit(1);
        return;
      }
      console.log("ingested");
    });
}
