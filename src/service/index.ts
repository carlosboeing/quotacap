// Platform dispatch for service commands: macOS goes to launchd, Linux to
// systemd, everything else gets foreground guidance and no artifacts.
import {
  install as installMacos,
  uninstall as uninstallMacos,
  start as startMacos,
  stop as stopMacos,
  restart as restartMacos,
  status as statusMacos,
  collectStatus as collectStatusMacos,
  foregroundGuidance,
  type ServiceDeps as MacosDeps,
} from "./macos.js";
import {
  install as installSystemd,
  uninstall as uninstallSystemd,
  start as startSystemd,
  stop as stopSystemd,
  restart as restartSystemd,
  status as statusSystemd,
  collectStatus as collectStatusSystemd,
  type SystemdDeps,
} from "./systemd.js";

export {
  buildPlist,
  parsePlistIdentity,
  resolveServiceExec,
  resolveProviderPaths,
  formatMissingProviders,
  buildChildPath,
  defaultWaitReady,
  defaultWhich,
  install,
  uninstall,
  start,
  stop,
  restart,
  status,
  collectStatus,
  formatStatus,
  foregroundGuidance,
  SERVICE_LABEL,
  PROVIDER_BINS,
  type ServiceStatus,
} from "./macos.js";

export {
  buildUnit,
  isOurUnit,
  SERVICE_UNIT,
  type SystemdDeps,
} from "./systemd.js";

// Merged deps: every field is optional, so one object satisfies both backends.
export type ServiceDeps = MacosDeps & SystemdDeps;

export function serviceSupported(platform: string = process.platform): boolean {
  return platform === "darwin" || platform === "linux";
}

// Installed means a registration artifact exists, whether or not the
// supervisor currently has it loaded. The web launcher uses this to decide
// between `service start` and a foreground fallback.
export async function isServiceInstalled(deps: ServiceDeps = {}): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  try {
    if (platform === "darwin") {
      return (await collectStatusMacos(deps)).registration.installed;
    }
    if (platform === "linux") {
      return (await collectStatusSystemd(deps)).registration.installed;
    }
  } catch {
    return false;
  }
  return false;
}

// Managed means a registered job that the supervisor currently has loaded.
// Takeover uses this to choose between `service restart` and /api/restart.
export async function isServiceManaged(deps: ServiceDeps = {}): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  try {
    if (platform === "darwin") {
      const st = await collectStatusMacos(deps);
      return st.registration.installed && st.registration.loaded;
    }
    if (platform === "linux") {
      const st = await collectStatusSystemd(deps);
      return st.registration.installed && st.registration.loaded;
    }
  } catch {
    return false;
  }
  return false;
}

export async function runServiceCommand(
  args: string[],
  opts: Record<string, any> = {},
  deps: ServiceDeps = {},
): Promise<number> {
  const [verb] = args;
  const platform = deps.platform ?? process.platform;
  const print = deps.print ?? console.log;
  const error = deps.error ?? console.error;
  if (!serviceSupported(platform)) {
    print(foregroundGuidance(verb ?? "service", platform));
    return 2;
  }
  const backend =
    platform === "darwin"
      ? {
        install: installMacos,
        uninstall: uninstallMacos,
        start: startMacos,
        stop: stopMacos,
        restart: restartMacos,
        status: statusMacos,
      }
      : {
        install: installSystemd,
        uninstall: uninstallSystemd,
        start: startSystemd,
        stop: stopSystemd,
        restart: restartSystemd,
        status: statusSystemd,
      };
  try {
    switch (verb) {
      case "install":
        // Internal: the post-update refresh passes the target version so
        // install compares and records it instead of the old in-process
        // VERSION, plus quiet so a good update prints its own three lines
        // instead of the install chatter. The `service install` CLI never
        // sets opts.version or opts.quiet.
        await backend.install({
          ...deps,
          version: opts.version ?? deps.version,
          quiet: opts.quiet ?? deps.quiet,
        });
        break;
      case "uninstall":
        await backend.uninstall(deps);
        break;
      case "start":
        await backend.start(deps);
        break;
      case "stop":
        await backend.stop(deps);
        break;
      case "restart":
        await backend.restart(deps);
        break;
      case "status":
        await backend.status(deps, { json: !!opts.json });
        break;
      default:
        error(`unknown service command: ${verb ?? "(none)"}`);
        return 2;
    }
    return 0;
  } catch (e) {
    error(`service ${verb} failed: ${(e as Error)?.message ?? String(e)}`);
    return 1;
  }
}
