const TASKS = new Set(["any", "heavy", "light"]);

export function validateTask(t: unknown): string {
  if (typeof t === "string" && TASKS.has(t)) return t;
  throw new Error("invalid-argument: task must be one of any|heavy|light");
}

export function validateForecastProvider(
  id: unknown,
  ctx: { registered: string[]; storedIds: string[] }
): string {
  if (typeof id !== "string" || !id) throw new Error("invalid-argument: provider required");
  const known = new Set([...ctx.registered, ...ctx.storedIds]);
  if (!known.has(id)) throw new Error(`unknown-provider ${id}`);
  // The agy adapter emits agy and agy:3p as independent rows, so a stored
  // parent gives no reading for a group. Every id must have its own.
  if (!ctx.storedIds.includes(id)) throw new Error(`missing-reading ${id}`);
  return id;
}
