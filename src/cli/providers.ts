// CLI command group for provider display names and user overrides.
import type { Command } from "commander";
import { adapters } from "../adapters/index.js";
import { OPENCODE_GO_CONSENT_NOTICE } from "../adapters/opencode-go.js";
import { readConfig, resetAllProviderNameOverrides, setProviderEnabled, setProviderNameOverride } from "../config.js";
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
          try {
            await setProviderNameOverride(id, validatedName);
          } catch (err: any) {
            console.error(err?.message ?? String(err));
            exit(1);
            return;
          }
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
            try {
              await resetAllProviderNameOverrides();
            } catch (err: any) {
              console.error(err?.message ?? String(err));
              exit(1);
              return;
            }
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
            try {
              await setProviderNameOverride(id, null);
            } catch (err: any) {
              console.error(err?.message ?? String(err));
              exit(1);
              return;
            }
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

  providers
    .command("enable <id>")
    .description("enable a provider (OpenCode Go requires explicit consent)")
    .option("--yes", "skip the interactive consent prompt (scripts)")
    .action(async (id: string, opts: { yes?: boolean }) => {
      if (typeof id !== "string" || !id || !Object.hasOwn(adapters, id) || id === "manual") {
        console.error(`error: unknown provider id: ${id}`);
        exit(1);
        return;
      }
      if (id === "opencode-go") {
        console.log("**Enable OpenCode Go?**\n");
        console.log(OPENCODE_GO_CONSENT_NOTICE + "\n");
        if (!opts.yes) {
          if (!process.stdin.isTTY) {
            console.error("refusing to enable opencode-go without interactive consent — read the notice above and re-run with --yes");
            exit(1);
            return;
          }
          const readline = (await import("node:readline/promises")).default;
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          try {
            const answer = (await rl.question("Proceed? [y/N] ")).trim().toLowerCase();
            if (answer !== "y" && answer !== "yes") {
              console.log("not enabled");
              return;
            }
          } catch {
            console.log("not enabled");
            return;
          } finally {
            rl.close();
          }
        }
      }
      const cfg = await readConfig();
      const client = createClient({ port: cfg.port, token: readToken(), timeoutMs: 2000 });
      try {
        await client.post(`/api/providers/${encodeURIComponent(id)}/enabled`, {
          enabled: true,
          ...(id === "opencode-go" ? { consent: true } : {}),
        });
      } catch (e) {
        if (e instanceof ServiceUnavailable || (e instanceof ServiceError && e.status === 404)) {
          try {
            await setProviderEnabled(id, true);
          } catch (err: any) {
            console.error(err?.message ?? String(err));
            exit(1);
            return;
          }
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
      console.log(`enabled ${id} — restart quotacap daemon to apply`);
    });

  providers
    .command("disable <id>")
    .description("disable a provider and stop polling it")
    .action(async (id: string) => {
      if (typeof id !== "string" || !id || !Object.hasOwn(adapters, id) || id === "manual") {
        console.error(`error: unknown provider id: ${id}`);
        exit(1);
        return;
      }
      const cfg = await readConfig();
      const client = createClient({ port: cfg.port, token: readToken(), timeoutMs: 2000 });
      try {
        await client.post(`/api/providers/${encodeURIComponent(id)}/enabled`, { enabled: false });
      } catch (e) {
        if (e instanceof ServiceUnavailable || (e instanceof ServiceError && e.status === 404)) {
          try {
            await setProviderEnabled(id, false);
          } catch (err: any) {
            console.error(err?.message ?? String(err));
            exit(1);
            return;
          }
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
      console.log(`disabled ${id} — restart quotacap daemon to apply`);
    });
}

