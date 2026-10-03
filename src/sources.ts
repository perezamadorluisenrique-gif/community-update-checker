// Parsing of the JSON the plugin reads. Everything arrives as `unknown`: these
// are files other people publish, so each reader checks its shapes and drops
// what it does not understand instead of throwing.

export interface DirectoryEntry {
  id: string;
  name: string;
  repo: string;
}

export interface RemoteManifest {
  version: string;
  minAppVersion: string;
  /** The manifest as published, handed to the installer unchanged. */
  raw: Record<string, unknown>;
}

export interface ReleaseInfo {
  /** Release notes as Markdown; empty when the author wrote none. */
  body: string;
  /** ISO date, or '' when unknown. */
  published: string;
  url: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** `community-plugins.json`: a list of { id, name, repo, ... }. */
export function parseDirectory(json: unknown): Map<string, DirectoryEntry> {
  const out = new Map<string, DirectoryEntry>();
  if (!Array.isArray(json)) return out;
  for (const item of json as unknown[]) {
    if (!isObject(item)) continue;
    const id = str(item.id);
    const repo = str(item.repo);
    if (id && /^[\w.-]+\/[\w.-]+$/.test(repo)) out.set(id, { id, name: str(item.name) || id, repo });
  }
  return out;
}

/** `community-plugins-removed.json`: a list of { id, reason, ... }. Maps id to the reason ('' if none). */
export function parseRemoved(json: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(json)) return out;
  for (const item of json as unknown[]) {
    if (isObject(item) && str(item.id)) out.set(str(item.id), str(item.reason));
  }
  return out;
}

/** `community-plugin-stats.json`: id -> { updated: ms timestamp of the last release, ... }. Maps id to that timestamp. */
export function parseUpdated(json: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!isObject(json)) return out;
  for (const [id, entry] of Object.entries(json)) {
    if (isObject(entry) && typeof entry.updated === 'number' && Number.isFinite(entry.updated)) out.set(id, entry.updated);
  }
  return out;
}

/** A plugin's `manifest.json`. Needs a version; a missing `minAppVersion` means "no floor". */
export function parseManifest(json: unknown): RemoteManifest | null {
  if (!isObject(json)) return null;
  const version = str(json.version);
  if (!version) return null;
  return { version, minAppVersion: str(json.minAppVersion), raw: json };
}

/** One GitHub release as returned by the API. */
export function parseRelease(json: unknown): ReleaseInfo | null {
  if (!isObject(json)) return null;
  const url = str(json.html_url);
  if (!url) return null;
  return { body: str(json.body).trim(), published: str(json.published_at), url };
}
