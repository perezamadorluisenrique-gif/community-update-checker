/** Why a newer release is not on offer yet, and the settings behind it. */
export interface SeenEntry {
  version: string;
  /** When Update Radar first saw this version available (ms epoch). */
  at: number;
}

export interface Holds {
  /** Plugin id -> the one version the user chose to skip. */
  ignored: Record<string, string>;
  /** Plugin id -> instant until which every update of that plugin is hidden (ms epoch). */
  snoozed: Record<string, number>;
  seen: Record<string, SeenEntry>;
  /** Days to wait after first seeing a release; 0 offers it at once. */
  minAgeDays: number;
}

export const DAY_MS = 86_400_000;
/** A snooze never reaches further than this, so a stray value cannot hide a plugin for good. */
export const MAX_SNOOZE_DAYS = 366;
export const SNOOZE_DAYS = [1, 7, 30, 90] as const;
export const WAIT_DAYS = [0, 1, 3, 7, 14, 30] as const;

export const NO_HOLDS: Holds = { ignored: {}, snoozed: {}, seen: {}, minAgeDays: 0 };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `minAgeDays` from stored data: one of the offered values, else off. */
export function parseMinAgeDays(value: unknown): number {
  return typeof value === 'number' && (WAIT_DAYS as readonly number[]).includes(value) ? value : 0;
}

/** The snooze list from stored data: finite numbers only, capped at 366 days from `now`. */
export function parseSnoozed(value: unknown, now: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(value)) return out;
  const cap = now + MAX_SNOOZE_DAYS * DAY_MS;
  for (const [id, until] of Object.entries(value)) if (typeof until === 'number' && Number.isFinite(until)) out[id] = Math.min(until, cap);
  return out;
}

/** The seen list from stored data: entries with a version string and a finite time. */
export function parseSeen(value: unknown): Record<string, SeenEntry> {
  const out: Record<string, SeenEntry> = {};
  if (!isRecord(value)) return out;
  for (const [id, e] of Object.entries(value)) {
    if (isRecord(e) && typeof e.version === 'string' && e.version && typeof e.at === 'number' && Number.isFinite(e.at)) out[id] = { version: e.version, at: e.at };
  }
  return out;
}

/** Drops snoozes that ended and, when `installedIds` is given, those of plugins that are gone. */
export function pruneSnoozed(snoozed: Record<string, number>, installedIds: ReadonlySet<string> | null, now: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, until] of Object.entries(parseSnoozed(snoozed, now))) if (until > now && (!installedIds || installedIds.has(id))) out[id] = until;
  return out;
}

/**
 * The seen list after a check. `latest` maps each plugin that has a newer
 * release to its version, or to null when the check failed. A new version
 * restarts the wait, a failed check keeps what we had, and anything not in
 * `latest` (updated, removed, uninstalled) is dropped.
 */
export function nextSeen(seen: Record<string, SeenEntry>, latest: ReadonlyMap<string, string | null>, now: number): Record<string, SeenEntry> {
  const out: Record<string, SeenEntry> = {};
  for (const [id, version] of latest) {
    const old = seen[id];
    if (version === null) {
      if (old) out[id] = old;
    } else {
      out[id] = old && old.version === version ? old : { version, at: now };
    }
  }
  return out;
}
