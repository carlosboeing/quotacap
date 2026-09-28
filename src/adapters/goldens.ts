// Golden CLI-version coverage: every entry has a redacted real transcript at
// tests/fixtures/golden/<provider>-<version>/transcript.txt plus expected.json,
// exercised by tests/adapters/goldens.test.ts. When a vendor CLI updates,
// capture its usage output, redact identifiers, add the fixture, and extend
// the list. Failure bundles record whether the failing CLI was covered, so
// an uncovered version is the first suspect when parsing breaks.
export const GOLDEN_CLI_VERSIONS: Record<string, string[]> = {
  claude: ["2.1.283"],
  codex: ["0.157.1"],
  grok: ["1.0.41"],
};

export function goldenFixtureDir(provider: string, version: string): string {
  return `${provider}-${version}`;
}

/** Substring match: "grok 1.0.41 (4220f3b…)" covers "1.0.41". */
export function isGoldenCovered(provider: string, cliVersion: string | null | undefined): boolean {
  if (!cliVersion) return false;
  return (GOLDEN_CLI_VERSIONS[provider] ?? []).some((v) => cliVersion.includes(v));
}
