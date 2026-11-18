import { Notice, Plugin, PluginSettingTab, Setting, apiVersion, requestUrl } from 'obsidian';
import type { App, SettingDefinitionItem } from 'obsidian';

import { activeTheme, canReload, installUpdate, listInstalled, pluginDir, reloadPlugin, reloadTheme } from './internal.ts';
import { createExtensions } from './src/api.ts';
import type { InstallIntent, InstallResult, InstalledEvent, ReportSummary, RowAction, UpdateRadarApiV1 } from './src/api.ts';
import { InstallRequestModal, PluginPicker, SnoozePicker, VersionModal } from './rollback-modal.ts';
import type { RollbackHost, Target } from './rollback-modal.ts';
import { applyFiles, checkManifest, releaseByTag, selectAssets, versionToIgnore } from './src/rollback.ts';
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
import { isNewer } from './src/version.ts';
import { moreDefinitions, renderMore } from './src/more-link.ts';
import { THEMES_URL, THEME_CSS, buildThemeReports, changeThemeHold, checkedNotice, downloadTheme, fetchThemeTargets, listInstalledThemes, nextThemeHolds, parseThemeDirectory, parseThemeHolds, pendingThemes, statusText, writeThemeFiles } from './src/themes.ts';
import type { InstalledTheme, ThemeEntry, ThemeHoldChange, ThemeHolds, ThemeReport } from './src/themes.ts';
import { HINT_DEFAULTS, cleanHintSettings, hintDue, hintUrl, hintsOff, markHintShown, renderHint } from './src/pro-hint.ts';
import type { HintSettings } from './src/pro-hint.ts';

const RAW = 'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD/';
const DIRECTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 15_000;
const TICK_MS = 10 * 60 * 1000;
const PARALLEL = 4;

interface Settings extends HintSettings {
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
  /** Also check the installed community themes. */
  checkThemes: boolean;
  /** Ignored versions, snoozes and the wait clock of themes, keyed by theme name. */
  themeHolds: ThemeHolds;
}

const DEFAULT_SETTINGS: Settings = { checkOnStartup: true, everyHours: 6, statusBar: true, ignored: {}, snoozed: {}, seen: {}, minAgeDays: 0, lastChecked: 0, includePrereleases: false, checkThemes: true, themeHolds: { ignored: {}, snoozed: {}, seen: {} }, ...HINT_DEFAULTS, proHintShown: {} };

