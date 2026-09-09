// advise: which provider to use next, over the shared projection. The task
// value validates client-side but never changes the ranking: every valid
// task returns the identical any-basis recommendation.
import type { Command } from "commander";
import { projectRecommendationResponse } from "../advisory/snapshot.js";
import { validateTask } from "../advisory/validate.js";
import { getDbPath, readConfig } from "../config.js";
import { createServiceClient } from "../runtime/client.js";
import { ClientError, OFFLINE_LABEL, emptySnapshot, resolveSnapshot } from "./snapshot-source.js";
import type { ClientCommandDeps, CreateClientOptions } from "./clients.js";

export function registerAdviseCommand(program: Command, deps: ClientCommandDeps): void {
  const createClient = deps.createClient ?? ((o: CreateClientOptions) => createServiceClient(o));
  const openDb = deps.openDb;
  const now = deps.now ?? (() => new Date());
  const exit = deps.exit ?? process.exit;

  program
    .command("advise")
    .description("show which provider to use next (same advice for every task)")
    .option("--json", "machine-readable output")
    .option("--task <t>", "task type: any|heavy|light", "any")
    .action(async (o) => {
      // Task validation precedes any I/O: a bogus task never touches the
      // network, config, or database.
      let task: string;
      try {
        task = validateTask(o.task);
      } catch (e: any) {
        console.error(e?.message ?? String(e));
        exit(1);
        return;
      }
      const t = now();
      const cfg = await readConfig();
      const client = createClient({ port: cfg.port, timeoutMs: 2000 });
      let resolved;
      try {
        resolved = await resolveSnapshot({
          client,
          dbPath: getDbPath(),
          enabledProviders: cfg.enabledProviders,
          now: t,
          openDb,
        });
      } catch (e) {
        if (e instanceof ClientError && e.kind === "no-data") {
          const rec = projectRecommendationResponse(emptySnapshot(t), task);
          if (o.json) console.log(JSON.stringify(rec, null, 2));
          else console.log(`${rec.use}: ${rec.reason}`);
          return;
        }
        console.error(e instanceof Error ? e.message : String(e));
        exit(1);
        return;
      }
      if (resolved.source === "offline") console.error(OFFLINE_LABEL);
      const rec = projectRecommendationResponse(resolved.snapshot, task);
      if (o.json) console.log(JSON.stringify(rec, null, 2));
      else console.log(`${rec.use}: ${rec.reason}`);
    });
}
