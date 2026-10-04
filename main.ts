import { Notice, Plugin, PluginSettingTab, Setting, apiVersion, requestUrl } from 'obsidian';
import type { App, SettingDefinitionItem } from 'obsidian';

import { installUpdate, listInstalled } from './internal.ts';
import { VIEW_TYPE, UpdatesView } from './view.ts';
import type { Host } from './view.ts';
import { buildReports, pendingUpdates } from './src/report.ts';
import type { PluginReport } from './src/report.ts';
import { parseDirectory, parseManifest, parseRelease, parseRemoved, parseUpdated } from './src/sources.ts';
import type { ReleaseInfo, RemoteManifest } from './src/sources.ts';

const RAW = 'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD/';
const DIRECTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 15_000;
const TICK_MS = 10 * 60 * 1000;
const PARALLEL = 4;

interface Settings {
  checkOnStartup: boolean;
  /** Hours between background checks. */
  everyHours: number;
  statusBar: boolean;
  /** Plugin id -> the one version the user chose to skip. */
  ignored: Record<string, string>;
  lastChecked: number;
}

const DEFAULT_SETTINGS: Settings = { checkOnStartup: true, everyHours: 6, statusBar: true, ignored: {}, lastChecked: 0 };

/** What we keep of the directory between runs: only the installed plugins, so the file stays small. */
interface DirectoryCache {
  fetchedAt: number;
  repos: Record<string, string>;
  removed: Record<string, string>;
  updated: Record<string, number>;
}

interface Stored extends Settings {
  cache?: DirectoryCache;
}

export default class PluginUpdateCheckerPlugin extends Plugin implements Host {
  settings: Settings = { ...DEFAULT_SETTINGS };
  reports: PluginReport[] = [];
  checking = false;
  updating = false;
  private cache: DirectoryCache | null = null;
  private statusEl: HTMLElement | null = null;
  private releases = new Map<string, ReleaseInfo | null>();

  get lastChecked() {
    return this.settings.lastChecked;
  }
  get ignored() {
    return this.settings.ignored;
  }

  async onload() {
    const data = (await this.loadData()) as Partial<Stored> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...data, ignored: { ...data?.ignored } };
    this.cache = data?.cache ?? null;

    this.registerView(VIEW_TYPE, (leaf) => new UpdatesView(leaf, this));
    this.addRibbonIcon('package-check', 'Plugin updates', () => void this.openView());
    this.addCommand({ id: 'open-view', name: 'Show plugin updates', icon: 'package-check', callback: () => void this.openView() });
    this.addCommand({ id: 'check-now', name: 'Check for plugin updates now', icon: 'refresh-cw', callback: () => void this.check(true) });
    this.addCommand({ id: 'update-all', name: 'Update all plugins', icon: 'download', callback: () => void this.updateAll() });
    this.addSettingTab(new UpdateCheckerSettingTab(this.app, this));

