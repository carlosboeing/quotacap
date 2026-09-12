import type { StateSnapshot } from "../advisory/types.js";

export function renderIssues(snapshot: StateSnapshot, ascii: boolean): string {
  const issues = snapshot.providers.filter((p) => p.enabled && p.lastAttempt?.success === false);
  const marker = ascii ? "-" : "•";
  const lines = issues.flatMap((p) => {
    const attempt = p.lastAttempt!;
    const summary =
      attempt.summary ??
      (attempt.failureCategory
        ? `provider failed (${attempt.failureCategory})`
        : "provider failed");
    return [
      `${marker} ${p.id}: ${summary}`,
      ...(attempt.action ? [`  Action: ${attempt.action}`] : []),
      `  Detail: ${attempt.errorDetail ?? attempt.error ?? "No diagnostic detail was recorded for this attempt."}`,
    ];
  });
  return lines.length ? ["Adapter issues:", ...lines].join("\n") : "";
}
