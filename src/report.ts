import { classifyUpdate } from './check.ts';
import type { InstalledPlugin, UpdateCheck } from './check.ts';
import { classifyHealth } from './health.ts';
import type { Health } from './health.ts';
import { NO_HOLDS } from './holds.ts';
import type { Holds } from './holds.ts';
import type { Hold, HoldQuery } from './api.ts';
import type { DirectoryEntry, RemoteManifest } from './sources.ts';

export interface PluginReport {
  plugin: InstalledPlugin;
  /** GitHub `owner/name`, when the directory lists the plugin. */
  repo: string;
  /** Null when no manifest was fetched (not listed, or the request failed). */
  update: (UpdateCheck & { remote: RemoteManifest }) | null;
  health: Health;
  /** True when the manifest request failed, so "no update" would be a guess. */
  failed: boolean;
}

export interface ReportInputs {
  installed: InstalledPlugin[];
  directory: ReadonlyMap<string, DirectoryEntry>;
  removed: ReadonlyMap<string, string>;
  updated: ReadonlyMap<string, number>;
  /** Latest manifest per id; null means the request failed or returned nothing usable. */
  remotes: ReadonlyMap<string, RemoteManifest | null>;
  appVersion: string;
  holds: Holds;
  now: number;
}

export function buildReports(src: ReportInputs): PluginReport[] {
  const listed = new Set(src.directory.keys());
  const reports = src.installed.map((plugin): PluginReport => {
    const entry = src.directory.get(plugin.id);
    const remote = src.remotes.get(plugin.id) ?? null;
    return {
      plugin,
      repo: entry?.repo ?? '',
      update: remote ? { ...classifyUpdate(plugin, remote, src.appVersion, src.holds, src.now), remote } : null,
      health: classifyHealth(plugin.id, { listed, removed: src.removed, updated: src.updated }, src.now),
      failed: !!entry && src.remotes.has(plugin.id) && remote === null,
    };
  });
  return reports.sort((a, b) => a.plugin.name.localeCompare(b.plugin.name));
}

/**
 * The plugins that have a newer release, for `nextSeen`: id -> that version, or
 * null where the manifest could not be read (a failed check proves nothing).
 */
export function newerVersions(installed: readonly InstalledPlugin[], remotes: ReadonlyMap<string, RemoteManifest | null>, appVersion: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const plugin of installed) {
    if (!remotes.has(plugin.id)) continue;
    const remote = remotes.get(plugin.id) ?? null;
    if (!remote) out.set(plugin.id, null);
    else if (classifyUpdate(plugin, remote, appVersion, NO_HOLDS, 0).state !== 'current') out.set(plugin.id, remote.version);
  }
  return out;
}

/** Plugins with an update the user can install now. */
export function pendingUpdates(reports: readonly PluginReport[]): PluginReport[] {
  return reports.filter((r) => r.update?.state === 'update');
}

/** Plugins worth a second look, worst first: removed, then stale, then not from the directory. */
export function healthConcerns(reports: readonly PluginReport[]): PluginReport[] {
  const weight = (r: PluginReport) => (r.health.flags.includes('removed') ? 0 : r.health.flags.includes('stale') ? 1 : 2);
  return reports.filter((r) => r.health.flags.length > 0).sort((a, b) => weight(a) - weight(b) || a.plugin.name.localeCompare(b.plugin.name));
}

/**
 * Moves updates that an extension holds back to the 'held' state. Precedence
 * overall: current, snoozed, ignored, blocked, held, waiting, update, so only
 * what would otherwise be 'waiting' or 'update' can be held. `seen` gives the
 * moment each version was first seen; `holdFor` is the extensions' answer. With
 * no extension holding anything the reports come back unchanged (same objects).
 */
export function applyExtHolds(
  reports: readonly PluginReport[],
  holdFor: (query: HoldQuery) => Hold | null,
  seen: Readonly<Record<string, { version: string; at: number }>>,
  now: number,
): PluginReport[] {
  return reports.map((r) => {
    const u = r.update;
    if (!u || (u.state !== 'update' && u.state !== 'waiting')) return r;
    const entry = seen[r.plugin.id];
    const hold = holdFor({
      id: r.plugin.id,
      name: r.plugin.name,
      installed: r.plugin.version,
      available: u.available,
      firstSeen: entry && entry.version === u.available ? entry.at : now,
      now,
    });
    return hold ? { ...r, update: { ...u, state: 'held' as const, held: { owner: hold.owner, label: hold.label } } } : r;
  });
}