    this.applyStatusBar();
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.checkOnStartup) {
        this.registerTimer(() => void this.check(false), STARTUP_DELAY_MS);
      }
      // One cheap tick decides whether the interval has passed, so changing it needs no re-registering.
      this.registerInterval(
        window.setInterval(() => {
          if (this.settings.everyHours > 0 && Date.now() - this.settings.lastChecked >= this.settings.everyHours * 3_600_000) void this.check(false);
        }, TICK_MS),
      );
    });
  }

  onunload() {
    this.statusEl?.remove();
  }

  private registerTimer(fn: () => void, ms: number) {
    this.registerInterval(window.setTimeout(fn, ms));
  }

  async saveSettings() {
    const stored: Stored = { ...this.settings, cache: this.cache ?? undefined };
    await this.saveData(stored);
  }

  applyStatusBar() {
    if (this.settings.statusBar && !this.statusEl) {
      this.statusEl = this.addStatusBarItem();
      this.statusEl.addClass('mod-clickable');
      this.statusEl.addEventListener('click', () => void this.openView());
    } else if (!this.settings.statusBar && this.statusEl) {
      this.statusEl.remove();
      this.statusEl = null;
    }
    this.refreshUi();
  }

  private refreshUi() {
    const n = pendingUpdates(this.reports).length;
    if (this.statusEl) {
      this.statusEl.toggle(n > 0);
      this.statusEl.setText(`${n} plugin update${n === 1 ? '' : 's'}`);
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof UpdatesView) leaf.view.render();
    }
  }

  async openView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    if (!existing) await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  /** A JSON document from `url`. Replaced in tests, which have no internet. */
  async fetchJson(url: string): Promise<unknown> {
    const res = await requestUrl({ url, throw: false, headers: { Accept: 'application/json' } });
    if (res.status >= 400) throw new Error(`${res.status} for ${url}`);
    return JSON.parse(res.text) as unknown;
  }

  private async loadDirectory(installedIds: string[]): Promise<DirectoryCache> {
    const c = this.cache;
    const fresh = c && Date.now() - c.fetchedAt < DIRECTORY_MAX_AGE_MS && installedIds.every((id) => id in c.repos);
    if (c && fresh) return c;
    const [dir, removed, stats] = await Promise.all([
      this.fetchJson(`${RAW}community-plugins.json`),
      this.fetchJson(`${RAW}community-plugins-removed.json`),
      this.fetchJson(`${RAW}community-plugin-stats.json`),
    ]);
    const directory = parseDirectory(dir);
    const removedMap = parseRemoved(removed);
    const updatedMap = parseUpdated(stats);
    const next: DirectoryCache = { fetchedAt: Date.now(), repos: {}, removed: {}, updated: {} };
    for (const id of installedIds) {
      // '' marks "checked, not in the directory", so the next check does not refetch for it.
      next.repos[id] = directory.get(id)?.repo ?? '';
      const r = removedMap.get(id);
      if (r !== undefined) next.removed[id] = r;
      const u = updatedMap.get(id);
      if (u !== undefined) next.updated[id] = u;
    }
    this.cache = next;
    return next;
  }

  async check(manual: boolean): Promise<void> {
    if (this.checking) return;
    const installed = listInstalled(this.app);
    if (!installed) {
      if (manual) new Notice('This version of Obsidian does not expose its plugin list.');
      return;
    }
    this.checking = true;
    this.refreshUi();
    try {
      const cache = await this.loadDirectory(installed.map((p) => p.id));
      const remotes = new Map<string, RemoteManifest | null>();
      const queue = installed.filter((p) => cache.repos[p.id] && !(p.id in cache.removed));
      const worker = async () => {
        for (let p = queue.shift(); p; p = queue.shift()) {
          try {
            remotes.set(p.id, parseManifest(await this.fetchJson(`https://github.com/${cache.repos[p.id]}/releases/latest/download/manifest.json`)));
          } catch {
            remotes.set(p.id, null);
          }
        }
      };
      await Promise.all(Array.from({ length: PARALLEL }, worker));

      this.reports = buildReports({
        installed,
        directory: new Map(Object.entries(cache.repos).filter(([, repo]) => repo).map(([id, repo]) => [id, { id, name: id, repo }])),
        removed: new Map(Object.entries(cache.removed)),
        updated: new Map(Object.entries(cache.updated)),
        remotes,
        appVersion: apiVersion,
        ignored: this.settings.ignored,
        now: Date.now(),
      });
      this.settings.lastChecked = Date.now();
      await this.saveSettings();
      if (manual) {
        const n = pendingUpdates(this.reports).length;
        new Notice(n ? `${n} plugin update${n === 1 ? '' : 's'} available.` : 'All plugins are up to date.');
      }
    } catch (e) {
      // No connection is the usual cause; stay quiet unless the user asked.
      if (manual) new Notice(`Could not check for updates: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.checking = false;
      this.refreshUi();
    }
  }

  async update(report: PluginReport): Promise<boolean> {
    const remote = report.update?.remote;
    if (!remote || !report.repo || this.updating) return false;
    this.updating = true;
    this.refreshUi();
    try {
      const self = report.plugin.id === this.manifest.id;
      await installUpdate(this.app, report.repo, remote.raw);
      new Notice(`${report.plugin.name} updated to ${remote.version}.`);
      // Updating this plugin reloads it from inside the call: this instance is already unloaded.
      if (!self) {
        this.reports = this.reports.map((r) =>
          r === report && r.update ? { ...r, plugin: { ...r.plugin, version: remote.version }, update: { ...r.update, state: 'current' as const } } : r,
        );
      }
      return true;
    } catch (e) {
      new Notice(`Could not update ${report.plugin.name}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    } finally {
      this.updating = false;
      this.refreshUi();
    }
  }

  async updateAll(): Promise<void> {
    if (this.updating) return;
    // This plugin goes last: installing it reloads it, which would cut the loop short.
    const todo = pendingUpdates(this.reports).sort((a, b) => Number(a.plugin.id === this.manifest.id) - Number(b.plugin.id === this.manifest.id));
    if (!todo.length) {
      new Notice('No plugin updates available. Run a check first.');
      return;
    }
    let done = 0;
    for (const r of todo) if (await this.update(r)) done++;
    new Notice(`${done} of ${todo.length} plugins updated.`);
  }

  async ignore(id: string, version: string) {
    this.settings.ignored[id] = version;
    await this.saveSettings();
    this.rebuildKeepingRemotes();
  }

  async unignore(id: string) {
    delete this.settings.ignored[id];
    await this.saveSettings();
    this.rebuildKeepingRemotes();
  }

  /** Reclassifies the last results after the ignore list changed, without another network round. */
  private rebuildKeepingRemotes() {
    const remotes = new Map<string, RemoteManifest | null>();
    for (const r of this.reports) remotes.set(r.plugin.id, r.update?.remote ?? null);
    const c = this.cache;
    if (!c) return;
    this.reports = buildReports({
      installed: this.reports.map((r) => r.plugin),
      directory: new Map(Object.entries(c.repos).filter(([, repo]) => repo).map(([id, repo]) => [id, { id, name: id, repo }])),
      removed: new Map(Object.entries(c.removed)),
      updated: new Map(Object.entries(c.updated)),
      remotes,
      appVersion: apiVersion,
      ignored: this.settings.ignored,
      now: Date.now(),
    });
    this.refreshUi();
  }

  async release(repo: string, version: string): Promise<ReleaseInfo | null> {
    const key = `${repo}@${version}`;
    if (this.releases.has(key)) return this.releases.get(key) ?? null;
    let info: ReleaseInfo | null = null;
    // Tags are usually the bare version; some authors prefix "v".
    for (const tag of [version, `v${version}`]) {
      try {
        info = parseRelease(await this.fetchJson(`https://api.github.com/repos/${repo}/releases/tags/${tag}`));
      } catch {
        info = null;
      }
      if (info) break;
    }
    this.releases.set(key, info);
    return info;
  }
}

