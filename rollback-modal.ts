import { FuzzySuggestModal, Modal, apiVersion } from 'obsidian';
import type { App } from 'obsidian';

import { isInstalledVersion, needsNewerApp, notesPreview, releaseChoices, selectAssets } from './src/rollback.ts';
import type { ReleaseEntry } from './src/rollback.ts';

/** The plugin being rolled back. */
export interface Target {
  id: string;
  name: string;
  version: string;
  repo: string;
}

/** What the dialogs need from the plugin; keeps these files free of a circular import. */
export interface RollbackHost {
  app: App;
  includePrereleases: boolean;
  fetchJson(url: string): Promise<unknown>;
  fetchText(url: string): Promise<string>;
  installEarlier(target: Target, release: ReleaseEntry): Promise<boolean>;
}

const PARALLEL = 4;

/** Lists a plugin's GitHub releases and installs the one the user picks. */
export class VersionModal extends Modal {
  private releases: ReleaseEntry[] = [];
  /** tag -> the minAppVersion in that release's manifest ('' = none, undefined = not read yet, null = could not be read). */
  private floors = new Map<string, string | null>();
  private busy = false;
  private closed = false;

  constructor(
    app: App,
    private readonly host: RollbackHost,
    private readonly target: Target,
  ) {
    super(app);
  }

  onOpen() {
    this.modalEl.addClass('puc-modal');
    this.setTitle(`Install an earlier version of ${this.target.name}`);
    this.contentEl.createDiv({ cls: 'puc-note', text: 'Loading releases from GitHub…' });
    void this.load();
  }

  onClose() {
    this.closed = true;
    this.contentEl.empty();
  }

  private async load() {
    try {
      const json = await this.host.fetchJson(`https://api.github.com/repos/${this.target.repo}/releases?per_page=100`);
      this.releases = releaseChoices(json, this.host.includePrereleases);
    } catch (e) {
      this.message(`Could not read the releases: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (this.closed) return;
    if (!this.releases.length) {
      this.message('This plugin has no published releases on GitHub.');
      return;
    }
    this.render();
    // Each release's manifest says which Obsidian it needs; read them a few at a time.
    const queue = this.releases.filter((r) => selectAssets(r, this.target.repo));
    const worker = async () => {
      for (let r = queue.shift(); r && !this.closed; r = queue.shift()) {
        const sel = selectAssets(r, this.target.repo);
        if (!sel) continue;
        try {
          const m = JSON.parse(await this.host.fetchText(sel.manifest.url)) as { minAppVersion?: unknown };
          this.floors.set(r.tag, typeof m.minAppVersion === 'string' ? m.minAppVersion : '');
        } catch {
          this.floors.set(r.tag, null);
        }
        this.render();
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
  }

  private message(text: string) {
    if (this.closed) return;
    this.contentEl.empty();
    this.contentEl.createDiv({ cls: 'puc-note', text });
  }

  private render() {
    if (this.closed) return;
    const root = this.contentEl;
    root.empty();
    root.createDiv({
      cls: 'puc-note',
      text: `Installed: ${this.target.version}. The directory only serves the latest version, so these come straight from GitHub. Your settings and data for the plugin are kept.`,
    });
    const list = root.createDiv({ cls: 'puc-versions' });
    for (const r of this.releases) {
      const sel = selectAssets(r, this.target.repo);
      const floor = this.floors.get(r.tag);
      const tooNew = !!floor && needsNewerApp(floor, apiVersion);
      const installed = isInstalledVersion(r.version, this.target.version);
      const row = list.createDiv({ cls: 'puc-version' });
      row.toggleClass('puc-dim', tooNew || !sel);
      const line = row.createDiv({ cls: 'puc-line' });
      line.createSpan({ cls: 'puc-name', text: r.version });
      if (r.prerelease) line.createSpan({ cls: 'puc-flag', text: 'Pre-release' });
      if (installed) line.createSpan({ cls: 'puc-flag puc-flag-installed', text: 'Installed' });
      if (r.published) line.createSpan({ cls: 'puc-ver', text: new Date(r.published).toLocaleDateString() });
      const actions = line.createDiv({ cls: 'puc-actions' });
      const btn = actions.createEl('button', { text: 'Install' });
      btn.disabled = this.busy || installed || tooNew || !sel;
      btn.addEventListener('click', () => void this.install(r));
      const preview = notesPreview(r.body);
      if (preview) row.createDiv({ cls: 'puc-note', text: preview });
      if (!sel) row.createDiv({ cls: 'puc-note', text: 'This release has no main.js and manifest.json to download.' });
      else if (tooNew) row.createDiv({ cls: 'puc-note', text: `Needs Obsidian ${floor}; you have ${apiVersion}.` });
    }
  }

  private async install(release: ReleaseEntry) {
    if (this.busy) return;
    this.busy = true;
    this.render();
    const ok = await this.host.installEarlier(this.target, release);
    this.busy = false;
    if (ok) this.close();
    else this.render();
  }
}

/** Picks one of the plugins that can be rolled back, then opens its version list. */
export class PluginPicker extends FuzzySuggestModal<Target> {
  constructor(
    app: App,
    private readonly host: RollbackHost,
    private readonly targets: Target[],
  ) {
    super(app);
    this.setPlaceholder('Choose a plugin to install an earlier version of');
  }
  getItems() {
    return this.targets;
  }
  getItemText(t: Target) {
    return `${t.name} (${t.version})`;
  }
  onChooseItem(t: Target) {
    new VersionModal(this.app, this.host, t).open();
  }
}

