// status: the terminal client over the shared projection. Online-first
// through GET /api/state with labeled offline fallback; --json stays a pure
// data contract with the offline label on stderr.
import type { Command } from "commander";
import { projectQuotasResponse } from "../advisory/snapshot.js";
import { getDbPath, readConfig } from "../config.js";
import { renderCompact, renderNarrow, renderWide } from "../format/terminal.js";
import { assertValidSortKey, type SortKey } from "../format/rows.js";
import { createServiceClient } from "../runtime/client.js";
import { ClientError, OFFLINE_LABEL, resolveSnapshot } from "./snapshot-source.js";
import type { ClientCommandDeps, CreateClientOptions } from "./clients.js";

const WIDE_COLUMNS = 100;

export function registerStatusCommand(program: Command, deps: ClientCommandDeps): void {
  const createClient = deps.createClient ?? ((o: CreateClientOptions) => createServiceClient(o));
  const openDb = deps.openDb;
  const resolveWidth =
    deps.resolveWidth ?? (() => ({ columns: process.stdout.columns, tty: !!process.stdout.isTTY }));
  const now = deps.now ?? (() => new Date());
  const exit = deps.exit ?? process.exit;

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
      const client = createClient({ port: cfg.port, timeoutMs });
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