/** Where Update Radar shows a Pro tip; each is the `ref` of the Pro page it opens. */
export type ProTipPlace = 'ur-update-all' | 'ur-rollback';
/** At least this many plugins in one "Update all" before its tip may show. */
const TIP_MIN_UPDATES = 3;

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
  /** Installed themes as the last check saw them. Kept apart from `reports`: the extension API is about plugins only. */
  themeReports: ThemeReport[] = [];
  private themeDirectory: { fetchedAt: number; entries: Map<string, ThemeEntry> } | null = null;
  private extensions = createExtensions((message, error) => console.warn(message, error), { set: (fn, ms) => window.setTimeout(fn, ms), clear: (handle) => window.clearTimeout(handle as number) });
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
      install: (id, version) => this.installRequested(id, version),
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
      themeHolds: parseThemeHolds(data?.themeHolds, Date.now()),
      checkThemes: data?.checkThemes !== false,
      ...cleanHintSettings(data),
    };
    this.cache = data?.cache ?? null;

    this.registerView(VIEW_TYPE, (leaf) => new UpdatesView(leaf, this));
    this.addRibbonIcon('package-check', t('ribbon.updates'), () => void this.openView());
    this.addCommand({ id: 'open-view', name: t('command.openView'), icon: 'package-check', callback: () => void this.openView() });
    this.addCommand({ id: 'check-now', name: t('command.checkNow'), icon: 'refresh-cw', callback: () => void this.check(true) });
    this.addCommand({ id: 'install-earlier', name: t('command.installEarlier'), icon: 'history', callback: () => void this.chooseEarlier() });
    this.addCommand({ id: 'snooze-plugin', name: t('command.snoozePlugin'), icon: 'bell-off', callback: () => void this.chooseSnooze() });
    this.addCommand({ id: 'update-all', name: t('command.updateAll'), icon: 'download', callback: () => void this.updateAll() });
    this.addCommand({ id: 'update-all-themes', name: t('command.updateAllThemes'), icon: 'palette', callback: () => void this.updateAllThemes() });
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
    const text = statusText(pendingUpdates(this.reports).length, pendingThemes(this.themeReports).length);
    if (this.statusEl) {
      this.statusEl.toggle(text !== '');
      this.statusEl.setText(text);
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
    this.pendingTip = null;
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
      await this.checkThemes(now);
      this.settings.lastChecked = Date.now();
      await this.saveSettings();
      this.extensions.emit('checked', { reports: this.reports.map((r) => this.summary(r)), manual });
      if (manual) new Notice(checkedNotice(pendingUpdates(this.reports).length, pendingThemes(this.themeReports).length, this.themeReports.length > 0));
    } catch (e) {
      // No connection is the usual cause; stay quiet unless the user asked.
      if (manual) new Notice(t('notice.checkFailed', { reason: e instanceof Error ? e.message : String(e) }));
    } finally {
      this.checking = false;
      this.refreshUi();
    }
  }

  /**
   * Checks the installed community themes (when the setting is on and there is
   * at least one; otherwise nothing is requested). A failure keeps the last
   * theme results and never fails the plugin check.
   */
  private async checkThemes(now: number): Promise<void> {
    if (!this.settings.checkThemes) {
      this.themeReports = [];
      return;
    }
    try {
      const installed = await listInstalledThemes(this.app.vault.adapter, this.app.vault.configDir);
      if (!installed.length) {
        this.themeReports = [];
        return;
      }
      // The theme list is read at most once a day per session, and only when a theme is installed.
      let dir = this.themeDirectory;
      if (!dir || now - dir.fetchedAt >= DIRECTORY_MAX_AGE_MS) dir = this.themeDirectory = { fetchedAt: now, entries: parseThemeDirectory(await this.fetchJson(THEMES_URL)) };
      const { entries } = dir;
      const remotes = await fetchThemeTargets(this, installed, entries, apiVersion);
      this.settings.themeHolds = nextThemeHolds(this.settings.themeHolds, installed, remotes, apiVersion, now);
      this.themeReports = buildThemeReports(installed, entries, remotes, apiVersion, this.settings.themeHolds, this.settings.minAgeDays, now);
    } catch (e) {
      console.warn('update-radar: the theme check failed', e);
    }
  }

  /** Reclassifies the last theme results (no network), after a hold or the wait setting changed. */
  rebuildThemes() {
    const installed: InstalledTheme[] = this.themeReports.map((r) => r.theme);
    const remotes = new Map(this.themeReports.filter((r) => r.update || r.failed).map((r) => [r.theme.name, r.update?.remote ?? null]));
    const repos = new Map(this.themeReports.filter((r) => r.repo).map((r) => [r.theme.name, { name: r.theme.name, repo: r.repo, legacy: false }]));
    this.themeReports = buildThemeReports(installed, repos, remotes, apiVersion, this.settings.themeHolds, this.settings.minAgeDays, Date.now());
    this.refreshUi();
  }

  get activeTheme() {
    return activeTheme(this.app);
  }

  /** Ignore, stop ignoring, snooze or unsnooze one theme. */
  async setThemeHold(name: string, change: ThemeHoldChange) {
    this.settings.themeHolds = changeThemeHold(this.settings.themeHolds, name, change, Date.now());
    await this.saveSettings();
    if (change.kind === 'snooze') new Notice(t('notice.snoozed', { plugin: name, date: new Date(this.settings.themeHolds.snoozed[name] ?? 0).toLocaleDateString() }));
    this.rebuildThemes();
  }

  /**
   * Installs the newer version of one theme: `manifest.json` and `theme.css` are
   * both downloaded and checked first, then written (old files put back if a
   * write fails), and the theme is applied again if it is the one in use. No
   * extension event: the extension API is about plugins.
   */
  async updateTheme(report: ThemeReport): Promise<boolean> {
    const remote = report.update?.remote;
    if (!remote || !report.repo || this.updating) return false;
    this.updating = true;
    this.refreshUi();
    const { name } = report.theme;
    try {
      const dir = `${this.app.vault.configDir}/themes/${name}`;
      const files = await downloadTheme(this, name, report.repo, remote.version, apiVersion);
      await writeThemeFiles(this.app.vault.adapter, dir, files);
      try {
        await reloadTheme(this.app, name, `${dir}/${THEME_CSS}`);
      } catch (e) {
        console.warn('update-radar: could not apply the updated theme', e);
      }
      this.themeReports = this.themeReports.map((r) =>
        r === report && r.update ? { ...r, theme: { ...r.theme, version: files.version }, update: { ...r.update, state: 'current' as const } } : r,
      );
      new Notice(t('notice.themeUpdated', { theme: name, version: files.version }));
      return true;
    } catch (e) {
      new Notice(t('notice.themeUpdateFailed', { theme: name, reason: e instanceof Error ? e.message : String(e) }));
      return false;
    } finally {
      this.updating = false;
      this.refreshUi();
    }
  }

  async updateAllThemes(): Promise<void> {
    if (this.updating) return;
    const todo = pendingThemes(this.themeReports);
    if (!todo.length) {
      new Notice(t('notice.noThemeUpdates'));
      return;
    }
    let done = 0;
    for (const r of todo) if (await this.updateTheme(r)) done++;
    new Notice(t('notice.themesUpdatedCount', { done, total: todo.length }));
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
    if (done >= TIP_MIN_UPDATES && this.takeProTip('ur-update-all')) {
      this.pendingTip = 'ur-update-all';
      this.refreshUi();
    }
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
    this.rebuildThemes();
  }

  /** True when this place may show its Pro tip now; if so, remembers that it did (at most once every 14 days). */
  takeProTip(place: ProTipPlace): boolean {
    if (!hintDue(this.settings, place)) return false;
    Object.assign(this.settings, markHintShown(this.settings, place));
    void this.saveSettings();
    return true;
  }

  /** Draws one Pro tip at the end of `parent`: fixed text, a link to the public Pro page, and "Don't show again". */
  drawProTip(parent: HTMLElement, place: ProTipPlace): void {
    if (!this.settings.proHints) return;
    const line = place === 'ur-update-all' ? t('proHint.updateAll') : t('proHint.rollback');
    renderHint(parent, { line, more: t('proHint.more'), off: t('proHint.off') }, hintUrl('update-radar', place), () => this.proTipsOff());
  }

  /** The tip the updates view shows after "Update all", if any; it goes away on the next check. */
  pendingTip: ProTipPlace | null = null;

  async proTipsOff(): Promise<void> {
    Object.assign(this.settings, hintsOff(this.settings));
    this.pendingTip = null;
    await this.saveSettings();
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

  /**
   * `api.install`: a plugin (Update Radar Pro, say) asks for an exact version of a directory plugin,
   * installed or not. Everything is downloaded and checked first, the user is asked in this
   * plugin's own window, and the plugin is left turned off. Never throws.
   */
  async installRequested(id: string, version: string): Promise<InstallResult> {
    const fail = (error: string): InstallResult => ({ ok: false, error });
    if (this.updating || this.checking) return fail(t('notice.busy'));
    if (!canReload(this.app)) return fail(t('notice.noLoader'));
    this.updating = true;
    this.refreshUi();
    try {
      const installedNow = listInstalled(this.app)?.find((p) => p.id === id) ?? null;
      let repo = this.reports.find((r) => r.plugin.id === id)?.repo ?? '';
      if (!repo) {
        const [dir, removed] = await Promise.all([this.fetchJson(`${RAW}community-plugins.json`), this.fetchJson(`${RAW}community-plugins-removed.json`)]);
        if (parseRemoved(removed).has(id)) return fail(t('error.removedFromDirectory', { id }));
        repo = parseDirectory(dir).get(id)?.repo ?? '';
        if (!repo) return fail(t('error.notInDirectory', { id }));
      }
      let release: ReleaseEntry | null = null;
      for (const tag of [version, `v${version}`]) {
        try {
          release = releaseByTag(await this.fetchJson(`https://api.github.com/repos/${repo}/releases/tags/${tag}`), version);
        } catch {
          release = null;
        }
        if (release) break;
      }
      if (!release) return fail(t('error.noSuchRelease', { version }));
      const assets = selectAssets(release, repo);
      if (!assets) return fail(t('notice.noAssets', { version }));
      let files: NewFiles;
      let manifestVersion: string;
      let name: string;
      try {
        const [main, manifestText, styles] = await Promise.all([
          this.fetchText(assets.main.url),
          this.fetchText(assets.manifest.url),
          assets.styles ? this.fetchText(assets.styles.url) : Promise.resolve(null),
        ]);
        const checked = checkManifest(manifestText, id, apiVersion);
        if (!checked.ok) return fail(checked.error);
        if (!main.trim()) return fail(t('error.mainEmpty'));
        manifestVersion = String(checked.manifest.version);
        name = typeof checked.manifest.name === 'string' && checked.manifest.name ? checked.manifest.name : id;
        files = { main, manifest: manifestText, styles };
      } catch (e) {
        return fail(t('notice.downloadFailed', { plugin: id, version, reason: e instanceof Error ? e.message : String(e) }));
      }
      // Nobody installs in silence: the user sees what, which version and where from.
      if (!(await new InstallRequestModal(this.app, { plugin: name, version: manifestVersion, repo }).ask())) return fail(t('installRequest.declined'));
      const kind = !installedNow || isNewer(manifestVersion, installedNow.version) ? 'update' : 'earlier';
      const intent: InstallIntent = { id, name, repo, from: installedNow?.version ?? '', to: manifestVersion, kind, bulk: 1 };
      // Handlers protect what is installed (a copy before the change); a plugin that is not there has nothing to protect.
      if (installedNow) {
        const veto = await this.extensions.runBefore(intent);
        if (veto) return fail(t('notice.extensionStopped', { owner: veto.owner, plugin: name, reason: veto.reason || '-' }));
      }
      const dir = pluginDir(this.app, id);
      try {
        if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.adapter.mkdir(dir);
        await applyFiles(this.app.vault.adapter, dir, files);
      } catch (e) {
        return fail(t('notice.installFailed', { plugin: name, version: manifestVersion, reason: e instanceof Error ? e.message : String(e) }));
      }
      if (installedNow) {
        const latest = this.reports.find((r) => r.plugin.id === id)?.update?.remote.version ?? null;
        const skip = versionToIgnore(installedNow.version, latest, manifestVersion);
        if (skip) this.settings.ignored[id] = skip;
        await this.saveSettings();
      }
      const self = id === this.manifest.id;
      const event: InstalledEvent = { id, name, from: installedNow?.version ?? '', to: manifestVersion, kind };
      if (self) this.extensions.emit('installed', event);
      new Notice(installedNow ? t(kind === 'update' ? 'notice.updated' : 'notice.rolledBack', { plugin: name, version: manifestVersion }) : t('notice.installedNew', { plugin: name, version: manifestVersion }));
      try {
        await reloadPlugin(this.app, id);
      } catch (e) {
        new Notice(t('notice.reloadFailed', { plugin: name, reason: e instanceof Error ? e.message : String(e), version: manifestVersion }));
      }
      this.reports = this.reports.map((r) => (r.plugin.id === id ? { ...r, plugin: { ...r.plugin, version: manifestVersion } } : r));
      if (!self) {
        this.rebuildKeepingRemotes();
        this.extensions.emit('installed', event);
      }
      return { ok: true };
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
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
  checkThemes: { name: t('setting.checkThemes.name'), desc: t('setting.checkThemes.desc') },
  proHints: { name: t('setting.proHints.name'), desc: t('setting.proHints.desc') },
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
      { ...TEXT.checkThemes, control: { type: 'toggle', key: 'checkThemes', defaultValue: DEFAULT_SETTINGS.checkThemes } },
      { ...TEXT.proHints, control: { type: 'toggle', key: 'proHints', defaultValue: DEFAULT_SETTINGS.proHints } },
      ...(moreDefinitions() as SettingDefinitionItem[]),
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
    if (key === 'checkThemes' && !value) {
      this.plugin.themeReports = [];
      this.plugin.rebuildThemes();
    }
    if (key === 'proHints' && value === false) this.plugin.pendingTip = null;
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

    new Setting(containerEl)
      .setName(TEXT.checkThemes.name)
      .setDesc(TEXT.checkThemes.desc)
      .addToggle((t) => t.setValue(this.plugin.settings.checkThemes).onChange((v) => this.setControlValue('checkThemes', v)));

    new Setting(containerEl)
      .setName(TEXT.proHints.name)
      .setDesc(TEXT.proHints.desc)
      .addToggle((t) => t.setValue(this.plugin.settings.proHints).onChange((v) => this.setControlValue('proHints', v)));

    renderMore(this.containerEl, (el) => new Setting(el));
  }
}
