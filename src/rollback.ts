// Pure logic for installing an earlier version of a plugin from its GitHub
// releases: reading the release list, choosing the files to download,
// comparing against the running app and writing the files without ever leaving
// a half-installed plugin. No `obsidian` import, so tests/ run it under Node.
import { compareVersions, isNewer, parseVersion } from './version.ts';

export const MAX_RELEASES = 30;

/** The three files a plugin is made of. `styles.css` is optional. */
export const MAIN = 'main.js';
export const MANIFEST = 'manifest.json';
export const STYLES = 'styles.css';

export interface ReleaseAsset {
  name: string;
  url: string;
}

export interface ReleaseEntry {
  tag: string;
  /** The tag without a leading "v": what the user sees as the version. */
  version: string;
  name: string;
  /** Release notes as Markdown (empty when the author wrote none). */
  body: string;
  /** ISO date, or '' when unknown. */
  published: string;
  url: string;
  draft: boolean;
  prerelease: boolean;
  assets: ReleaseAsset[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** `v1.2.3` -> `1.2.3`. */
export function versionFromTag(tag: string): string {
  return tag.trim().replace(/^v(?=\d)/i, '');
}

/** The GitHub "list releases" response. Entries without a tag are dropped; nothing throws. */
export function parseReleaseList(json: unknown): ReleaseEntry[] {
  if (!Array.isArray(json)) return [];
  const out: ReleaseEntry[] = [];
  for (const item of json as unknown[]) {
    if (!isObject(item)) continue;
    const tag = str(item.tag_name).trim();
    if (!tag) continue;
    const assets: ReleaseAsset[] = [];
    if (Array.isArray(item.assets)) {
      for (const a of item.assets as unknown[]) {
        if (isObject(a) && str(a.name) && str(a.browser_download_url)) assets.push({ name: str(a.name), url: str(a.browser_download_url) });
      }
    }
    out.push({
      tag,
      version: versionFromTag(tag),
      name: str(item.name),
      body: str(item.body).trim(),
      published: str(item.published_at) || str(item.created_at),
      url: str(item.html_url),
      draft: item.draft === true,
      prerelease: item.prerelease === true,
      assets,
    });
  }
  return out;
}

/** Drops drafts always, and pre-releases unless asked; keeps at most `MAX_RELEASES`. Expects a sorted list. */
export function filterReleases(list: readonly ReleaseEntry[], includePrereleases: boolean): ReleaseEntry[] {
  return list.filter((r) => !r.draft && (includePrereleases || !r.prerelease)).slice(0, MAX_RELEASES);
}

/** Newest first: real versions by version (date as tie-break), then tags that are not versions, newest date first. Does not mutate. */
export function sortReleases(list: readonly ReleaseEntry[]): ReleaseEntry[] {
  const time = (r: ReleaseEntry) => Date.parse(r.published) || 0;
  const isVer = (r: ReleaseEntry) => parseVersion(r.version) !== null;
  return [...list].sort((a, b) => {
    const av = isVer(a);
    const bv = isVer(b);
    if (av !== bv) return av ? -1 : 1;
    const c = av ? (compareVersions(b.version, a.version) ?? 0) : 0;
    return c || time(b) - time(a);
  });
}

/** Releases for the picker: sorted, de-duplicated by version, filtered and capped. */
export function releaseChoices(json: unknown, includePrereleases: boolean): ReleaseEntry[] {
  const seen = new Set<string>();
  const unique = sortReleases(parseReleaseList(json)).filter((r) => {
    if (seen.has(r.version)) return false;
    seen.add(r.version);
    return true;
  });
  return filterReleases(unique, includePrereleases);
}

/** True when `minAppVersion` is a version newer than the running app. Empty or unreadable means "no floor". */
export function needsNewerApp(minAppVersion: string, appVersion: string): boolean {
  if (!minAppVersion || !parseVersion(minAppVersion)) return false;
  return isNewer(minAppVersion, appVersion);
}

/** True when `version` is the one installed (compared as versions, so `v1.0` and `1.0.0` match). */
export function isInstalledVersion(version: string, installed: string): boolean {
  return version === installed || compareVersions(version, installed) === 0;
}

export interface AssetSelection {
  main: ReleaseAsset;
  manifest: ReleaseAsset;
  styles: ReleaseAsset | null;
}

/**
 * Picks the plugin files from a release's assets by exact name. `main.js` and
 * `manifest.json` are required (null otherwise); `styles.css` is optional. Only
 * downloads from the plugin's own repository are accepted.
 */
export function selectAssets(release: ReleaseEntry, repo: string): AssetSelection | null {
  // GitHub treats owner and repo names case-insensitively, and the directory's spelling can differ from the release URLs'.
  const prefix = `https://github.com/${repo}/releases/download/`.toLowerCase();
  const find = (name: string) => release.assets.find((a) => a.name === name && a.url.toLowerCase().startsWith(prefix)) ?? null;
  const main = find(MAIN);
  const manifest = find(MANIFEST);
  if (!main || !manifest) return null;
  return { main, manifest, styles: find(STYLES) };
}

/**
 * Which version the radar should stop mentioning after a rollback. It is the
 * newest version the user has seen offered (the latest release if known, else
 * the installed one), because the point is to stop nagging about the version
 * that was rolled back from. Null when `target` is not older than `installed`.
 */
export function versionToIgnore(installed: string, latest: string | null, target: string): string | null {
  if (compareVersions(target, installed) !== -1) return null;
  if (latest && compareVersions(latest, installed) === 1) return latest;
  return installed;
}

/** First readable line of the notes as plain text, for a one-line preview. */
export function notesPreview(markdown: string, max = 140): string {
  const cleaned = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|>|\d+\.)[ \t]+/gm, '')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1).replace(/\s+$/, '')}…` : cleaned;
}

export type ManifestCheck = { ok: true; manifest: Record<string, unknown>; minAppVersion: string } | { ok: false; error: string };

/**
 * Reads a downloaded `manifest.json` and refuses it unless it is JSON, belongs
 * to the plugin being rolled back and does not need a newer app than the
 * running one. Nothing is written before this passes.
 */
export function checkManifest(text: string, pluginId: string, appVersion: string): ManifestCheck {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'manifest.json in that release is not valid JSON.' };
  }
  if (!isObject(json)) return { ok: false, error: 'manifest.json in that release is not valid.' };
  if (str(json.id) !== pluginId) return { ok: false, error: `That release is for a different plugin (${str(json.id) || 'no id'}).` };
  if (!str(json.version)) return { ok: false, error: 'manifest.json in that release has no version.' };
  const minAppVersion = str(json.minAppVersion);
  if (needsNewerApp(minAppVersion, appVersion)) return { ok: false, error: `That version needs Obsidian ${minAppVersion}; you have ${appVersion}.` };
  return { ok: true, manifest: json, minAppVersion };
}

/** What `applyFiles` needs from the vault adapter. */
export interface FileAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface NewFiles {
  main: string;
  manifest: string;
  /** Null when the release has no styles.css: any existing one is removed, as it belongs to the newer version. */
  styles: string | null;
}

const NAMES = [MAIN, MANIFEST, STYLES] as const;

/**
 * Writes the new files into `dir`, keeping the current three in memory first.
 * If any write fails, everything is put back as it was and the error is
 * rethrown, so the folder is never left half old and half new. Nothing else in
 * the folder (notably `data.json`) is read or touched.
 */
export async function applyFiles(adapter: FileAdapter, dir: string, files: NewFiles): Promise<void> {
  const target: Record<(typeof NAMES)[number], string | null> = { [MAIN]: files.main, [MANIFEST]: files.manifest, [STYLES]: files.styles };
  const backup: Record<string, string | null> = {};
  for (const n of NAMES) {
    const p = `${dir}/${n}`;
    backup[n] = (await adapter.exists(p)) ? await adapter.read(p) : null;
  }
  try {
    // The manifest goes last: it is what names the version, so a failure earlier never leaves it ahead of the code.
    for (const n of [MAIN, STYLES, MANIFEST] as const) {
      const p = `${dir}/${n}`;
      const next = target[n];
      if (next === null) {
        if (backup[n] !== null) await adapter.remove(p);
      } else {
        await adapter.write(p, next);
      }
    }
  } catch (e) {
    const failures: string[] = [];
    for (const n of NAMES) {
      const p = `${dir}/${n}`;
      try {
        if (backup[n] === null) {
          if (await adapter.exists(p)) await adapter.remove(p);
        } else {
          await adapter.write(p, backup[n]);
        }
      } catch {
        failures.push(n);
      }
    }
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(failures.length ? `${reason} (and could not restore ${failures.join(', ')})` : reason);
  }
}
