import { Notice, Plugin, PluginSettingTab, Setting, apiVersion, requestUrl } from 'obsidian';
import type { App, SettingDefinitionItem } from 'obsidian';

import { canReload, installUpdate, listInstalled, pluginDir, reloadPlugin } from './internal.ts';
import { createExtensions } from './src/api.ts';
import type { InstallIntent, InstalledEvent, ReportSummary, RowAction, UpdateRadarApiV1 } from './src/api.ts';
import { PluginPicker, SnoozePicker, VersionModal } from './rollback-modal.ts';
import type { RollbackHost, Target } from './rollback-modal.ts';
import { applyFiles, checkManifest, selectAssets, versionToIgnore } from './src/rollback.ts';
import type { NewFiles, ReleaseEntry } from './src/rollback.ts';
import { VIEW_TYPE, UpdatesView } from './view.ts';
import type { Host } from './view.ts';
import { applyExtHolds, buildReports, newerVersions, pendingUpdates } from './src/report.ts';
import { DAY_MS, MAX_SNOOZE_DAYS, WAIT_DAYS, nextSeen, parseMinAgeDays, parseSeen, parseSnoozed, pruneSnoozed } from './src/holds.ts';
import type { Holds, SeenEntry } from './src/holds.ts';
import type { PluginReport, ReportInputs } from './src/report.ts';
import { parseDirectory, parseManifest, parseRelease, parseRemoved, parseUpdated } from './src/sources.ts';
import type { ReleaseInfo, RemoteManifest } from './src/sources.ts';
import { t } from './src/i18n.ts';

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
  /** Plugin id -> instant until which all its updates are hidden. */
  snoozed: Record<string, number>;
  /** Plugin id -> the newer version Update Radar is waiting on and when it first saw it. */
  seen: Record<string, SeenEntry>;
  /** Days to wait before offering an update; 0 offers it at once. */
  minAgeDays: number;
  lastChecked: number;
  /** Also list pre-releases when choosing an earlier version of a plugin. */
  includePrereleases: boolean;
}

const DEFAULT_SETTINGS: Settings = { checkOnStartup: true, everyHours: 6, statusBar: true, ignored: {}, snoozed: {}, seen: {}, minAgeDays: 0, lastChecked: 0, includePrereleases: false };

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

export default class PluginUpdateCheckerPlugin extends Plugin implements Host, RollbackHost {
  settings: Settings = { ...DEFAULT_SETTINGS };
  reports: PluginReport[] = [];
  checking = false;
  updating = false;
  private cache: DirectoryCache | null = null;
  private statusEl: HTMLElement | null = null;
  private releases = new Map<string, ReleaseInfo | null>();
  private extensions = createExtensions((message, error) => console.error(message, error));
  /** What other plugins use: `app.plugins.getPlugin('update-radar').api`. Null while unloaded. */
  api: UpdateRadarApiV1 | null = null;

  get lastChecked() {
    return this.settings.lastChecked;
  }
  get includePrereleases() {
    return this.settings.includePrereleases;
  }
  get ignored() {
    return this.settings.ignored;
  }

  private holds(): Holds {
    const { ignored, snoozed, seen, minAgeDays } = this.settings;
    return { ignored, snoozed, seen, minAgeDays };
  }

  async onload() {
    this.api = this.extensions.api({
      reports: () => this.reports.map((r) => this.summary(r)),
      release: (repo, version) => this.release(repo, version),
      ignore: (id, version) => this.ignore(id, version),
      busy: () => this.checking || this.updating,
      refresh: () => this.rebuildKeepingRemotes(),
    });
    const data = (await this.loadData()) as Partial<Stored> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...data,
      ignored: { ...data?.ignored },
      snoozed: pruneSnoozed(parseSnoozed(data?.snoozed, Date.now()), null, Date.now()),
      seen: parseSeen(data?.seen),
      minAgeDays: parseMinAgeDays(data?.minAgeDays),
    };
    this.cache = data?.cache ?? null;

