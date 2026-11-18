// Community theme updates. Pure logic, no `obsidian` import: the network, the
// vault adapter and the app version come in as arguments, so tests/ can run it.
//
// It follows what Obsidian itself does in Settings → Appearance → Themes →
// "Check for updates" and when it installs a theme:
// - installed themes are the folders `<configDir>/themes/<name>/` that hold a
//   `theme.css` and a `manifest.json` whose `name` is the folder name;
// - the repository comes from `community-css-themes.json` (matched by name);
// - the latest version is the `manifest.json` on the repository's default
//   branch; when that one needs a newer Obsidian, `versions.json` on the same
//   branch names the newest version this Obsidian can run;
// - the files come from the GitHub release named after that version
//   (`theme.css`, `manifest.json`), or, when the release has no manifest, from
//   the default branch.
import { classifyUpdate } from './check.ts';
import type { InstalledPlugin, UpdateCheck } from './check.ts';
import { DAY_MS, MAX_SNOOZE_DAYS, NO_HOLDS, nextSeen, parseSeen, parseSnoozed, pruneSnoozed } from './holds.ts';
import type { Holds, SeenEntry } from './holds.ts';
import { t } from './i18n.ts';
import type { FileAdapter } from './rollback.ts';
import { compareVersions, isNewer, parseVersion } from './version.ts';
import { parseManifest } from './sources.ts';
import type { RemoteManifest } from './sources.ts';

export const THEME_CSS = 'theme.css';
export const THEME_MANIFEST = 'manifest.json';
export const THEMES_URL = 'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD/community-css-themes.json';

export interface ThemeEntry {
  name: string;
  repo: string;
  /** Pre-0.16 themes (a single `obsidian.css`, no manifest). Update Radar does not check them. */
  legacy: boolean;
}

/** One installed theme. `version` is '' when its manifest has none (Obsidian then always offers the update). */
export type InstalledTheme = InstalledPlugin;

export interface ThemeReport {
  theme: InstalledTheme;
  /** GitHub `owner/name`, when the theme directory lists it. */
  repo: string;
  /** Null when no manifest was read (not listed, legacy, or the request failed). */
  update: (UpdateCheck & { remote: RemoteManifest }) | null;
  /** True when the manifest request failed, so "no update" would be a guess. */
  failed: boolean;
}

/** The theme part of the settings: the same holds as plugins, keyed by theme name. */
export interface ThemeHolds {
  ignored: Record<string, string>;
  snoozed: Record<string, number>;
  seen: Record<string, SeenEntry>;
}

/** What the theme code needs from the network and the vault. */
export interface ThemeIO {
  fetchJson(url: string): Promise<unknown>;
  fetchText(url: string): Promise<string>;
}

export interface ThemeAdapter extends FileAdapter {
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const basename = (path: string) => path.split('/').pop() ?? '';

/** The same rule Obsidian applies before it writes a theme folder: one plain path segment. */
export function isSafeThemeName(name: string): boolean {
  return name !== '' && name !== '__proto__' && !/[\\/]/.test(name) && !name.includes('..') && !name.startsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name);
}

/** `community-css-themes.json`: a list of { name, repo, legacy?, ... }, keyed by name. */
export function parseThemeDirectory(json: unknown): Map<string, ThemeEntry> {
  const out = new Map<string, ThemeEntry>();
  if (!Array.isArray(json)) return out;
  for (const item of json as unknown[]) {
    if (!isObject(item)) continue;
    const name = str(item.name);
    const repo = str(item.repo);
    if (name && /^[\w.-]+\/[\w.-]+$/.test(repo)) out.set(name, { name, repo, legacy: item.legacy === true });
  }
  return out;
}

/** An installed theme's `manifest.json`, or null when it is unreadable or names another theme than its folder. */
export function parseInstalledTheme(text: string, folder: string): InstalledTheme | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(json) || str(json.name) !== folder || !isSafeThemeName(folder)) return null;
  return { id: folder, name: folder, version: str(json.version) };
}

