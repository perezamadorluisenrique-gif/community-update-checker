import test from 'node:test';
import assert from 'node:assert/strict';

import { DAY_MS } from '../src/holds.ts';
import {
  buildThemeReports,
  changeThemeHold,
  checkThemeFiles,
  checkedNotice,
  downloadTheme,
  fetchThemeTarget,
  fetchThemeTargets,
  isSafeThemeName,
  listInstalledThemes,
  nextThemeHolds,
  parseInstalledTheme,
  parseThemeDirectory,
  parseThemeHolds,
  pendingThemes,
  pickThemeTarget,
  statusText,
  writeThemeFiles,
} from '../src/themes.ts';
import type { ThemeAdapter, ThemeEntry, ThemeHolds, ThemeIO } from '../src/themes.ts';
import type { RemoteManifest } from '../src/sources.ts';

const NOW = Date.UTC(2026, 10, 1);
const APP = '1.9.0';
const NO: ThemeHolds = { ignored: {}, snoozed: {}, seen: {} };
const remote = (version: string, minAppVersion = ''): RemoteManifest => ({ version, minAppVersion, raw: { version, minAppVersion } });
const theme = (name: string, version: string) => ({ id: name, name, version });
const entry = (name: string, repo = `me/${name}`, legacy = false): ThemeEntry => ({ name, repo, legacy });

/** A fake network: url -> value; a function value is called; a missing url is a 404. */
function io(routes: Record<string, unknown>, log: string[] = []): ThemeIO {
  const get = (url: string) => {
    log.push(url);
    if (!(url in routes)) throw new Error(`404 for ${url}`);
    const v = routes[url];
    if (v instanceof Error) throw v;
    return v;
  };
  return { fetchJson: async (url) => get(url), fetchText: async (url) => String(get(url)) };
}

