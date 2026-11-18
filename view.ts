import { ItemView, MarkdownRenderer, Menu, apiVersion, setIcon } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';

import type { RowAction } from './src/api.ts';
import { inspectUrl } from './src/inspect.ts';
import { formatAge } from './src/health.ts';
import { SNOOZE_DAYS } from './src/holds.ts';
import { t } from './src/i18n.ts';
import type { HealthFlag } from './src/health.ts';
import { neutralizeNotes } from './src/notes.ts';
import { healthConcerns } from './src/report.ts';
import type { PluginReport } from './src/report.ts';
import type { ReleaseInfo } from './src/sources.ts';
import type { ThemeHoldChange, ThemeReport } from './src/themes.ts';

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
  snooze(id: string, days: number): Promise<void>;
  unsnooze(id: string): Promise<void>;
  release(repo: string, version: string): Promise<ReleaseInfo | null>;
  /** Opens the list of earlier versions of one plugin. */
  rollback(id: string): void;
  /** Entries other plugins add to a row's menu. */
  extraActions(report: PluginReport): RowAction[];
  /** Installed community themes from the last check; empty when themes are not checked. */
  themeReports: ThemeReport[];
  /** The theme in use, '' for the default. */
  activeTheme: string;
  updateTheme(report: ThemeReport): Promise<boolean>;
  updateAllThemes(): Promise<void>;
  setThemeHold(name: string, change: ThemeHoldChange): Promise<void>;
}

const flagText = (flag: HealthFlag): string =>
  flag === 'removed' ? t('flag.removed') : flag === 'stale' ? t('flag.stale') : t('flag.notListed');

const dayLabel = (n: number) => (n === 1 ? t('option.days.one') : t('option.days.other', { count: n }));