/** Every theme folder in `<configDir>/themes` that Obsidian would list. Unreadable folders are skipped. */
export async function listInstalledThemes(adapter: ThemeAdapter, configDir: string): Promise<InstalledTheme[]> {
  const root = `${configDir}/themes`;
  if (!(await adapter.exists(root))) return [];
  const out: InstalledTheme[] = [];
  for (const dir of (await adapter.list(root)).folders) {
    const folder = basename(dir);
    try {
      if (!(await adapter.exists(`${root}/${folder}/${THEME_CSS}`))) continue;
      const theme = parseInstalledTheme(await adapter.read(`${root}/${folder}/${THEME_MANIFEST}`), folder);
      if (theme) out.push(theme);
    } catch {
      // A folder without a readable manifest is not a theme Obsidian lists either.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const headUrl = (repo: string, file: string) => `https://raw.githubusercontent.com/${repo}/HEAD/${file}`;
const releaseUrl = (repo: string, version: string, file: string) => `https://github.com/${repo}/releases/download/${version}/${file}`;

/**
 * The version to offer, given the manifest on the default branch and, when that
 * one needs a newer Obsidian, the theme's `versions.json` (version -> minAppVersion).
 * Like Obsidian, the newest version whose floor this app meets wins; when there
 * is none (or no readable `versions.json`), the head manifest comes back and is
 * classified as blocked.
 */
export function pickThemeTarget(head: RemoteManifest, appVersion: string, versions: unknown): RemoteManifest {
  if (!head.minAppVersion || compareVersions(head.minAppVersion, appVersion) !== 1 || !isObject(versions)) return head;
  let best: RemoteManifest | null = null;
  for (const [version, floor] of Object.entries(versions)) {
    if (typeof floor !== 'string' || compareVersions(floor, appVersion) === 1 || !parseVersion(version)) continue;
    if (!best || isNewer(version, best.version)) best = { version, minAppVersion: floor, raw: { version, minAppVersion: floor } };
  }
  return best ?? head;
}

/** Reads the latest version of one listed theme. Null when it could not be read or names another theme. */
export async function fetchThemeTarget(io: ThemeIO, entry: ThemeEntry, appVersion: string): Promise<RemoteManifest | null> {
  let json: unknown;
  try {
    json = await io.fetchJson(headUrl(entry.repo, THEME_MANIFEST));
  } catch {
    return null;
  }
  const head = parseManifest(json);
  if (!head || !isObject(json) || str(json.name) !== entry.name) return null;
  if (!head.minAppVersion || compareVersions(head.minAppVersion, appVersion) !== 1) return head;
  let versions: unknown = null;
  try {
    versions = await io.fetchJson(headUrl(entry.repo, 'versions.json'));
  } catch {
    versions = null;
  }
  return pickThemeTarget(head, appVersion, versions);
}

/**
 * The latest version of every installed theme the directory lists (legacy
 * themes are left out), four requests at a time. A theme that is not listed is
 * not in the map; one whose manifest could not be read maps to null.
 */
export async function fetchThemeTargets(io: ThemeIO, installed: readonly InstalledTheme[], directory: ReadonlyMap<string, ThemeEntry>, appVersion: string): Promise<Map<string, RemoteManifest | null>> {
  const out = new Map<string, RemoteManifest | null>();
  const queue = installed.filter((th) => directory.has(th.name) && !directory.get(th.name)?.legacy);
  const worker = async () => {
    for (let th = queue.shift(); th; th = queue.shift()) {
      const entry = directory.get(th.name);
      if (entry) out.set(th.name, await fetchThemeTarget(io, entry, appVersion));
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return out;
}

const asHolds = (h: ThemeHolds, minAgeDays: number): Holds => ({ ignored: h.ignored, snoozed: h.snoozed, seen: h.seen, minAgeDays });

/** The theme list, classified with the same rules as plugins (snooze, ignore, minAppVersion, wait). Sorted by name. */
export function buildThemeReports(
  installed: readonly InstalledTheme[],
  directory: ReadonlyMap<string, ThemeEntry>,
  remotes: ReadonlyMap<string, RemoteManifest | null>,
  appVersion: string,
  holds: ThemeHolds,
  minAgeDays: number,
  now: number,
): ThemeReport[] {
  return installed
    .map((theme): ThemeReport => {
      const remote = remotes.get(theme.name) ?? null;
      return {
        theme,
        repo: directory.get(theme.name)?.repo ?? '',
        update: remote ? { ...classifyUpdate(theme, remote, appVersion, asHolds(holds, minAgeDays), now), remote } : null,
        failed: remotes.has(theme.name) && remote === null,
      };
    })
    .sort((a, b) => a.theme.name.localeCompare(b.theme.name));
}

/** The theme holds after a check: ended snoozes and those of uninstalled themes go, and the wait clock moves on. */
export function nextThemeHolds(holds: ThemeHolds, installed: readonly InstalledTheme[], remotes: ReadonlyMap<string, RemoteManifest | null>, appVersion: string, now: number): ThemeHolds {
  const latest = new Map<string, string | null>();
  for (const theme of installed) {
    if (!remotes.has(theme.name)) continue;
    const remote = remotes.get(theme.name) ?? null;
    if (!remote) latest.set(theme.name, null);
    else if (classifyUpdate(theme, remote, appVersion, NO_HOLDS, 0).state !== 'current') latest.set(theme.name, remote.version);
  }
  return {
    ignored: holds.ignored,
    snoozed: pruneSnoozed(holds.snoozed, new Set(installed.map((th) => th.name)), now),
    seen: nextSeen(holds.seen, latest, now),
  };
}

/** The theme holds from stored data; anything malformed is dropped. */
export function parseThemeHolds(value: unknown, now: number): ThemeHolds {
  const v = isObject(value) ? value : {};
  const ignored: Record<string, string> = {};
  if (isObject(v.ignored)) for (const [name, version] of Object.entries(v.ignored)) if (typeof version === 'string' && version) ignored[name] = version;
  return { ignored, snoozed: pruneSnoozed(parseSnoozed(v.snoozed, now), null, now), seen: parseSeen(v.seen) };
}

export type ThemeHoldChange = { kind: 'ignore'; version: string } | { kind: 'unignore' } | { kind: 'snooze'; days: number } | { kind: 'unsnooze' };

/** A copy of `holds` with one change for one theme. A snooze is capped at 366 days. */
export function changeThemeHold(holds: ThemeHolds, name: string, change: ThemeHoldChange, now: number): ThemeHolds {
  const next: ThemeHolds = { ignored: { ...holds.ignored }, snoozed: { ...holds.snoozed }, seen: holds.seen };
  if (change.kind === 'ignore') next.ignored[name] = change.version;
  else if (change.kind === 'unignore') delete next.ignored[name];
  else if (change.kind === 'snooze') next.snoozed[name] = now + Math.min(Math.max(change.days, 0), MAX_SNOOZE_DAYS) * DAY_MS;
  else delete next.snoozed[name];
  return next;
}

/** Themes with an update the user can install now. */
export function pendingThemes(reports: readonly ThemeReport[]): ThemeReport[] {
  return reports.filter((r) => r.update?.state === 'update');
}

export interface ThemeFiles {
  manifest: string;
  css: string;
  /** The version the downloaded manifest names. */
  version: string;
}

/** Checks downloaded files before anything is written: same theme, a version, a floor this app meets, some CSS. */
export function checkThemeFiles(manifest: string, css: string, name: string, appVersion: string): { ok: true; files: ThemeFiles } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(manifest);
  } catch {
    return { ok: false, error: t('error.themeManifestInvalid') };
  }
  if (!isObject(json)) return { ok: false, error: t('error.themeManifestInvalid') };
  if (str(json.name) !== name) return { ok: false, error: t('error.themeNameMismatch', { name: str(json.name) || '-' }) };
  const version = str(json.version);
  if (!version) return { ok: false, error: t('error.themeManifestInvalid') };
  const floor = str(json.minAppVersion);
  if (floor && compareVersions(floor, appVersion) === 1) return { ok: false, error: t('error.needsNewerApp', { required: floor, current: appVersion }) };
  if (!css.trim()) return { ok: false, error: t('error.themeCssEmpty') };
  return { ok: true, files: { manifest, css, version } };
}

const is404 = (e: unknown) => e instanceof Error && /^404\b/.test(e.message);

/**
 * Downloads `version` of a theme the way Obsidian does: `manifest.json` and
 * `theme.css` from the GitHub release of that name; if the release has no
 * manifest (404), both from the default branch. Both files are checked before
 * this returns; it throws with the reason otherwise, and writes nothing.
 */
export async function downloadTheme(io: ThemeIO, name: string, repo: string, version: string, appVersion: string): Promise<ThemeFiles> {
  let manifest: string | null = null;
  let css: string;
  try {
    manifest = await io.fetchText(releaseUrl(repo, version, THEME_MANIFEST));
    css = await io.fetchText(releaseUrl(repo, version, THEME_CSS));
  } catch (e) {
    if (manifest !== null || !is404(e)) throw e;
    manifest = await io.fetchText(headUrl(repo, THEME_MANIFEST));
    css = await io.fetchText(headUrl(repo, THEME_CSS));
  }
  const checked = checkThemeFiles(manifest, css, name, appVersion);
  if (!checked.ok) throw new Error(checked.error);
  return checked.files;
}

/**
 * Writes `theme.css`, then `manifest.json` (it names the version, so it goes
 * last), keeping the old two in memory first. If a write fails both are put
 * back and the error is rethrown. Nothing else in the folder is touched.
 */
export async function writeThemeFiles(adapter: FileAdapter, dir: string, files: ThemeFiles): Promise<void> {
  const names = [THEME_CSS, THEME_MANIFEST] as const;
  const backup: Record<string, string | null> = {};
  for (const n of names) backup[n] = (await adapter.exists(`${dir}/${n}`)) ? await adapter.read(`${dir}/${n}`) : null;
  try {
    await adapter.write(`${dir}/${THEME_CSS}`, files.css);
    await adapter.write(`${dir}/${THEME_MANIFEST}`, files.manifest);
  } catch (e) {
    const failures: string[] = [];
    for (const n of names) {
      try {
        const old = backup[n];
        if (old === null) {
          if (await adapter.exists(`${dir}/${n}`)) await adapter.remove(`${dir}/${n}`);
        } else {
          await adapter.write(`${dir}/${n}`, old);
        }
      } catch {
        failures.push(n);
      }
    }
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(failures.length ? `${reason} (and could not restore ${failures.join(', ')})` : reason);
  }
}

/** "2 plugin updates · 1 theme update": the status bar text, '' when there is nothing. */
export function statusText(plugins: number, themes: number): string {
  const parts: string[] = [];
  if (plugins) parts.push(plugins === 1 ? t('status.updates.one') : t('status.updates.other', { count: plugins }));
  if (themes) parts.push(themes === 1 ? t('status.themeUpdates.one') : t('status.themeUpdates.other', { count: themes }));
  return parts.join(' · ');
}

/** The notice after a check the user asked for. `themesChecked` is false when the theme check is off or found no theme. */
export function checkedNotice(plugins: number, themes: number, themesChecked: boolean): string {
  const parts: string[] = [];
  if (plugins) parts.push(plugins === 1 ? t('notice.updatesAvailable.one') : t('notice.updatesAvailable.other', { count: plugins }));
  if (themes) parts.push(themes === 1 ? t('notice.themeUpdatesAvailable.one') : t('notice.themeUpdatesAvailable.other', { count: themes }));
  if (parts.length) return parts.join(' ');
  return themesChecked ? t('notice.upToDateAll') : t('notice.upToDate');
}
