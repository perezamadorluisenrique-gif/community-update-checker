// Pure logic: no `obsidian` import, so tests/ can run it under plain Node.

export interface ParsedVersion {
  nums: [number, number, number];
  pre: string[];
}

/** Parses "1.2.3", "v1.2", "1.2.3-beta.1" and "1.2.3+build". Returns null for anything else. */
export function parseVersion(text: string): ParsedVersion | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim());
  if (!m) return null;
  return {
    nums: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)],
    pre: m[4] ? m[4].split('.') : [],
  };
}

function comparePre(a: string[], b: string[]): number {
  // A version without a pre-release tag is newer than the same version with one.
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric identifiers sort before alphanumeric ones
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** -1, 0 or 1; null when either side is not a version. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  return comparePre(pa.pre, pb.pre) as -1 | 0 | 1;
}

/** True only when `available` is a version strictly newer than `installed`. */
export function isNewer(available: string, installed: string): boolean {
  return compareVersions(available, installed) === 1;
}
