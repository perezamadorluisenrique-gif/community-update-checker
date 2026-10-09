import { ItemView, MarkdownRenderer, Menu, apiVersion, setIcon } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';

import { formatAge } from './src/health.ts';
import type { HealthFlag } from './src/health.ts';
import { neutralizeNotes } from './src/notes.ts';
import { healthConcerns } from './src/report.ts';
import type { PluginReport } from './src/report.ts';
import type { ReleaseInfo } from './src/sources.ts';

export const VIEW_TYPE = 'update-radar-view';

/** What the view needs from the plugin; keeps this file free of a circular import. */
export interface Host {
  reports: PluginReport[];
  lastChecked: number;
  checking: boolean;
  /** True while updates are being installed. */
  updating: boolean;
  ignored: Record<string, string>;
  check(manual: boolean): Promise<void>;
  update(report: PluginReport): Promise<boolean>;
  updateAll(): Promise<void>;
  ignore(id: string, version: string): Promise<void>;
  unignore(id: string): Promise<void>;
  release(repo: string, version: string): Promise<ReleaseInfo | null>;
  /** Opens the list of earlier versions of one plugin. */
  rollback(id: string): void;
}

const FLAG_TEXT: Record<HealthFlag, string> = {
  removed: 'Removed from the directory',
  stale: 'No release in 2+ years',
  'not-listed': 'Not from the directory',
};

