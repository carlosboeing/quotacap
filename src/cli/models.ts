// CLI: quotacap models [--json] [--provider <id>] [--refresh]
// Waiting command: passes a 30s client timeout for the /api/models endpoint.
import type { Command } from "commander";
import { ensureConfig, getDbPath } from "../config.js";
import { CATALOG_CLIENT_TIMEOUT_MS, ensureCatalogs, catalogProviders } from "../catalog/index.js";
import { openDb, migrate } from "../store/db.js";
import { getAllLatest } from "../store/quotas.js";
import { providerIdentity } from "../advisory/provider-names.js";
import { readToken } from "../runtime/token.js";
import { createServiceClient } from "../runtime/client.js";
import { OFFLINE_LABEL } from "./snapshot-source.js";
import type { ClientCommandDeps, CreateClientOptions } from "./clients.js";

function projectModels(
  catalogs: Map<string, any>,
  quotaMap: Map<string, any>,
  providerNames?: Record<string, string>,
) {
  const out: any[] = [];
  for (const [id, catalog] of catalogs) {
    const identity = providerIdentity(id, providerNames);
    const quota = quotaMap.get(id);
    const leftoverPct = quota?.weeklyPct != null ? Math.round((100 - quota.weeklyPct) * 10) / 10 : null;
    out.push({
      id,
      displayName: identity.displayName,
      harness: identity.harness,
      vendor: identity.vendor,
      leftoverPct,
      resetsAt: quota?.resetsAt ?? null,
      catalog,
    });
  }
  return out;
}

function printTable(list: any[]): void {
  if (!list || list.length === 0) {
    console.log("No model catalog data available.");
    return;
  }
  const rows = list.map((entry: any) => {
    const prov = entry.displayName ?? entry.id;
    const leftover = entry.leftoverPct != null ? `${entry.leftoverPct}%` : "—";
    const status = entry.catalog?.status ?? "unfetched";
    const ids = (entry.catalog?.listed ?? []).map((m: any) => m.id).join(", ") || "(none)";
    return { prov, leftover, status, ids };
  });
  const maxProv = Math.max(8, ...rows.map((r) => r.prov.length));
  const maxLeft = Math.max(8, ...rows.map((r) => r.leftover.length));
  const maxStat = Math.max(6, ...rows.map((r) => r.status.length));
  const header = [
    "PROVIDER".padEnd(maxProv),
    "LEFTOVER".padEnd(maxLeft),
    "STATUS".padEnd(maxStat),
    "MODELS",
  ].join("  ");
  const lines = rows.map((r) =>
    [r.prov.padEnd(maxProv), r.leftover.padEnd(maxLeft), r.status.padEnd(maxStat), r.ids].join("  "),
  );
  console.log([header, ...lines].join("\n"));
}

export function registerModelsCommand(program: Command, deps: ClientCommandDeps = {}): void {
  const createClient = deps.createClient ?? ((o: CreateClientOptions) => createServiceClient(o));
  const openDbFn = deps.openDb ?? openDb;
  const migrateFn = deps.migrate ?? migrate;
  const readTokenFn = deps.takeoverOpts?.readToken ?? readToken;
  const now = deps.now ?? (() => new Date());
  const exit = deps.exit ?? process.exit;

  program
    .command("models")
    .description("list available models per quota bucket")
    .option("--json", "machine-readable output")
    .option("--provider <id>", "filter to a single provider")
    .option("--refresh", "force refresh all catalogs")
    .action(async (o) => {
      const { config: cfg } = await ensureConfig();
      const client = createClient({
        port: cfg.port,
        token: readTokenFn(),
        timeoutMs: CATALOG_CLIENT_TIMEOUT_MS,
      });

      let body: any;
      try {
        const url = o.refresh
          ? (o.provider ? `/api/models/refresh?provider=${encodeURIComponent(o.provider)}` : "/api/models/refresh")
          : (o.provider ? `/api/models?provider=${encodeURIComponent(o.provider)}` : "/api/models");
        const method = o.refresh ? "post" : "get";
        if (method === "post") {
          body = await client.post(url, {});
        } else {
          body = await client.get(url);
        }
      } catch (err: any) {
        // HTTP 4xx errors from a reachable service propagate as errors.
        if (err?.status && err.status >= 400 && err.status < 500) {
          console.error(err?.message ?? String(err));
          exit(1);
          return;
        }

        // Offline fallback when daemon is unreachable:
        // quotacap models in offline mode may spawn fetchers (wait: true in-process).
        console.error(OFFLINE_LABEL);
        try {
          const dbPath = getDbPath();
          const db = openDbFn(dbPath);
          migrateFn(db);
          const providerParam = o.provider;
          const allProviders = catalogProviders(cfg.enabledProviders);
          const known = new Set(allProviders);
          if (providerParam && !known.has(providerParam)) {
            console.error(`unknown provider: ${providerParam}`);
            exit(1);
            return;
          }
          const providers = providerParam ? [providerParam] : allProviders;
          const catalogs = await ensureCatalogs({
            db,
            wait: true,
            refresh: !!o.refresh,
            providers,
            ttlHours: cfg.catalogTtlHours,
            now,
            fetchers: deps.catalogFetchers,
          });
          const quotas = getAllLatest(db);
          const quotaMap = new Map((quotas as any[]).map((q: any) => [q.provider, q]));
          body = projectModels(catalogs, quotaMap, cfg.providerNames);
        } catch (offlineErr: any) {
          console.error(offlineErr?.message ?? String(offlineErr));
          exit(1);
          return;
        }
      }

      const list = Array.isArray(body) ? body : (body?.models ?? body?.results ?? []);
      if (o.json) {
        console.log(JSON.stringify(body, null, 2));
      } else {
        printTable(list);
      }
    });
}
