// Version parsing and comparison shared by skew detection and updates.
// Numeric tuples with leading-v tolerance; unparseable values fall back to
// string order.
export function parseVersion(v: string): number[] | null {
  const s = v.startsWith("v") ? v.slice(1) : v;
  if (!/^\d+(\.\d+)*$/.test(s)) return null;
  return s.split(".").map(Number);
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa && pb) {
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
      const x = pa[i] ?? 0;
      const y = pb[i] ?? 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
