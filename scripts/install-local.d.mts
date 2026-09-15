// Types for the install-local script (scripts/install-local.mjs).
// Kept beside it so the typechecker can resolve test imports; emits nothing.
import type { execFileSync } from "node:child_process";

export function getTargetName(platform?: string, arch?: string): string;

export function getBinDir(env?: NodeJS.Dict<string> | NodeJS.ProcessEnv): string;

export function installBinary(opts: {
  binDir: string;
  sourceBin: string;
  sourcePty?: string;
}): {
  installedBin: string;
  installedPty?: string;
};

export function reloadServiceIfRunning(
  binPath?: string,
  execFn?: typeof execFileSync,
): boolean;

export function main(): Promise<void> | void;
