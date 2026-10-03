export type HealthFlag = 'removed' | 'not-listed' | 'stale';

export interface Health {
  flags: HealthFlag[];
  /** Whole days since the last release, when the directory knows it. */
  daysSinceRelease: number | null;
  /** The reason the directory gives for removing the plugin. */
  removedReason: string;
}

export interface HealthInputs {
  /** Ids in the directory (`community-plugins.json`). */
  listed: ReadonlySet<string>;
  /** Removed ids with their reasons. */
  removed: ReadonlyMap<string, string>;
  /** Last release as a ms timestamp, from `community-plugin-stats.json`. */
  updated: ReadonlyMap<string, number>;
}

export const STALE_DAYS = 730;
const DAY_MS = 86_400_000;

/** Flags worth a second look. A removed plugin is never also reported as "not listed". */
export function classifyHealth(id: string, src: HealthInputs, now: number): Health {
  const flags: HealthFlag[] = [];
  const removedReason = src.removed.get(id) ?? '';
  const isRemoved = src.removed.has(id);
  if (isRemoved) flags.push('removed');
  else if (!src.listed.has(id)) flags.push('not-listed');
  const last = src.updated.get(id);
  const daysSinceRelease = last === undefined ? null : Math.max(0, Math.floor((now - last) / DAY_MS));
  if (daysSinceRelease !== null && daysSinceRelease >= STALE_DAYS) flags.push('stale');
  return { flags, daysSinceRelease, removedReason };
}

/** "3 days", "5 months", "2.5 years": short enough for a table cell. */
export function formatAge(days: number): string {
  if (days < 1) return 'today';
  if (days < 60) return `${days} day${days === 1 ? '' : 's'}`;
  if (days < 730) {
    const months = Math.round(days / 30.4);
    return `${months} months`;
  }
  const years = Math.round((days / 365.25) * 10) / 10;
  return `${years} years`;
}
