// status: the terminal client over the shared projection. Online-first
// through GET /api/state with labeled offline fallback; --json stays a pure
// data contract with the offline label on stderr.
import type { Command } from "commander";
import { projectQuotasResponse } from "../advisory/snapshot.js";
import { getDbPath, readConfig } from "../config.js";
import { renderCompact, renderNarrow, renderWide } from "../format/terminal.js";
import { assertValidSortKey, type SortKey } from "../format/rows.js";
import { createServiceClient } from "../runtime/client.js";
import { VERSION } from "../version.js";
import { isServiceManaged, runServiceCommand } from "../service/index.js";
import { ClientError, OFFLINE_LABEL, offlineOnlyClient, resolveSnapshot } from "./snapshot-source.js";
import {
  checkSkew,
  execSkewWarning,
  olderCliWarning,
  takeoverManaged,
  unmanagedSkewWarning,
} from "./takeover.js";
import type { ClientCommandDeps, CreateClientOptions } from "./clients.js";

const WIDE_COLUMNS = 100;

export function registerStatusCommand(program: Command, deps: ClientCommandDeps): void {
  const createClient = deps.createClient ?? ((o: CreateClientOptions) => createServiceClient(o));
  const openDb = deps.openDb;
  const resolveWidth =
    deps.resolveWidth ?? (() => ({ columns: process.stdout.columns, tty: !!process.stdout.isTTY }));
  const now = deps.now ?? (() => new Date());
  const exit = deps.exit ?? process.exit;
  const execService =
    deps.execService ?? ((args, o) => runServiceCommand(args, o ?? {}, {}));
  const isManaged = deps.isManaged ?? isServiceManaged;
  const takeoverOpts = deps.takeoverOpts ?? {};

  program
    .command("status")
    .description("show quota status (service when reachable, stored readings otherwise)")
    .option("--json", "machine-readable output")
    .option("--compact", "one-line statusline")
    .option("--ascii", "ASCII glyphs without color")
    .option("--sort <key>", "row order: recommended|reset-asc|reset-desc|used-desc|used-asc", "recommended")
    .action(async (o) => {
      // Flag validation precedes any I/O: an invalid sort never touches the
      // network, config, or database.
      try {
        assertValidSortKey(o.sort);
      } catch (e: any) {
        console.error(e?.message ?? String(e));
        exit(1);
        return;
      }
      const sort = o.sort as SortKey;
      const t = now();
      const compact = !!o.compact;
      const timeoutMs = compact ? 1000 : 2000;
      const cfg = await readConfig();
      let client = createClient({ port: cfg.port, timeoutMs });
      // Skew pre-check: warn on exec-only and older-CLI skew, take the
      // managed path when newer, and never spawn a foreground daemon here —
      // unmanaged skew serves the stored snapshot instead of failing.
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
          if (o.json) {
            console.log("[]");
            return;
          }
          if (compact) {
            console.log("(use: none)");
            return;
          }
          console.log(e.message);
          return;
        }
        console.error(e instanceof Error ? e.message : String(e));
        exit(1);
        return;
      }
      if (resolved.source === "offline") console.error(OFFLINE_LABEL);
      const { snapshot } = resolved;
      if (o.json) {
        console.log(JSON.stringify(projectQuotasResponse(snapshot), null, 2));
        return;
      }
      if (compact) {
        console.log(renderCompact(snapshot, t));
        return;
      }
      const { columns, tty } = resolveWidth();
      const ascii = !!o.ascii;
      const color = tty && !ascii && !("NO_COLOR" in process.env);
      const wide = !tty || (columns ?? 80) >= WIDE_COLUMNS;
      console.log(
        wide
          ? renderWide(snapshot, { now: t, ascii, color, sort })
          : renderNarrow(snapshot, { now: t, ascii, color, sort }),
      );
    });
}
