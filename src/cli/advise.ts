// advise: which provider to use next, over the shared projection. The task
// value validates client-side but never changes the ranking: every valid
// task returns the identical any-basis recommendation.
import type { Command } from "commander";
import { projectRecommendationResponse } from "../advisory/snapshot.js";
import { validateTask } from "../advisory/validate.js";
import { ensureConfig, getDbPath } from "../config.js";
import { createServiceClient } from "../runtime/client.js";
import { VERSION } from "../version.js";
import { isServiceManaged, runServiceCommand } from "../service/index.js";
import {
  detectChannel,
  printUpdateFooter,
  readUpdateCache,
  refreshUpdateCache,
  updateFooter,
  type UpdateCache,
} from "../runtime/updates.js";
import { ClientError, OFFLINE_LABEL, emptySnapshot, offlineOnlyClient, resolveSnapshot } from "./snapshot-source.js";
import {
  checkSkew,
  execSkewWarning,
  olderCliWarning,
  takeoverManaged,
  unmanagedSkewWarning,
} from "./takeover.js";
import type { ClientCommandDeps, CreateClientOptions } from "./clients.js";

export function registerAdviseCommand(program: Command, deps: ClientCommandDeps): void {
  const createClient = deps.createClient ?? ((o: CreateClientOptions) => createServiceClient(o));
  const openDb = deps.openDb;
  const now = deps.now ?? (() => new Date());
  const exit = deps.exit ?? process.exit;
  const execService =
    deps.execService ?? ((args, o) => runServiceCommand(args, o ?? {}, {}));
  const isManaged = deps.isManaged ?? isServiceManaged;
  const takeoverOpts = deps.takeoverOpts ?? {};
  const checkUpdates =
    deps.checkUpdates ??
    (() => refreshUpdateCache({ channel: detectChannel(), current: VERSION }));

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
      const { config: cfg } = await ensureConfig();
      let client = createClient({ port: cfg.port, timeoutMs: 2000 });
      // Skew pre-check mirrors status: warn on exec-only and older-CLI skew,
      // take the managed path when newer, and never spawn a foreground daemon
      // here — unmanaged skew serves the stored snapshot instead of failing.
      let health: any = null;
      try {
        health = await client.get("/health");
      } catch {
        health = null;
      }
      if (health?.ok) {
        const skew = checkSkew(health, VERSION, process.execPath);
        if (skew === "exec-only") {
          console.error(execSkewWarning(String(health.exec)));
        } else if (skew === "cli-older") {
          console.error(olderCliWarning(String(health.version ?? "unknown")));
        } else if (skew === "cli-newer") {
          const managed = await isManaged().catch(() => false);
          if (managed) {
            try {
              const r = await takeoverManaged({
                port: cfg.port,
                health,
                createClient,
                execService,
                ...takeoverOpts,
              });
              console.error(r.message);
            } catch (e) {
              console.error(e instanceof Error ? e.message : String(e));
              exit(1);
              return;
            }
          } else {
            console.error(unmanagedSkewWarning(String(health.version ?? "unknown")));
            client = offlineOnlyClient();
          }
        }
      }
      // Passive daily update signal: opportunistically refresh the shared
      // cache, then surface staleness as a stderr footer (never in --json).
      let updateCache: UpdateCache | null = null;
      try {
        updateCache = await checkUpdates();
      } catch {
        updateCache = readUpdateCache();
      }
      const footer = updateFooter(VERSION, updateCache?.latest ?? null);
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
          else {
            console.log(`${rec.use}: ${rec.reason}`);
            printUpdateFooter(o, footer);
          }
          return;
        }
        console.error(e instanceof Error ? e.message : String(e));
        exit(1);
        return;
      }
      if (resolved.source === "offline") console.error(OFFLINE_LABEL);
      const rec = projectRecommendationResponse(resolved.snapshot, task);
      if (o.json) console.log(JSON.stringify(rec, null, 2));
      else {
        console.log(`${rec.use}: ${rec.reason}`);
        printUpdateFooter(o, footer);
      }
    });
}