const EVERY_OPTIONS = { '0': 'Never (startup only)', '1': '1 hour', '3': '3 hours', '6': '6 hours', '12': '12 hours', '24': '24 hours' };

const TEXT = {
  checkOnStartup: {
    name: 'Check shortly after Obsidian starts',
    desc: "Reads the plugin directory and each installed plugin's latest release from GitHub. Nothing else is sent anywhere, and nothing about your vault leaves it.",
  },
  everyHours: { name: 'Check every', desc: 'How often to look for updates while Obsidian stays open.' },
  statusBar: { name: 'Show the update count in the status bar', desc: 'Hidden when there are no updates. Not shown on mobile.' },
};

class UpdateCheckerSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: PluginUpdateCheckerPlugin,
  ) {
    super(app, plugin);
  }

  /**
   * Obsidian 1.13+ renders this itself and indexes it for the settings search.
   * Older versions ignore it and call `display()`.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      { ...TEXT.checkOnStartup, control: { type: 'toggle', key: 'checkOnStartup', defaultValue: DEFAULT_SETTINGS.checkOnStartup } },
      { ...TEXT.everyHours, control: { type: 'dropdown', key: 'everyHours', options: EVERY_OPTIONS, defaultValue: String(DEFAULT_SETTINGS.everyHours) } },
      { ...TEXT.statusBar, control: { type: 'toggle', key: 'statusBar', defaultValue: DEFAULT_SETTINGS.statusBar } },
    ];
  }

  getControlValue(key: string): unknown {
    const value = (this.plugin.settings as unknown as Record<string, unknown>)[key];
    return key === 'everyHours' ? String(value) : value;
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    Object.assign(this.plugin.settings, { [key]: key === 'everyHours' ? Number(value) : value });
    await this.plugin.saveSettings();
    if (key === 'statusBar') this.plugin.applyStatusBar();
  }

  /** The pre-1.13 rendering, from the same text. Obsidian skips it once `getSettingDefinitions()` returns anything. */
  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName(TEXT.checkOnStartup.name)
      .setDesc(TEXT.checkOnStartup.desc)
      .addToggle((t) => t.setValue(this.plugin.settings.checkOnStartup).onChange((v) => this.setControlValue('checkOnStartup', v)));

    new Setting(containerEl)
      .setName(TEXT.everyHours.name)
      .setDesc(TEXT.everyHours.desc)
      .addDropdown((d) =>
        d
          .addOptions(EVERY_OPTIONS)
          .setValue(String(this.plugin.settings.everyHours))
          .onChange((v) => this.setControlValue('everyHours', v)),
      );

    new Setting(containerEl)
      .setName(TEXT.statusBar.name)
      .setDesc(TEXT.statusBar.desc)
      .addToggle((t) => t.setValue(this.plugin.settings.statusBar).onChange((v) => this.setControlValue('statusBar', v)));
  }
}