    this.registerView(VIEW_TYPE, (leaf) => new UpdatesView(leaf, this));
    this.addRibbonIcon('package-check', t('ribbon.updates'), () => void this.openView());
    this.addCommand({ id: 'open-view', name: t('command.openView'), icon: 'package-check', callback: () => void this.openView() });
    this.addCommand({ id: 'check-now', name: t('command.checkNow'), icon: 'refresh-cw', callback: () => void this.check(true) });
    this.addCommand({ id: 'install-earlier', name: t('command.installEarlier'), icon: 'history', callback: () => void this.chooseEarlier() });
    this.addCommand({ id: 'snooze-plugin', name: t('command.snoozePlugin'), icon: 'bell-off', callback: () => void this.chooseSnooze() });
    this.addCommand({ id: 'update-all', name: t('command.updateAll'), icon: 'download', callback: () => void this.updateAll() });
    this.addSettingTab(new UpdateCheckerSettingTab(this.app, this));

    this.applyStatusBar();
    this.app.workspace.onLayoutReady(() => {
      // Extensions that loaded first look the API up; those that load later wait for this event.
      this.app.workspace.trigger('update-radar:api-ready', this.api);
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
    this.extensions.close();
    this.api = null;
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
      this.statusEl.setText(n === 1 ? t('status.updates.one') : t('status.updates.other', { count: n }));
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

  /** A text file (a release asset) from `url`. Replaced in tests, which have no internet. */
  async fetchText(url: string): Promise<string> {
    const res = await requestUrl({ url, throw: false });
    if (res.status >= 400) throw new Error(`${res.status} for ${url}`);
    return res.text;
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
      if (manual) new Notice(t('notice.noPluginList'));
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

      const now = Date.now();
      this.settings.seen = nextSeen(this.settings.seen, newerVersions(installed, remotes, apiVersion), now);
      this.settings.snoozed = pruneSnoozed(this.settings.snoozed, new Set(installed.map((p) => p.id)), now);
      this.reports = this.build({
        installed,
        directory: new Map(Object.entries(cache.repos).filter(([, repo]) => repo).map(([id, repo]) => [id, { id, name: id, repo }])),
        removed: new Map(Object.entries(cache.removed)),
        updated: new Map(Object.entries(cache.updated)),
        remotes,
        appVersion: apiVersion,
        holds: this.holds(),
        now,
      });
      this.settings.lastChecked = Date.now();
      await this.saveSettings();
      this.extensions.emit('checked', { reports: this.reports.map((r) => this.summary(r)), manual });
      if (manual) {
        const n = pendingUpdates(this.reports).length;
        new Notice(n === 0 ? t('notice.upToDate') : n === 1 ? t('notice.updatesAvailable.one') : t('notice.updatesAvailable.other', { count: n }));
      }
    } catch (e) {
      // No connection is the usual cause; stay quiet unless the user asked.
      if (manual) new Notice(t('notice.checkFailed', { reason: e instanceof Error ? e.message : String(e) }));
    } finally {
      this.checking = false;
      this.refreshUi();
    }
  }

  /** The classified list, with the holds of extensions applied. */
  private build(inputs: ReportInputs): PluginReport[] {
    const reports = buildReports(inputs);
    return applyExtHolds(reports, (query) => this.extensions.holdFor(query), this.settings.seen, inputs.now);
  }

  private summary(r: PluginReport): ReportSummary {
    return Object.freeze({
      id: r.plugin.id,
      name: r.plugin.name,
      version: r.plugin.version,
      repo: r.repo,
      state: r.update?.state ?? 'none',
      available: r.update?.available ?? '',
      heldBy: r.update?.held ? Object.freeze({ ...r.update.held }) : null,
    });
  }

  /** Lets extensions look at, or stop, an install. False (after saying why) when one stopped it. */
  private async allowed(intent: InstallIntent): Promise<boolean> {
    const veto = await this.extensions.runBefore(intent);
    if (!veto) return true;
    new Notice(t('notice.extensionStopped', { owner: veto.owner, plugin: intent.name, reason: veto.reason || '-' }));
    return false;
  }

  /** The entries extensions add to a plugin's row menu. */
  extraActions(r: PluginReport): RowAction[] {
    return this.extensions.actionsFor({ id: r.plugin.id, name: r.plugin.name, version: r.plugin.version, repo: r.repo, state: r.update?.state ?? 'none' });
  }

  async update(report: PluginReport, bulk = 1): Promise<boolean> {
    const remote = report.update?.remote;
    if (!remote || !report.repo || this.updating) return false;
    this.updating = true;
    this.refreshUi();
    let installed: InstalledEvent | null = null;
    try {
      const intent: InstallIntent = { id: report.plugin.id, name: report.plugin.name, repo: report.repo, from: report.plugin.version, to: remote.version, kind: 'update', bulk };
      if (!(await this.allowed(intent))) return false;
      const self = report.plugin.id === this.manifest.id;
      await installUpdate(this.app, report.repo, remote.raw);
      installed = { id: intent.id, name: intent.name, from: intent.from, to: intent.to, kind: 'update' };
      new Notice(t('notice.updated', { plugin: report.plugin.name, version: remote.version }));
      // Updating this plugin reloads it from inside the call: this instance is already unloaded.
      if (!self) {
        this.reports = this.reports.map((r) =>
          r === report && r.update ? { ...r, plugin: { ...r.plugin, version: remote.version }, update: { ...r.update, state: 'current' as const } } : r,
        );
      }
      return true;
    } catch (e) {
      new Notice(t('notice.updateFailed', { plugin: report.plugin.name, reason: e instanceof Error ? e.message : String(e) }));
      return false;
    } finally {
      this.updating = false;
      this.refreshUi();
      if (installed) this.extensions.emit('installed', installed);
    }
  }

  async updateAll(): Promise<void> {
    if (this.updating) return;
    // This plugin goes last: installing it reloads it, which would cut the loop short.
    const todo = pendingUpdates(this.reports).sort((a, b) => Number(a.plugin.id === this.manifest.id) - Number(b.plugin.id === this.manifest.id));
    if (!todo.length) {
      new Notice(t('notice.noUpdates'));
      return;
    }
    let done = 0;
    for (const r of todo) if (await this.update(r, todo.length)) done++;
    new Notice(t('notice.updatedCount', { done, total: todo.length }));
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

  /** Hides every update of one plugin for `days` days (at most 366); it comes back by itself. */
  async snooze(id: string, days: number) {
    const until = Date.now() + Math.min(Math.max(days, 0), MAX_SNOOZE_DAYS) * DAY_MS;
    this.settings.snoozed[id] = until;
    await this.saveSettings();
    const name = this.reports.find((r) => r.plugin.id === id)?.plugin.name ?? id;
    new Notice(t('notice.snoozed', { plugin: name, date: new Date(until).toLocaleDateString() }));
    this.rebuildKeepingRemotes();
  }

  async unsnooze(id: string) {
    delete this.settings.snoozed[id];
    await this.saveSettings();
    this.rebuildKeepingRemotes();
  }

  async chooseSnooze() {
    if (!this.reports.length) await this.check(false);
    const targets = this.snoozeTargets();
    if (!targets.length) {
      new Notice(t('notice.noDirectoryPlugins'));
      return;
    }
    new SnoozePicker(this.app, this, targets).open();
  }

  /** Every checked plugin, listed or not, for the snooze picker. */
  private snoozeTargets(): Target[] {
    return this.reports.map((r) => ({ id: r.plugin.id, name: r.plugin.name, version: r.plugin.version, repo: r.repo }));
  }

  /** Reclassifies the last results after the ignore, snooze or wait setting changed, without another network round. */
  rebuildKeepingRemotes() {
    const remotes = new Map<string, RemoteManifest | null>();
    for (const r of this.reports) remotes.set(r.plugin.id, r.update?.remote ?? null);
    const c = this.cache;
    if (!c) return;
    this.reports = this.build({
      installed: this.reports.map((r) => r.plugin),
      directory: new Map(Object.entries(c.repos).filter(([, repo]) => repo).map(([id, repo]) => [id, { id, name: id, repo }])),
      removed: new Map(Object.entries(c.removed)),
      updated: new Map(Object.entries(c.updated)),
      remotes,
      appVersion: apiVersion,
      holds: this.holds(),
      now: Date.now(),
    });
    this.refreshUi();
  }

  /** Plugins that can be rolled back: installed and listed in the directory, so their GitHub repository is known. */
  rollbackTargets(): Target[] {
    return this.reports.filter((r) => r.repo).map((r) => ({ id: r.plugin.id, name: r.plugin.name, version: r.plugin.version, repo: r.repo }));
  }

  /** Opens the version list for one plugin, or says why it cannot. */
  rollback(id: string) {
    const target = this.rollbackTargets().find((x) => x.id === id);
    if (!target) {
      new Notice(t('notice.rollbackDirectoryOnly'));
      return;
    }
    new VersionModal(this.app, this, target).open();
  }

  async chooseEarlier() {
    if (!this.reports.length) await this.check(false);
    const targets = this.rollbackTargets();
    if (!targets.length) {
      new Notice(t('notice.noDirectoryPlugins'));
      return;
    }
    new PluginPicker(this.app, this, targets).open();
  }

  /**
   * Installs `release` over the current files of `target`. Everything is
   * downloaded and checked first; only then are the files written, and a failed
   * write puts the old files back. `data.json` is never read or touched.
   */
  async installEarlier(target: Target, release: ReleaseEntry): Promise<boolean> {
    if (this.updating || this.checking) {
      new Notice(t('notice.busy'));
      return false;
    }
    const assets = selectAssets(release, target.repo);
    if (!assets) {
      new Notice(t('notice.noAssets', { version: release.version }));
      return false;
    }
    if (!canReload(this.app)) {
      new Notice(t('notice.noLoader'));
      return false;
    }
    this.updating = true;
    this.refreshUi();
    try {
      let files: NewFiles;
      let manifestVersion: string;
      try {
        const [main, manifestText, styles] = await Promise.all([
          this.fetchText(assets.main.url),
          this.fetchText(assets.manifest.url),
          assets.styles ? this.fetchText(assets.styles.url) : Promise.resolve(null),
        ]);
        const checked = checkManifest(manifestText, target.id, apiVersion);
        if (!checked.ok) throw new Error(checked.error);
        if (!main.trim()) throw new Error(t('error.mainEmpty'));
        manifestVersion = String(checked.manifest.version);
        files = { main, manifest: manifestText, styles };
      } catch (e) {
        new Notice(t('notice.downloadFailed', { plugin: target.name, version: release.version, reason: e instanceof Error ? e.message : String(e) }));
        return false;
      }
      const intent: InstallIntent = { id: target.id, name: target.name, repo: target.repo, from: target.version, to: manifestVersion, kind: 'earlier', bulk: 1 };
      if (!(await this.allowed(intent))) return false;
      try {
        await applyFiles(this.app.vault.adapter, pluginDir(this.app, target.id), files);
      } catch (e) {
        new Notice(t('notice.installFailed', { plugin: target.name, version: manifestVersion, reason: e instanceof Error ? e.message : String(e) }));
        return false;
      }

      // The radar must stop offering the version that was rolled back from.
      const latest = this.reports.find((r) => r.plugin.id === target.id)?.update?.remote.version ?? null;
      const skip = versionToIgnore(target.version, latest, manifestVersion);
      if (skip) this.settings.ignored[target.id] = skip;
      await this.saveSettings();
      new Notice(
        skip
          ? t('notice.rolledBackIgnoring', { plugin: target.name, version: manifestVersion, skipped: skip })
          : t('notice.rolledBack', { plugin: target.name, version: manifestVersion }),
      );

      const self = target.id === this.manifest.id;
      const installed: InstalledEvent = { id: target.id, name: target.name, from: target.version, to: manifestVersion, kind: 'earlier' };
      // Reloading this plugin unloads it, and its listeners with it: tell them first.
      if (self) this.extensions.emit('installed', installed);
      this.reports = this.reports.map((r) => (r.plugin.id === target.id ? { ...r, plugin: { ...r.plugin, version: manifestVersion } } : r));
      if (!self) this.rebuildKeepingRemotes();
      try {
        // Reloading this plugin unloads it from inside the call; nothing after this relies on `this`.
        await reloadPlugin(this.app, target.id);
      } catch (e) {
        new Notice(t('notice.reloadFailed', { plugin: target.name, reason: e instanceof Error ? e.message : String(e), version: manifestVersion }));
      }
      if (!self) this.extensions.emit('installed', installed);
      return true;
    } finally {
      this.updating = false;
      this.refreshUi();
    }
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

const hours = (n: number) => (n === 1 ? t('option.hours.one') : t('option.hours.other', { count: n }));

const everyOptions = (): Record<string, string> => ({
  '0': t('option.never'),
  '1': hours(1),
  '3': hours(3),
  '6': hours(6),
  '12': hours(12),
  '24': hours(24),
});

const days = (n: number) => (n === 1 ? t('option.days.one') : t('option.days.other', { count: n }));

const waitOptions = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const n of WAIT_DAYS) out[String(n)] = n === 0 ? t('option.noWait') : days(n);
  return out;
};

/** The settings stored as numbers but chosen from a dropdown, which hands back strings. */
const NUMERIC = ['everyHours', 'minAgeDays'];

const TEXT = {
  checkOnStartup: { name: t('setting.checkOnStartup.name'), desc: t('setting.checkOnStartup.desc') },
  everyHours: { name: t('setting.everyHours.name'), desc: t('setting.everyHours.desc') },
  minAgeDays: { name: t('setting.minAgeDays.name'), desc: t('setting.minAgeDays.desc') },
  statusBar: { name: t('setting.statusBar.name'), desc: t('setting.statusBar.desc') },
  includePrereleases: { name: t('setting.includePrereleases.name'), desc: t('setting.includePrereleases.desc') },
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
      { ...TEXT.everyHours, control: { type: 'dropdown', key: 'everyHours', options: everyOptions(), defaultValue: String(DEFAULT_SETTINGS.everyHours) } },
      { ...TEXT.minAgeDays, control: { type: 'dropdown', key: 'minAgeDays', options: waitOptions(), defaultValue: String(DEFAULT_SETTINGS.minAgeDays) } },
      { ...TEXT.statusBar, control: { type: 'toggle', key: 'statusBar', defaultValue: DEFAULT_SETTINGS.statusBar } },
      { ...TEXT.includePrereleases, control: { type: 'toggle', key: 'includePrereleases', defaultValue: DEFAULT_SETTINGS.includePrereleases } },
    ];
  }

