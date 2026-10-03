import { classifyUpdate } from './check.ts';
import type { InstalledPlugin, UpdateCheck } from './check.ts';
import { classifyHealth } from './health.ts';
import type { Health } from './health.ts';
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
  ignored: Record<string, string>;
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
      update: remote ? { ...classifyUpdate(plugin, remote, src.appVersion, src.ignored), remote } : null,
      health: classifyHealth(plugin.id, { listed, removed: src.removed, updated: src.updated }, src.now),
      failed: !!entry && src.remotes.has(plugin.id) && remote === null,
    };
  });
  return reports.sort((a, b) => a.plugin.name.localeCompare(b.plugin.name));
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