/** Updates the user could still hide: the rows that offer, wait for or block an update. */
const snoozable = (r: PluginReport) => r.update?.state === 'update' || r.update?.state === 'waiting' || r.update?.state === 'held' || r.update?.state === 'blocked';

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
    return t('view.title');
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
    head.createEl('h4', { text: t('view.title') });
    const bar = head.createDiv({ cls: 'puc-bar' });
    const check = bar.createEl('button', { text: this.host.checking ? t('view.checking') : t('view.checkNow') });
    check.disabled = this.host.checking || this.host.updating;
    check.addEventListener('click', () => void this.host.check(true));
    const pending = reports.filter((r) => r.update?.state === 'update');
    if (pending.length > 1) {
      const all = bar.createEl('button', { text: t('view.updateAll', { count: pending.length }), cls: 'mod-cta' });
      all.disabled = this.host.checking || this.host.updating;
      all.addEventListener('click', () => void this.host.updateAll());
    }
    root.createDiv({
      cls: 'puc-meta',
      text: this.host.lastChecked ? t('view.lastChecked', { when: new Date(this.host.lastChecked).toLocaleString() }) : t('view.notCheckedYet'),
    });

    const waiting = reports.filter((r) => r.update?.state === 'waiting');
    if (waiting.length) root.createDiv({ cls: 'puc-meta', text: t('view.moreWaiting', { count: waiting.length }) });

    this.section(root, t('view.available'), pending, (row, r) => this.updateRow(row, r), t('view.upToDate'));

    if (waiting.length) {
      this.section(root, t('view.waiting'), waiting, (row, r) => {
        const line = this.title(row, r, `${r.plugin.version} → ${r.update?.available ?? ''}`);
        const actions = line.createDiv({ cls: 'puc-actions' });
        const now = actions.createEl('button', { text: t('view.updateNow') });
        now.disabled = this.host.updating;
        now.addEventListener('click', () => {
          now.disabled = true;
          void this.host.update(r).then((ok) => {
            if (!ok) now.disabled = false;
          });
        });
        this.snoozeButton(actions, r);
        row.createDiv({ cls: 'puc-note', text: t('view.readyOn', { date: new Date(r.update?.readyAt ?? 0).toLocaleDateString() }) });
      });
    }

    const held = reports.filter((r) => r.update?.state === 'held');
    if (held.length) {
      this.section(root, t('view.held'), held, (row, r) => {
        const line = this.title(row, r, `${r.plugin.version} → ${r.update?.available ?? ''}`);
        const actions = line.createDiv({ cls: 'puc-actions' });
        const now = actions.createEl('button', { text: t('view.updateNow') });
        now.disabled = this.host.updating;
        now.addEventListener('click', () => {
          now.disabled = true;
          void this.host.update(r).then((ok) => {
            if (!ok) now.disabled = false;
          });
        });
        this.snoozeButton(actions, r);
        row.createDiv({ cls: 'puc-note', text: `${r.update?.held?.owner ?? ''}: ${r.update?.held?.label ?? ''}` });
      });
    }

    const blocked = reports.filter((r) => r.update?.state === 'blocked');
    if (blocked.length) {
      this.section(root, t('view.blocked'), blocked, (row, r) => {
        this.title(row, r, `${r.plugin.version} → ${r.update?.available ?? ''}`);
        row.createDiv({ cls: 'puc-note', text: t('view.requires', { required: r.update?.requires ?? '', current: apiVersion }) });
      });
    }

    const ignored = reports.filter((r) => r.update?.state === 'ignored');
    if (ignored.length) {
      this.section(root, t('view.ignored'), ignored, (row, r) => {
        this.title(row, r, `${r.plugin.version} → ${r.update?.available ?? ''}`);
        const b = row.createEl('button', { text: t('view.stopIgnoring') });
        b.addEventListener('click', () => void this.host.unignore(r.plugin.id));
      });
    }

    const snoozed = reports.filter((r) => r.update?.state === 'snoozed');
    if (snoozed.length) {
      this.section(root, t('view.snoozed'), snoozed, (row, r) => {
        const line = this.title(row, r, `${r.plugin.version} → ${r.update?.available ?? ''}`);
        line.createSpan({ cls: 'puc-note', text: t('view.snoozedUntil', { date: new Date(r.update?.until ?? 0).toLocaleDateString() }) });
        const b = line.createDiv({ cls: 'puc-actions' }).createEl('button', { text: t('view.unsnooze') });
        b.addEventListener('click', () => void this.host.unsnooze(r.plugin.id));
      });
    }

    const failed = reports.filter((r) => r.failed);
    if (failed.length) {
      this.section(root, t('view.failed'), failed, (row, r) => {
        this.title(row, r, r.plugin.version);
        row.createDiv({ cls: 'puc-note', text: t('view.failedNote') });
      });
    }

    this.themeSection(root);

    const concerns = healthConcerns(reports);
    this.section(root, t('view.health'), concerns, (row, r) => {
      const days = r.health.daysSinceRelease;
      this.title(row, r, days === null ? r.plugin.version : days < 1 ? t('view.lastReleaseToday') : t('view.lastRelease', { age: formatAge(days) }));
      const flags = row.createDiv({ cls: 'puc-flags' });
      for (const f of r.health.flags) flags.createSpan({ cls: `puc-flag puc-flag-${f}`, text: flagText(f) });
      if (r.health.removedReason) row.createDiv({ cls: 'puc-note', text: t('view.reason', { reason: r.health.removedReason }) });
    }, t('view.healthEmpty'));

    this.rollbackSection(root, reports.filter((r) => r.repo));
  }

  /**
   * One section for community themes: what can be updated first, then what waits,
   * needs a newer Obsidian, is ignored, snoozed or could not be checked, each row
   * with its own action. Hidden when no theme was checked.
   */
  private themeSection(root: HTMLElement) {
    const themes = this.host.themeReports.filter((r) => (r.update && r.update.state !== 'current') || r.failed);
    if (!this.host.themeReports.length) return;
    const pending = themes.filter((r) => r.update?.state === 'update');
    const sec = root.createDiv({ cls: 'puc-section puc-themes' });
    const head = sec.createDiv({ cls: 'puc-line' });
    head.createEl('h5', { text: pending.length ? `${t('view.themes')} (${pending.length})` : t('view.themes') });
    if (pending.length > 1) {
      const all = head.createDiv({ cls: 'puc-actions' }).createEl('button', { text: t('view.updateAllThemes', { count: pending.length }) });
      all.disabled = this.host.checking || this.host.updating;
      all.addEventListener('click', () => void this.host.updateAllThemes());
    }
    if (!themes.length) {
      sec.createDiv({ cls: 'puc-note', text: t('view.themesUpToDate') });
      return;
    }
    const order = ['update', 'waiting', 'blocked', 'ignored', 'snoozed'];
    const rank = (r: ThemeReport) => (r.failed ? order.length : order.indexOf(r.update?.state ?? ''));
    for (const r of [...themes].sort((a, b) => rank(a) - rank(b))) this.themeRow(sec.createDiv({ cls: 'puc-row puc-theme' }), r);
  }

  private themeRow(row: HTMLElement, r: ThemeReport) {
    const { name } = r.theme;
    const u = r.update;
    const line = row.createDiv({ cls: 'puc-line' });
    line.createSpan({ cls: 'puc-name', text: name });
    line.createSpan({ cls: 'puc-ver', text: u ? `${r.theme.version || '?'} → ${u.available}` : r.theme.version });
    if (name === this.host.activeTheme) line.createSpan({ cls: 'puc-flag puc-flag-active', text: t('view.activeTheme') });
    const actions = line.createDiv({ cls: 'puc-actions' });
    const install = (label: string, cta: boolean) => {
      const b = actions.createEl('button', { text: label, cls: cta ? 'mod-cta' : '' });
      b.disabled = this.host.updating;
      b.addEventListener('click', () => {
        b.disabled = true;
        if (cta) b.setText(t('view.updating'));
        void this.host.updateTheme(r).then((ok) => {
          if (!ok) {
            b.disabled = false;
            b.setText(label);
          }
        });
      });
    };
    const button = (label: string, run: (evt: MouseEvent) => void) => actions.createEl('button', { text: label }).addEventListener('click', run);
    const snooze = () =>
      button(t('view.snooze'), (evt) => {
        const menu = new Menu();
        for (const days of SNOOZE_DAYS) {
          menu.addItem((item) => item.setTitle(t('view.snoozeFor', { days: dayLabel(days) })).setIcon('bell-off').onClick(() => void this.host.setThemeHold(name, { kind: 'snooze', days })));
        }
        menu.showAtMouseEvent(evt);
      });
    const note = (text: string) => row.createDiv({ cls: 'puc-note', text });
    if (r.failed) note(t('view.themeFailedNote'));
    else if (u?.state === 'update') {
      install(t('view.update'), true);
      snooze();
      button(t('view.ignore'), () => void this.host.setThemeHold(name, { kind: 'ignore', version: u.available }));
    } else if (u?.state === 'waiting') {
      install(t('view.updateNow'), false);
      snooze();
      note(t('view.readyOn', { date: new Date(u.readyAt).toLocaleDateString() }));
    } else if (u?.state === 'blocked') {
      note(t('view.requires', { required: u.requires, current: apiVersion }));
    } else if (u?.state === 'ignored') {
      button(t('view.stopIgnoring'), () => void this.host.setThemeHold(name, { kind: 'unignore' }));
      note(t('view.themeIgnored'));
    } else if (u?.state === 'snoozed') {
      button(t('view.unsnooze'), () => void this.host.setThemeHold(name, { kind: 'unsnooze' }));
      note(`${t('view.snoozed')} ${t('view.snoozedUntil', { date: new Date(u.until).toLocaleDateString() })}`);
    }
  }

  /** Every plugin that came from the directory, each with a way to go back to an earlier version. */
  private rollbackSection(root: HTMLElement, items: PluginReport[]) {
    if (!items.length) return;
    const sec = root.createDiv({ cls: 'puc-section' });
    const details = sec.createEl('details', { cls: 'puc-rollback' });
    details.createEl('summary', { text: t('view.earlierSection', { count: items.length }) });
    details.createDiv({ cls: 'puc-note', text: t('view.earlierHelp') });
    for (const r of items) {
      const row = details.createDiv({ cls: 'puc-row' });
      const line = this.title(row, r, r.plugin.version);
      const b = line.createDiv({ cls: 'puc-actions' }).createEl('button', { text: t('view.earlierButton') });
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
      this.rowMenu(row, r);
    }
  }

  /** Right-click (or long-press) on a row offers the earlier versions of that plugin and, for an update, to snooze it. */
  private rowMenu(row: HTMLElement, r: PluginReport) {
    row.addEventListener('contextmenu', (evt) => {
      const extra = this.host.extraActions(r);
      if (!r.repo && !snoozable(r) && !extra.length) return;
      evt.preventDefault();
      const menu = new Menu();
      if (r.repo) menu.addItem((item) => item.setTitle(t('view.earlierMenu')).setIcon('history').onClick(() => this.host.rollback(r.plugin.id)));
      if (snoozable(r)) this.addSnoozeItems(menu, r);
      if (extra.length) menu.addSeparator();
      for (const action of extra) {
        menu.addItem((item) => {
          item.setTitle(action.label).onClick(() => void Promise.resolve(action.run()).catch((e: unknown) => console.error('update-radar: a row action failed', e)));
          if (action.icon) item.setIcon(action.icon);
        });
      }
      menu.showAtMouseEvent(evt);
    });
  }

  private addSnoozeItems(menu: Menu, r: PluginReport) {
    for (const days of SNOOZE_DAYS) {
      menu.addItem((item) => item.setTitle(t('view.snoozeFor', { days: dayLabel(days) })).setIcon('bell-off').onClick(() => void this.host.snooze(r.plugin.id, days)));
    }
  }

  /** A button that opens the list of snooze lengths. */
  private snoozeButton(actions: HTMLElement, r: PluginReport) {
    const b = actions.createEl('button', { text: t('view.snooze') });
    b.addEventListener('click', (evt) => {
      const menu = new Menu();
      this.addSnoozeItems(menu, r);
      menu.showAtMouseEvent(evt);
    });
  }

  private title(row: HTMLElement, r: PluginReport, detail: string) {
    const line = row.createDiv({ cls: 'puc-line' });
    line.createSpan({ cls: 'puc-name', text: r.plugin.name });
    line.createSpan({ cls: 'puc-ver', text: detail });
    // A plain link: nothing is requested until the user clicks it.
    const inspect = line.createEl('a', { cls: 'puc-inspect', text: t('view.inspect'), href: inspectUrl(r.plugin.id) });
    inspect.setAttr('target', '_blank');
    inspect.setAttr('rel', 'noopener');
    inspect.setAttr('aria-label', t('view.inspectLabel', { name: r.plugin.name }));
    return line;
  }

  private updateRow(row: HTMLElement, r: PluginReport) {
    const line = this.title(row, r, `${r.plugin.version} → ${r.update?.available ?? ''}`);
    const actions = line.createDiv({ cls: 'puc-actions' });
    const up = actions.createEl('button', { text: t('view.update'), cls: 'mod-cta' });
    up.disabled = this.host.updating;
    up.addEventListener('click', () => {
      up.disabled = true;
      up.setText(t('view.updating'));
      void this.host.update(r).then((ok) => {
        if (!ok) {
          up.disabled = false;
          up.setText(t('view.update'));
        }
      });
    });
    const back = actions.createEl('button', { attr: { 'aria-label': t('view.earlierLabel') }, cls: 'clickable-icon puc-back' });
    setIcon(back, 'history');
    back.addEventListener('click', () => this.host.rollback(r.plugin.id));
    this.snoozeButton(actions, r);
    const skip = actions.createEl('button', { text: t('view.ignore') });
    skip.addEventListener('click', () => void this.host.ignore(r.plugin.id, r.update?.available ?? ''));

    const notes = row.createEl('details', { cls: 'puc-notes' });
    const summary = notes.createEl('summary');
    setIcon(summary.createSpan({ cls: 'puc-chev' }), 'file-text');
    summary.createSpan({ text: ` ${t('view.releaseNotes')}` });
    let loaded = false;
    notes.addEventListener('toggle', () => {
      if (!notes.open || loaded || !r.update) return;
      loaded = true;
      const body = notes.createDiv({ cls: 'puc-notes-body', text: t('view.loading') });
      void this.host.release(r.repo, r.update.available).then(async (info) => {
        body.empty();
        if (!info) {
          body.setText(t('view.noReleaseNotes'));
          return;
        }
        if (info.published) body.createDiv({ cls: 'puc-note', text: t('view.released', { date: new Date(info.published).toLocaleDateString() }) });
        if (info.body) await MarkdownRenderer.render(this.app, neutralizeNotes(info.body), body.createDiv(), '', this);
        else body.createDiv({ cls: 'puc-note', text: t('view.authorNoNotes') });
        const link = body.createEl('a', { text: t('view.openOnGitHub'), href: info.url });
        link.setAttr('target', '_blank');
      });
    });
  }
}
