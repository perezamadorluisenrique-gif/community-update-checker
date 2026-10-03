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