  getControlValue(key: string): unknown {
    const value = (this.plugin.settings as unknown as Record<string, unknown>)[key];
    return NUMERIC.includes(key) ? String(value) : value;
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    Object.assign(this.plugin.settings, { [key]: NUMERIC.includes(key) ? Number(value) : value });
    await this.plugin.saveSettings();
    if (key === 'minAgeDays') this.plugin.rebuildKeepingRemotes();
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
          .addOptions(everyOptions())
          .setValue(String(this.plugin.settings.everyHours))
          .onChange((v) => this.setControlValue('everyHours', v)),
      );

    new Setting(containerEl)
      .setName(TEXT.minAgeDays.name)
      .setDesc(TEXT.minAgeDays.desc)
      .addDropdown((d) =>
        d
          .addOptions(waitOptions())
          .setValue(String(this.plugin.settings.minAgeDays))
          .onChange((v) => this.setControlValue('minAgeDays', v)),
      );

    new Setting(containerEl)
      .setName(TEXT.statusBar.name)
      .setDesc(TEXT.statusBar.desc)
      .addToggle((t) => t.setValue(this.plugin.settings.statusBar).onChange((v) => this.setControlValue('statusBar', v)));

    new Setting(containerEl)
      .setName(TEXT.includePrereleases.name)
      .setDesc(TEXT.includePrereleases.desc)
      .addToggle((t) => t.setValue(this.plugin.settings.includePrereleases).onChange((v) => this.setControlValue('includePrereleases', v)));
  }
}
