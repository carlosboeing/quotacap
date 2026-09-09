import { useEffect, useState } from "react";

export type Route = "/" | "/setup";

/**
 * Route guard. /setup renders only on the first-run signal (no stored rows);
 * completing onboarding — or any stored row appearing — routes to /.
 * Unknown paths route to /. Clean history routing: the server serves the
 * SPA fallback for /setup.
 */
export function routeFor(_path: string, isFirstRun: boolean): Route {
  return isFirstRun ? "/setup" : "/";
}

export function currentPath(): string {
  try {
    return window.location.pathname || "/";
  } catch {
    return "/";
  }
}

export function navigate(path: Route): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): string {
  const [path, setPath] = useState<string>(() => currentPath());
  useEffect(() => {
    const onPop = () => setPath(currentPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return path;
}
