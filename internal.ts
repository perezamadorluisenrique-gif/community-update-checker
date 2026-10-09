// The one place that touches Obsidian's undocumented plugin manager
// (`app.plugins`). It is the same installer the core "Check for updates"
// button and BRAT use. Everything here is typed by hand and checked at runtime,
// so a future Obsidian that moves it fails with a message, not a crash.
import type { App, PluginManifest } from 'obsidian';

interface PluginManager {
  manifests: Record<string, PluginManifest>;
  enabledPlugins: Set<string>;
  installPlugin(repo: string, version: string, manifest: PluginManifest): Promise<void>;
}

function manager(app: App): PluginManager | null {
  const pm = (app as unknown as { plugins?: Partial<PluginManager> }).plugins;
  if (!pm || typeof pm.installPlugin !== 'function') return null;
  if (typeof pm.manifests !== 'object' || pm.manifests === null) return null;
  return pm as PluginManager;
}

export interface InstalledEntry {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
}

/** Every community plugin in the vault, enabled or not. Null if the plugin manager is not there. */
export function listInstalled(app: App): InstalledEntry[] | null {
  const pm = manager(app);
  if (!pm) return null;
  return Object.values(pm.manifests).map((m) => ({
    id: m.id,
    name: m.name,
    version: m.version,
    enabled: pm.enabledPlugins instanceof Set && pm.enabledPlugins.has(m.id),
  }));
}

/**
 * Downloads the release `version` of `repo` into the vault. Obsidian's
 * installer re-reads the release's manifest, checks the id, loads the new
 * manifest and reloads the plugin itself if it was running, so nothing is done
 * after it. That includes this plugin: updating it reloads it from inside the
 * call, and the new code is already running when the call returns.
 */
export async function installUpdate(app: App, repo: string, manifest: Record<string, unknown>): Promise<void> {
  const pm = manager(app);
  if (!pm) throw new Error('This version of Obsidian does not expose the plugin installer.');
  const version = typeof manifest.version === 'string' ? manifest.version : '';
  if (!version) throw new Error('The release has no version.');
  await pm.installPlugin(repo, version, manifest as unknown as PluginManifest);
}

/** The folder a plugin lives in, as Obsidian recorded it, or the standard place. */
export function pluginDir(app: App, id: string): string {
  const pm = manager(app);
  return pm?.manifests[id]?.dir || `${app.vault.configDir}/plugins/${id}`;
}

interface Reloader {
  enabledPlugins: Set<string>;
  plugins?: Record<string, unknown>;
  disablePlugin(id: string): Promise<void>;
  enablePlugin(id: string): Promise<boolean | void>;
  loadManifests(): Promise<void>;
}

/** True when this Obsidian has the calls `reloadPlugin` needs. Checked before anything is written. */
export function canReload(app: App): boolean {
  const pm = (app as unknown as { plugins?: Partial<Reloader> }).plugins;
  return !!pm && typeof pm.disablePlugin === 'function' && typeof pm.enablePlugin === 'function' && typeof pm.loadManifests === 'function';
}

/**
 * Makes Obsidian pick up files that were replaced on disk: reads the manifests
 * again and, if the plugin was running, turns it off and on. The "enabled" list
 * saved in the vault is not touched. Disabling the plugin that is calling this
 * unloads it from inside the call; the code after it still runs.
 */
export async function reloadPlugin(app: App, id: string): Promise<void> {
  if (!canReload(app)) throw new Error('This version of Obsidian does not expose the plugin loader.');
  const pm = (app as unknown as { plugins: Reloader }).plugins;
  const set = pm.enabledPlugins instanceof Set ? pm.enabledPlugins : null;
  const wasEnabled = !!set?.has(id) || !!pm.plugins?.[id];
  if (wasEnabled) await pm.disablePlugin(id);
  await pm.loadManifests();
  if (wasEnabled) {
    await pm.enablePlugin(id);
    // disablePlugin forgets the plugin in the in-memory enabled list; enablePlugin does not put it back.
    set?.add(id);
  }
}
