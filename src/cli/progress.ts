// Shared progress helper for multi-second CLI operations.
// Strictly writes to stderr with a consistent lowercase phrasing ending in '…'.
// Automatically suppressed under --json, quiet mode, and non-interactive (non-TTY) runs.

export interface ProgressOptions {
  /** Suppress output when machine-readable JSON is requested. */
  json?: boolean;
  /** Explicitly silence progress (e.g. quiet mode). */
  quiet?: boolean;
  /** Whether the output stream is interactive. Defaults to process.stderr.isTTY. */
  isTTY?: boolean;
  /** Custom writer for stderr (defaults to console.error). */
  stderr?: (message: string) => void;
}

export type PhaseFn = (message: string, opts?: ProgressOptions) => void;

/**
 * Format a progress phase string ensuring consistent trailing ellipsis without duplication.
 */
export function formatPhase(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) return "";
  if (trimmed.endsWith("...")) {
    return `${trimmed.slice(0, -3)}…`;
  }
  if (trimmed.endsWith("…")) {
    return trimmed;
  }
  return `${trimmed}…`;
}

/**
 * Determine whether progress messages should be printed given the options.
 */
export function shouldEmitProgress(opts: ProgressOptions = {}): boolean {
  if (opts.json || opts.quiet) return false;
  if (opts.isTTY !== undefined) return Boolean(opts.isTTY);
  return Boolean(process.stderr.isTTY);
}

/**
 * Emit a progress phase message strictly to stderr if interactive and non-json.
 */
export function phase(message: string, opts: ProgressOptions = {}): void {
  const formatted = formatPhase(message);
  if (!formatted) return;
  if (!shouldEmitProgress(opts)) return;
  const write = opts.stderr ?? console.error;
  write(formatted);
}

/**
 * Await work, calling emit only if it is still pending after graceMs, so an
 * already-settled fast path stays silent.
 */
export async function phaseIfSlow<T>(
  work: Promise<T>,
  emit: () => void,
  graceMs = 250,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<"slow">((r) => {
    timer = setTimeout(() => r("slow"), graceMs);
  });
  try {
    const first = await Promise.race([
      work.then(
        () => "done" as const,
        () => "done" as const,
      ),
      slow,
    ]);
    if (first === "slow") emit();
    return await work;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create a phase reporter with pre-bound default options.
 */
export function createPhase(
  baseOpts: ProgressOptions = {},
): (message: string, overrideOpts?: ProgressOptions) => void {
  return (message: string, overrideOpts: ProgressOptions = {}) => {
    phase(message, { ...baseOpts, ...overrideOpts });
  };
}
