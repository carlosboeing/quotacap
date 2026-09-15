// Version parsing and comparison shared by skew detection and updates.
// Numeric tuples with leading-v tolerance; unparseable values fall back to
// string order.
export function parseVersion(v: string): number[] | null {
  const s = v.startsWith("v") ? v.slice(1) : v;
  const match = s.match(/^(\d+(?:\.\d+)*)(?:-[0-9a-fA-F]{7,40}(?:-dirty)?)?$/);
  if (!match || !match[1]) return null;
  return match[1].split(".").map(Number);
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
    if (a === b) return 0;
    const aNorm = a.startsWith("v") ? a.slice(1) : a;
    const bNorm = b.startsWith("v") ? b.slice(1) : b;
    if (aNorm === bNorm) return 0;
    const aHasSuffix = aNorm.includes("-");
    const bHasSuffix = bNorm.includes("-");
    if (!aHasSuffix && !bHasSuffix) return 0;
    if (aHasSuffix && !bHasSuffix) return 1;
    if (!aHasSuffix && bHasSuffix) return -1;
    return aNorm < bNorm ? -1 : 1;
  }
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
