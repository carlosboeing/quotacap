// Types for the plain-JS dev runner (scripts/dev.mjs). Kept beside it so the
// typechecker can resolve the test import; emits nothing.
export function isPortInUse(port: number, host?: string, timeoutMs?: number): Promise<boolean>;
export function shouldAutoOpen(argv?: string[], env?: NodeJS.Dict<string>): boolean;
export function main(): Promise<void>;
