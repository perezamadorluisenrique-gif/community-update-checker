import { compareVersions } from './version.ts';
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
  /** Nothing newer, or the versions cannot be compared. */
  | 'current';

export interface UpdateCheck {
  state: UpdateState;
  available: string;
  /** The Obsidian version the update needs, set when `state` is 'blocked'. */
  requires: string;
}

/**
 * Decides what to tell the user about one plugin. `ignored` maps a plugin id
 * to the one version the user chose to skip; a later release shows up again.
 */
export function classifyUpdate(
  installed: InstalledPlugin,
  remote: RemoteManifest,
  appVersion: string,
  ignored: Record<string, string>,
): UpdateCheck {
  const available = remote.version;
  // Versions that are not semver (four parts, dates) cannot be ordered; like Obsidian's own check,
  // any difference then counts as an update.
  const order = compareVersions(available, installed.version);
  const newer = order === null ? available !== installed.version : order === 1;
  if (!newer) return { state: 'current', available, requires: '' };
  if (ignored[installed.id] === available) return { state: 'ignored', available, requires: '' };
  // An unreadable minAppVersion is treated as "no floor": the installer decides.
  if (remote.minAppVersion && compareVersions(remote.minAppVersion, appVersion) === 1) {
    return { state: 'blocked', available, requires: remote.minAppVersion };
  }
  return { state: 'update', available, requires: '' };
}
