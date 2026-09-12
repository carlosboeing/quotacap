// CLI command group for provider display names and user overrides.
import type { Command } from "commander";
import { readConfig, resetAllProviderNameOverrides, setProviderNameOverride } from "../config.js";
import { REGISTRY, providerIdentity } from "../advisory/provider-names.js";
import { validateDisplayName } from "../advisory/validation.js";
import { ServiceError, ServiceUnavailable, createServiceClient } from "../runtime/client.js";
import { readToken } from "../runtime/token.js";
import type { ClientCommandDeps, CreateClientOptions } from "./clients.js";

export function registerProvidersCommand(program: Command, deps: ClientCommandDeps = {}): void {
  const createClient = deps.createClient ?? ((o: CreateClientOptions) => createServiceClient(o));
  const exit = deps.exit ?? process.exit;

  const providers = program
    .command("providers")
    .description("manage provider display names and user overrides");

  providers
    .command("list")
    .description("list provider ids, built-in names, and effective names")
    .action(async () => {
      const cfg = await readConfig();
      const allIds = Array.from(
        new Set([...REGISTRY.keys(), ...Object.keys(cfg.providerNames ?? {})]),
      ).sort((a, b) => a.localeCompare(b));

      const rows = allIds.map((id) => {
        const identity = providerIdentity(id, cfg.providerNames);
        return {
          id,
          builtin: identity.builtinName ?? "—",
          effective: identity.displayName,
        };
      });

      const maxId = Math.max(2, ...rows.map((r) => r.id.length));
      const maxBuiltin = Math.max(8, ...rows.map((r) => r.builtin.length));
      const maxEffective = Math.max(9, ...rows.map((r) => r.effective.length));

      const header = [
        "ID".padEnd(maxId),
        "BUILT-IN".padEnd(maxBuiltin),
        "EFFECTIVE".padEnd(maxEffective),
      ].join("  ");

      const lines = rows.map((r) =>
        [r.id.padEnd(maxId), r.builtin.padEnd(maxBuiltin), r.effective.padEnd(maxEffective)].join(
          "  ",
        ),
      );

      console.log([header, ...lines].join("\n"));
    });

  providers
    .command("rename <id> <name>")
    .description("set a custom display name override for a provider")
    .action(async (id: string, name: string) => {
      let validatedName: string;
      try {
        validatedName = validateDisplayName(name);
      } catch (e: any) {
        console.error(e?.message ?? String(e));
        exit(1);
        return;
      }

      const cfg = await readConfig();
      const client = createClient({ port: cfg.port, token: readToken(), timeoutMs: 2000 });

      try {
        if (!client.patch) throw new ServiceUnavailable("patch not supported on client");
        await client.patch(`/api/providers/${encodeURIComponent(id)}`, {
          displayName: validatedName,
        });
      } catch (e) {
        if (e instanceof ServiceUnavailable || (e instanceof ServiceError && e.status === 404)) {
          // Daemon is offline or older version without PATCH /api/providers; update config directly
          await setProviderNameOverride(id, validatedName);
          if (e instanceof ServiceError && e.status === 404) {
            console.warn("note: daemon returned 404 (version skew); updated local config, restart quotacap daemon to apply");
          }
        } else if (e instanceof ServiceError) {
          console.error(e.message);
          exit(1);
          return;
        } else {
          console.error(e instanceof Error ? e.message : String(e));
          exit(1);
          return;
        }
      }

      console.log(`renamed ${id} to "${validatedName}"`);
    });

  providers
    .command("reset [id]")
    .description("clear custom display name override for a provider or all providers")
    .option("--all", "clear all provider display name overrides")
    .action(async (id: string | undefined, opts: { all?: boolean }) => {
      if (!id && !opts.all) {
        console.error("error: specify a provider id or --all");
        exit(1);
        return;
      }

      const cfg = await readConfig();
      const client = createClient({ port: cfg.port, token: readToken(), timeoutMs: 2000 });

      if (opts.all) {
        try {
          if (!client.patch) throw new ServiceUnavailable("patch not supported on client");
          const overriddenIds = Object.keys(cfg.providerNames ?? {});
          for (const oid of overriddenIds) {
            await client.patch(`/api/providers/${encodeURIComponent(oid)}`, {
              displayName: null,
            });
          }
        } catch (e) {
          if (e instanceof ServiceUnavailable || (e instanceof ServiceError && e.status === 404)) {
            await resetAllProviderNameOverrides();
            if (e instanceof ServiceError && e.status === 404) {
              console.warn("note: daemon returned 404 (version skew); updated local config, restart quotacap daemon to apply");
            }
          } else if (e instanceof ServiceError) {
            console.error(e.message);
            exit(1);
            return;
          } else {
            console.error(String(e));
            exit(1);
            return;
          }
        }
        console.log("reset all provider display name overrides");
        return;
      }

      if (id) {
        try {
          if (!client.patch) throw new ServiceUnavailable("patch not supported on client");
          await client.patch(`/api/providers/${encodeURIComponent(id)}`, {
            displayName: null,
          });
        } catch (e) {
          if (e instanceof ServiceUnavailable || (e instanceof ServiceError && e.status === 404)) {
            await setProviderNameOverride(id, null);
            if (e instanceof ServiceError && e.status === 404) {
              console.warn("note: daemon returned 404 (version skew); updated local config, restart quotacap daemon to apply");
            }
          } else if (e instanceof ServiceError) {
            console.error(e.message);
            exit(1);
            return;
          } else {
            console.error(e instanceof Error ? e.message : String(e));
            exit(1);
            return;
          }
        }
        console.log(`reset display name for ${id}`);
      }
    });
}

