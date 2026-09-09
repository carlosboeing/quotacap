// Platform dispatch for service commands. Only macOS is supported; other
// platforms get foreground guidance and no artifacts.
import {
  install,
  uninstall,
  start,
  stop,
  restart,
  foregroundGuidance,
  serviceSupported as macosSupported,
  type ServiceDeps,
} from "./macos.js";

export {
  buildPlist,
  parsePlistIdentity,
  resolveServiceExec,
  resolveProviderPaths,
  formatMissingProviders,
  buildChildPath,
  install,
  uninstall,
  start,
  stop,
  restart,
  foregroundGuidance,
  SERVICE_LABEL,
  PROVIDER_BINS,
  type ServiceDeps,
} from "./macos.js";

export function serviceSupported(platform: string = process.platform): boolean {
  return macosSupported(platform);
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
  try {
    switch (verb) {
      case "install":
        await install(deps);
        break;
      case "uninstall":
        await uninstall(deps);
        break;
      case "start":
        await start(deps);
        break;
      case "stop":
        await stop(deps);
        break;
      case "restart":
        await restart(deps);
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
