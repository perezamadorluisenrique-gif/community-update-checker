import { compareVersions } from './version.ts';
import { DAY_MS } from './holds.ts';
import type { Holds } from './holds.ts';
import type { RemoteManifest } from './sources.ts';

export interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
}

export type UpdateState =
  /** A newer version exists and this Obsidian can run it. */
  | 'update'
  /** A newer version exists but needs a newer Obsidian than the one running. */
  | 'blocked'
  /** A newer version exists, but the user chose to ignore exactly that version. */
  | 'ignored'
  /** A newer version exists, but the user snoozed every update of this plugin for now. */
  | 'snoozed'
  /** A newer version exists, but an extension's rule holds it back (see `applyExtHolds`). Never set by `classifyUpdate`. */
  | 'held'
  /** A newer version exists, but it has not been seen for the number of days the user asked to wait. */
  | 'waiting'
  /** Nothing newer, or the versions cannot be compared. */
  | 'current';

export interface UpdateCheck {
  state: UpdateState;
  available: string;
  /** The Obsidian version the update needs, set when `state` is 'blocked'. */
  requires: string;
  /** When the snooze ends (ms epoch), set when `state` is 'snoozed'. */
  until: number;
  /** When the wait ends (ms epoch), set when `state` is 'waiting'. */
  readyAt: number;
  /** Who holds the update and why; set only when `state` is 'held'. */
  held?: { owner: string; label: string };
}

/**
 * Decides what to tell the user about one plugin. Precedence: current, snoozed,
 * ignored, blocked, waiting, update (an extension's hold, applied afterwards, sits between blocked and waiting). A blocked update stays blocked while it
 * waits, because waiting does not unblock it.
 */
export function classifyUpdate(installed: InstalledPlugin, remote: RemoteManifest, appVersion: string, holds: Holds, now: number): UpdateCheck {
  const available = remote.version;
  const result = (state: UpdateState, extra: Partial<UpdateCheck> = {}): UpdateCheck => ({ state, available, requires: '', until: 0, readyAt: 0, ...extra });
  // Versions that are not semver (four parts, dates) cannot be ordered; like Obsidian's own check,
  // any difference then counts as an update.
  const order = compareVersions(available, installed.version);
  const newer = order === null ? available !== installed.version : order === 1;
  if (!newer) return result('current');
  const until = holds.snoozed[installed.id];
  if (until !== undefined && until > now) return result('snoozed', { until });
  if (holds.ignored[installed.id] === available) return result('ignored');
  // An unreadable minAppVersion is treated as "no floor": the installer decides.
  if (remote.minAppVersion && compareVersions(remote.minAppVersion, appVersion) === 1) return result('blocked', { requires: remote.minAppVersion });
  if (holds.minAgeDays > 0) {
    const entry = holds.seen[installed.id];
    // Never seen at this version: the clock starts now, so the wait is never underestimated.
    const readyAt = (entry && entry.version === available ? entry.at : now) + holds.minAgeDays * DAY_MS;
    if (now < readyAt) return result('waiting', { readyAt });
  }
  return result('update');
}