/** A fake vault adapter over a map of path -> text; `failOn` makes writes to that path throw. */
function adapter(files: Record<string, string>, failOn = ''): ThemeAdapter & { files: Record<string, string> } {
  return {
    files,
    exists: async (p) => p in files || Object.keys(files).some((f) => f.startsWith(`${p}/`)),
    read: async (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
    write: async (p, d) => {
      if (p === failOn) throw new Error(`disk full at ${p}`);
      files[p] = d;
    },
    remove: async (p) => {
      delete files[p];
    },
    list: async (p) => {
      const folders = new Set<string>();
      const out: string[] = [];
      for (const f of Object.keys(files)) {
        if (!f.startsWith(`${p}/`)) continue;
        const rest = f.slice(p.length + 1).split('/');
        if (rest.length > 1) folders.add(`${p}/${rest[0]}`);
        else out.push(f);
      }
      return { files: out, folders: [...folders] };
    },
  };
}

test('the theme directory is keyed by name, keeps the legacy flag and drops bad rows', () => {
  const dir = parseThemeDirectory([
    { name: 'Minimal', repo: 'kepano/obsidian-minimal' },
    { name: 'Old', repo: 'a/old', legacy: true },
    { name: 'NoRepo' },
    { name: 'Bad', repo: 'not a repo' },
    'junk',
    null,
  ]);
  assert.deepEqual([...dir.keys()], ['Minimal', 'Old']);
  assert.deepEqual(dir.get('Old'), { name: 'Old', repo: 'a/old', legacy: true });
  assert.equal(dir.get('Minimal')?.legacy, false);
  assert.equal(parseThemeDirectory({ not: 'a list' }).size, 0);
});

test('theme names follow the same safety rule as Obsidian', () => {
  for (const ok of ['Minimal', 'AnuPpuccin', 'Things 2', 'Café']) assert.equal(isSafeThemeName(ok), true, ok);
  for (const bad of ['', '.hidden', '../x', 'a/b', 'a\\b', 'con', 'COM1', 'nul.css', '__proto__']) assert.equal(isSafeThemeName(bad), false, bad);
});

test('an installed manifest must name its own folder; a missing version stays empty', () => {
  assert.deepEqual(parseInstalledTheme('{"name":"Minimal","version":"7.0.0"}', 'Minimal'), theme('Minimal', '7.0.0'));
  assert.deepEqual(parseInstalledTheme('{"name":"Minimal"}', 'Minimal'), theme('Minimal', ''));
  assert.equal(parseInstalledTheme('{"name":"Other","version":"1.0.0"}', 'Minimal'), null);
  assert.equal(parseInstalledTheme('not json', 'Minimal'), null);
  assert.equal(parseInstalledTheme('[]', 'Minimal'), null);
});

test('installed themes are the folders with theme.css and a matching manifest', async () => {
  const a = adapter({
    '.obsidian/themes/Minimal/theme.css': 'body{}',
    '.obsidian/themes/Minimal/manifest.json': '{"name":"Minimal","version":"7.0.0"}',
    '.obsidian/themes/Atom/theme.css': 'x',
    '.obsidian/themes/Atom/manifest.json': '{"name":"Atom","version":"1.0.0"}',
    '.obsidian/themes/NoCss/manifest.json': '{"name":"NoCss","version":"1.0.0"}',
    '.obsidian/themes/NoManifest/theme.css': 'x',
    '.obsidian/themes/Wrong/theme.css': 'x',
    '.obsidian/themes/Wrong/manifest.json': '{"name":"Right","version":"1.0.0"}',
    '.obsidian/themes/legacy.css': 'x',
  });
  assert.deepEqual(await listInstalledThemes(a, '.obsidian'), [theme('Atom', '1.0.0'), theme('Minimal', '7.0.0')]);
  assert.deepEqual(await listInstalledThemes(adapter({}), '.obsidian'), []);
});

test('the head manifest wins while this Obsidian can run it', () => {
  assert.deepEqual(pickThemeTarget(remote('2.0.0', '1.5.0'), APP, { '1.0.0': '0.16.0' }), remote('2.0.0', '1.5.0'));
  assert.deepEqual(pickThemeTarget(remote('2.0.0'), APP, null), remote('2.0.0'));
});

test('a head manifest that needs a newer Obsidian falls back to the newest compatible version in versions.json', () => {
  const versions = { '1.0.0': '0.16.0', '1.4.0': '1.8.0', '1.2.0': '1.0.0', '2.0.0': '2.0.0', 'junk': '0.1.0', '1.3.0': 5 };
  assert.deepEqual(pickThemeTarget(remote('2.0.0', '2.0.0'), APP, versions), { version: '1.4.0', minAppVersion: '1.8.0', raw: { version: '1.4.0', minAppVersion: '1.8.0' } });
  // Nothing compatible, or no versions.json: the head comes back, to be shown as blocked.
  assert.deepEqual(pickThemeTarget(remote('2.0.0', '2.0.0'), APP, { '2.0.0': '2.0.0' }), remote('2.0.0', '2.0.0'));
  assert.deepEqual(pickThemeTarget(remote('2.0.0', '2.0.0'), APP, null), remote('2.0.0', '2.0.0'));
});

test('the latest version is read from the default branch, like Obsidian', async () => {
  const log: string[] = [];
  const net = io({ 'https://raw.githubusercontent.com/me/Minimal/HEAD/manifest.json': { name: 'Minimal', version: '7.1.0', minAppVersion: '1.0.0' } }, log);
  assert.deepEqual((await fetchThemeTarget(net, entry('Minimal'), APP))?.version, '7.1.0');
  assert.deepEqual(log, ['https://raw.githubusercontent.com/me/Minimal/HEAD/manifest.json']);
});

test('versions.json is only read when the head manifest needs a newer Obsidian', async () => {
  const log: string[] = [];
  const net = io(
    {
      'https://raw.githubusercontent.com/me/T/HEAD/manifest.json': { name: 'T', version: '3.0.0', minAppVersion: '9.0.0' },
      'https://raw.githubusercontent.com/me/T/HEAD/versions.json': { '2.5.0': '1.0.0', '3.0.0': '9.0.0' },
    },
    log,
  );
  assert.equal((await fetchThemeTarget(net, entry('T'), APP))?.version, '2.5.0');
  assert.equal(log.length, 2);
  // Without a versions.json the head is kept (and is then blocked).
  const noVersions = io({ 'https://raw.githubusercontent.com/me/T/HEAD/manifest.json': { name: 'T', version: '3.0.0', minAppVersion: '9.0.0' } });
  assert.deepEqual(await fetchThemeTarget(noVersions, entry('T'), APP), { version: '3.0.0', minAppVersion: '9.0.0', raw: { name: 'T', version: '3.0.0', minAppVersion: '9.0.0' } });
});

test('a head manifest for another theme, without a version, or unreachable gives null', async () => {
  const url = 'https://raw.githubusercontent.com/me/T/HEAD/manifest.json';
  assert.equal(await fetchThemeTarget(io({ [url]: { name: 'Other', version: '1.0.0' } }), entry('T'), APP), null);
  assert.equal(await fetchThemeTarget(io({ [url]: { name: 'T' } }), entry('T'), APP), null);
  assert.equal(await fetchThemeTarget(io({}), entry('T'), APP), null);
});

test('only listed, non-legacy themes are checked; a failed one maps to null', async () => {
  const log: string[] = [];
  const net = io({ 'https://raw.githubusercontent.com/me/A/HEAD/manifest.json': { name: 'A', version: '2.0.0' } }, log);
  const dir = new Map([['A', entry('A')], ['B', entry('B')], ['Old', entry('Old', 'me/Old', true)]]);
  const got = await fetchThemeTargets(net, [theme('A', '1.0.0'), theme('B', '1.0.0'), theme('Old', '0.0.0'), theme('Mine', '1.0.0')], dir, APP);
  assert.deepEqual([...got.keys()].sort(), ['A', 'B']);
  assert.equal(got.get('A')?.version, '2.0.0');
  assert.equal(got.get('B'), null);
  assert.equal(log.some((u) => u.includes('/Old/') || u.includes('/Mine/')), false);
});

test('theme reports use the plugin rules: update, blocked, ignored, snoozed, waiting, current, failed', () => {
  const installed = ['Up', 'Blocked', 'Ignored', 'Snoozed', 'Waiting', 'Current', 'Failed', 'Unlisted', 'NoVersion'].map((n) => theme(n, n === 'NoVersion' ? '' : '1.0.0'));
  const dir = new Map(installed.filter((th) => th.name !== 'Unlisted').map((th) => [th.name, entry(th.name)]));
  const remotes = new Map<string, RemoteManifest | null>([
    ['Up', remote('1.1.0')],
    ['Blocked', remote('2.0.0', '9.0.0')],
    ['Ignored', remote('1.2.0')],
    ['Snoozed', remote('1.3.0')],
    ['Waiting', remote('1.4.0')],
    ['Current', remote('1.0.0')],
    ['Failed', null],
    ['NoVersion', remote('0.1.0')],
  ]);
  const holds: ThemeHolds = { ignored: { Ignored: '1.2.0' }, snoozed: { Snoozed: NOW + DAY_MS }, seen: { Waiting: { version: '1.4.0', at: NOW - DAY_MS }, Up: { version: '1.1.0', at: NOW - 10 * DAY_MS }, NoVersion: { version: '0.1.0', at: NOW - 10 * DAY_MS } } };
  const reports = buildThemeReports(installed, dir, remotes, APP, holds, 3, NOW);
  const state = Object.fromEntries(reports.map((r) => [r.theme.name, r.failed ? 'failed' : (r.update?.state ?? 'none')]));
  assert.deepEqual(state, { Blocked: 'blocked', Current: 'current', Failed: 'failed', Ignored: 'ignored', NoVersion: 'update', Snoozed: 'snoozed', Unlisted: 'none', Up: 'update', Waiting: 'waiting' });
  assert.deepEqual(reports.map((r) => r.theme.name), [...installed.map((th) => th.name)].sort((a, b) => a.localeCompare(b)));
  assert.equal(reports.find((r) => r.theme.name === 'Blocked')?.update?.requires, '9.0.0');
  assert.equal(reports.find((r) => r.theme.name === 'Unlisted')?.repo, '');
  assert.deepEqual(pendingThemes(reports).map((r) => r.theme.name), ['NoVersion', 'Up']);
});

test('after a check, theme holds drop ended snoozes and uninstalled themes, and start the wait clock', () => {
  const holds: ThemeHolds = {
    ignored: { A: '2.0.0' },
    snoozed: { A: NOW + DAY_MS, Gone: NOW + DAY_MS, Ended: NOW - 1 },
    seen: { A: { version: '1.5.0', at: 1 }, B: { version: '3.0.0', at: 5 }, C: { version: '1.0.0', at: 7 } },
  };
  const installed = [theme('A', '1.0.0'), theme('B', '1.0.0'), theme('C', '1.0.0'), theme('Ended', '1.0.0')];
  const remotes = new Map<string, RemoteManifest | null>([['A', remote('2.0.0')], ['B', null], ['C', remote('1.0.0')]]);
  const next = nextThemeHolds(holds, installed, remotes, APP, NOW);
  assert.deepEqual(next.ignored, { A: '2.0.0' });
  assert.deepEqual(next.snoozed, { A: NOW + DAY_MS });
  assert.deepEqual(next.seen, { A: { version: '2.0.0', at: NOW }, B: { version: '3.0.0', at: 5 } });
});

test('stored theme holds are parsed defensively', () => {
  assert.deepEqual(parseThemeHolds(undefined, NOW), NO);
  assert.deepEqual(parseThemeHolds('junk', NOW), NO);
  const got = parseThemeHolds({ ignored: { A: '1.0.0', B: 3, C: '' }, snoozed: { A: NOW + DAY_MS, B: 'x', C: NOW - 1, D: NOW + 9999 * DAY_MS }, seen: { A: { version: '1.0.0', at: 3 }, B: { at: 1 } } }, NOW);
  assert.deepEqual(got.ignored, { A: '1.0.0' });
  assert.deepEqual(got.snoozed, { A: NOW + DAY_MS, D: NOW + 366 * DAY_MS });
  assert.deepEqual(got.seen, { A: { version: '1.0.0', at: 3 } });
});

test('changing a theme hold returns a copy and caps a snooze at 366 days', () => {
  const ignored = changeThemeHold(NO, 'A', { kind: 'ignore', version: '2.0.0' }, NOW);
  assert.deepEqual(ignored.ignored, { A: '2.0.0' });
  assert.deepEqual(NO.ignored, {});
  assert.deepEqual(changeThemeHold(ignored, 'A', { kind: 'unignore' }, NOW).ignored, {});
  assert.equal(changeThemeHold(NO, 'A', { kind: 'snooze', days: 7 }, NOW).snoozed.A, NOW + 7 * DAY_MS);
  assert.equal(changeThemeHold(NO, 'A', { kind: 'snooze', days: 5000 }, NOW).snoozed.A, NOW + 366 * DAY_MS);
  assert.equal(changeThemeHold(NO, 'A', { kind: 'snooze', days: -3 }, NOW).snoozed.A, NOW);
  assert.deepEqual(changeThemeHold({ ...NO, snoozed: { A: NOW + 1 } }, 'A', { kind: 'unsnooze' }, NOW).snoozed, {});
});

test('downloaded theme files are checked before anything is written', () => {
  const ok = checkThemeFiles('{"name":"T","version":"2.0.0","minAppVersion":"1.0.0"}', 'body{}', 'T', APP);
  assert.deepEqual(ok, { ok: true, files: { manifest: '{"name":"T","version":"2.0.0","minAppVersion":"1.0.0"}', css: 'body{}', version: '2.0.0' } });
  const err = (m: string, css = 'x') => {
    const r = checkThemeFiles(m, css, 'T', APP);
    return r.ok ? '' : r.error;
  };
  assert.match(err('nope'), /not valid/);
  assert.match(err('[1]'), /not valid/);
  assert.match(err('{"name":"U","version":"1.0.0"}'), /different theme \(U\)/);
  assert.match(err('{"name":"T"}'), /not valid/);
  assert.match(err('{"name":"T","version":"2.0.0","minAppVersion":"9.0.0"}'), /needs Obsidian 9\.0\.0; you have 1\.9\.0/);
  assert.match(err('{"name":"T","version":"2.0.0"}', '  \n'), /empty/);
});

const rel = (f: string) => `https://github.com/me/T/releases/download/2.0.0/${f}`;
const head = (f: string) => `https://raw.githubusercontent.com/me/T/HEAD/${f}`;
const M = '{"name":"T","version":"2.0.0"}';

test('a theme downloads from the release named after the version', async () => {
  const log: string[] = [];
  const files = await downloadTheme(io({ [rel('manifest.json')]: M, [rel('theme.css')]: 'new{}' }, log), 'T', 'me/T', '2.0.0', APP);
  assert.deepEqual(files, { manifest: M, css: 'new{}', version: '2.0.0' });
  assert.deepEqual(log, [rel('manifest.json'), rel('theme.css')]);
});

test('without a release manifest (404) both files come from the default branch', async () => {
  const files = await downloadTheme(io({ [head('manifest.json')]: M, [head('theme.css')]: 'head{}' }), 'T', 'me/T', '2.0.0', APP);
  assert.equal(files.css, 'head{}');
});

test('other download failures are not hidden by the fallback', async () => {
  // A release manifest without its theme.css, a server error, and a fallback that needs a newer Obsidian.
  await assert.rejects(downloadTheme(io({ [rel('manifest.json')]: M, [head('manifest.json')]: M, [head('theme.css')]: 'x' }), 'T', 'me/T', '2.0.0', APP), /404 for .*releases\/download\/2\.0\.0\/theme\.css/);
  await assert.rejects(downloadTheme(io({ [rel('manifest.json')]: new Error('503 for x') }), 'T', 'me/T', '2.0.0', APP), /503/);
  await assert.rejects(
    downloadTheme(io({ [head('manifest.json')]: '{"name":"T","version":"3.0.0","minAppVersion":"9.0.0"}', [head('theme.css')]: 'x' }), 'T', 'me/T', '2.0.0', APP),
    /needs Obsidian 9\.0\.0/,
  );
  await assert.rejects(downloadTheme(io({ [rel('manifest.json')]: '{"name":"U","version":"2.0.0"}', [rel('theme.css')]: 'x' }), 'T', 'me/T', '2.0.0', APP), /different theme/);
});

test('theme files are written css first, manifest last, and put back if a write fails', async () => {
  const dir = '.obsidian/themes/T';
  const a = adapter({ [`${dir}/theme.css`]: 'old{}', [`${dir}/manifest.json`]: 'old-m', [`${dir}/fonts.css`]: 'keep' });
  await writeThemeFiles(a, dir, { manifest: M, css: 'new{}', version: '2.0.0' });
  assert.deepEqual(a.files, { [`${dir}/theme.css`]: 'new{}', [`${dir}/manifest.json`]: M, [`${dir}/fonts.css`]: 'keep' });

  const b = adapter({ [`${dir}/theme.css`]: 'old{}', [`${dir}/manifest.json`]: 'old-m' }, `${dir}/manifest.json`);
  await assert.rejects(writeThemeFiles(b, dir, { manifest: M, css: 'new{}', version: '2.0.0' }), /disk full/);
  assert.equal(b.files[`${dir}/theme.css`], 'old{}');
  assert.equal(b.files[`${dir}/manifest.json`], 'old-m');
});

test('the status bar splits plugin and theme updates and is empty at zero', () => {
  assert.equal(statusText(0, 0), '');
  assert.equal(statusText(3, 0), '3 plugin updates');
  assert.equal(statusText(0, 1), '1 theme update');
  assert.equal(statusText(1, 2), '1 plugin update · 2 theme updates');
});

test('the notice after a manual check names both counts', () => {
  assert.equal(checkedNotice(0, 0, false), 'All plugins are up to date.');
  assert.equal(checkedNotice(0, 0, true), 'All plugins and themes are up to date.');
  assert.equal(checkedNotice(2, 0, true), '2 plugin updates available.');
  assert.equal(checkedNotice(1, 3, true), '1 plugin update available. 3 theme updates available.');
});