export class UpdatesView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: Host,
  ) {
    super(leaf);
  }

  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return 'Plugin updates';
  }
  getIcon() {
    return 'package-check';
  }

  onOpen(): Promise<void> {
    this.render();
    if (!this.host.lastChecked && !this.host.checking) void this.host.check(false);
    return Promise.resolve();
  }

  onClose(): Promise<void> {
    return Promise.resolve();
  }

  /** Redraws from the host's current state. The plugin calls this after every check or change. */
  render() {
    const root = this.contentEl;
    root.empty();
    root.addClass('puc-view');
    const { reports } = this.host;

    const head = root.createDiv({ cls: 'puc-head' });
    head.createEl('h4', { text: 'Plugin updates' });
    const bar = head.createDiv({ cls: 'puc-bar' });
    const check = bar.createEl('button', { text: this.host.checking ? 'Checking…' : 'Check now' });
    check.disabled = this.host.checking || this.host.updating;
    check.addEventListener('click', () => void this.host.check(true));
    const pending = reports.filter((r) => r.update?.state === 'update');
    if (pending.length > 1) {
      const all = bar.createEl('button', { text: `Update all (${pending.length})`, cls: 'mod-cta' });
      all.disabled = this.host.checking || this.host.updating;
      all.addEventListener('click', () => void this.host.updateAll());
    }
    root.createDiv({
      cls: 'puc-meta',
      text: this.host.lastChecked ? `Last checked ${new Date(this.host.lastChecked).toLocaleString()}` : 'Not checked yet',
    });

    this.section(root, 'Updates available', pending, (row, r) => this.updateRow(row, r), 'Everything is up to date.');

    const blocked = reports.filter((r) => r.update?.state === 'blocked');
    if (blocked.length) {
      this.section(root, 'Needs a newer Obsidian', blocked, (row, r) => {
        this.title(row, r, `${r.plugin.version} → ${r.update?.available ?? ''}`);
        row.createDiv({ cls: 'puc-note', text: `Requires Obsidian ${r.update?.requires ?? ''}; you have ${apiVersion}.` });
      });
    }

    const ignored = reports.filter((r) => r.update?.state === 'ignored');
    if (ignored.length) {
      this.section(root, 'Ignored versions', ignored, (row, r) => {
        this.title(row, r, `${r.plugin.version} → ${r.update?.available ?? ''}`);
        const b = row.createEl('button', { text: 'Stop ignoring' });
        b.addEventListener('click', () => void this.host.unignore(r.plugin.id));
      });
    }

    const failed = reports.filter((r) => r.failed);
    if (failed.length) {
      this.section(root, 'Could not check', failed, (row, r) => {
        this.title(row, r, r.plugin.version);
        row.createDiv({ cls: 'puc-note', text: 'The latest release could not be read from GitHub.' });
      });
    }

    const concerns = healthConcerns(reports);
    this.section(root, 'Plugin health', concerns, (row, r) => {
      const days = r.health.daysSinceRelease;
      this.title(row, r, days === null ? r.plugin.version : `last release ${formatAge(days)} ago`);
      const flags = row.createDiv({ cls: 'puc-flags' });
      for (const f of r.health.flags) flags.createSpan({ cls: `puc-flag puc-flag-${f}`, text: FLAG_TEXT[f] });
      if (r.health.removedReason) row.createDiv({ cls: 'puc-note', text: `Reason: ${r.health.removedReason}` });
    }, 'No removed, abandoned or unlisted plugins.');

    this.rollbackSection(root, reports.filter((r) => r.repo));
  }

  /** Every plugin that came from the directory, each with a way to go back to an earlier version. */
  private rollbackSection(root: HTMLElement, items: PluginReport[]) {
    if (!items.length) return;
    const sec = root.createDiv({ cls: 'puc-section' });
    const details = sec.createEl('details', { cls: 'puc-rollback' });
    details.createEl('summary', { text: `Install an earlier version (${items.length})` });
    details.createDiv({ cls: 'puc-note', text: 'Went wrong after an update? Pick a plugin and one of its previous releases from GitHub.' });
    for (const r of items) {
      const row = details.createDiv({ cls: 'puc-row' });
      const line = this.title(row, r, r.plugin.version);
      const b = line.createDiv({ cls: 'puc-actions' }).createEl('button', { text: 'Earlier versions…' });
      b.addEventListener('click', () => this.host.rollback(r.plugin.id));
    }
  }

  private section(root: HTMLElement, title: string, items: PluginReport[], fill: (row: HTMLElement, r: PluginReport) => void, empty = '') {
    const sec = root.createDiv({ cls: 'puc-section' });
    sec.createEl('h5', { text: items.length ? `${title} (${items.length})` : title });
    if (!items.length) {
      if (empty) sec.createDiv({ cls: 'puc-note', text: empty });
      else sec.remove();
      return;
    }
    for (const r of items) {
      const row = sec.createDiv({ cls: 'puc-row' });
      fill(row, r);
      if (r.repo) this.rowMenu(row, r);
    }
  }

  /** Right-click (or long-press) on a row offers the earlier versions of that plugin. */
  private rowMenu(row: HTMLElement, r: PluginReport) {
    row.addEventListener('contextmenu', (evt) => {
      evt.preventDefault();
      const menu = new Menu();
      menu.addItem((item) => item.setTitle('Install an earlier version…').setIcon('history').onClick(() => this.host.rollback(r.plugin.id)));
      menu.showAtMouseEvent(evt);
    });
  }

  private title(row: HTMLElement, r: PluginReport, detail: string) {
    const line = row.createDiv({ cls: 'puc-line' });
    line.createSpan({ cls: 'puc-name', text: r.plugin.name });
    line.createSpan({ cls: 'puc-ver', text: detail });
    return line;
  }

  private updateRow(row: HTMLElement, r: PluginReport) {
    const line = this.title(row, r, `${r.plugin.version} → ${r.update?.available ?? ''}`);
    const actions = line.createDiv({ cls: 'puc-actions' });
    const up = actions.createEl('button', { text: 'Update', cls: 'mod-cta' });
    up.disabled = this.host.updating;
    up.addEventListener('click', () => {
      up.disabled = true;
      up.setText('Updating…');
      void this.host.update(r).then((ok) => {
        if (!ok) {
          up.disabled = false;
          up.setText('Update');
        }
      });
    });
    const back = actions.createEl('button', { attr: { 'aria-label': 'Install an earlier version' }, cls: 'clickable-icon puc-back' });
    setIcon(back, 'history');
    back.addEventListener('click', () => this.host.rollback(r.plugin.id));
    const skip = actions.createEl('button', { text: 'Ignore this version' });
    skip.addEventListener('click', () => void this.host.ignore(r.plugin.id, r.update?.available ?? ''));

    const notes = row.createEl('details', { cls: 'puc-notes' });
    const summary = notes.createEl('summary');
    setIcon(summary.createSpan({ cls: 'puc-chev' }), 'file-text');
    summary.createSpan({ text: ' Release notes' });
    let loaded = false;
    notes.addEventListener('toggle', () => {
      if (!notes.open || loaded || !r.update) return;
      loaded = true;
      const body = notes.createDiv({ cls: 'puc-notes-body', text: 'Loading…' });
      void this.host.release(r.repo, r.update.available).then(async (info) => {
        body.empty();
        if (!info) {
          body.setText('No release notes were found on GitHub.');
          return;
        }
        if (info.published) body.createDiv({ cls: 'puc-note', text: `Released ${new Date(info.published).toLocaleDateString()}` });
        if (info.body) await MarkdownRenderer.render(this.app, neutralizeNotes(info.body), body.createDiv(), '', this);
        else body.createDiv({ cls: 'puc-note', text: 'The author wrote no release notes.' });
        const link = body.createEl('a', { text: 'Open on GitHub', href: info.url });
        link.setAttr('target', '_blank');
      });
    });
  }
}
