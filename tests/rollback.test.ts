import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyFiles,
  checkManifest,
  filterReleases,
  isInstalledVersion,
  needsNewerApp,
  notesPreview,
  parseReleaseList,
  releaseChoices,
  selectAssets,
  sortReleases,
  versionFromTag,
  versionToIgnore,
} from '../src/rollback.ts';
import type { FileAdapter } from '../src/rollback.ts';

const dl = (tag: string, name: string) => ({ name, browser_download_url: `https://github.com/me/p/releases/download/${tag}/${name}` });
const rel = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  name: tag,
  body: `notes for ${tag}`,
  published_at: '2026-01-01T00:00:00Z',
  html_url: `https://github.com/me/p/releases/tag/${tag}`,
  assets: [dl(tag, 'main.js'), dl(tag, 'manifest.json'), dl(tag, 'styles.css')],
  ...extra,
});

test('tags lose a leading v only before a digit', () => {
  assert.equal(versionFromTag('v1.2.3'), '1.2.3');
  assert.equal(versionFromTag('1.2.3'), '1.2.3');
  assert.equal(versionFromTag('very-old'), 'very-old');
});

test('release list parsing keeps good entries and never throws', () => {
  const list = parseReleaseList([rel('v1.0.0'), { name: 'no tag' }, 'junk', null, rel('1.1.0', { draft: true, assets: 'x' })]);
  assert.deepEqual(list.map((r) => r.version), ['1.0.0', '1.1.0']);
  assert.equal(list[0].assets.length, 3);
  assert.equal(list[1].draft, true);
  assert.deepEqual(list[1].assets, []);
  assert.deepEqual(parseReleaseList({ a: 1 }), []);
  assert.deepEqual(parseReleaseList(null), []);
});

test('sorting is newest version first, with the date as the tie-break and for non-versions', () => {
  const list = parseReleaseList([rel('1.9.0'), rel('1.10.0'), rel('v2.0.0-beta.1'), rel('2.0.0'), rel('weird', { published_at: '2027-01-01T00:00:00Z' }), rel('older', { published_at: '2020-01-01T00:00:00Z' })]);
  const sorted = sortReleases(list).map((r) => r.version);
  assert.deepEqual(sorted.slice(0, 4), ['2.0.0', '2.0.0-beta.1', '1.10.0', '1.9.0']);
  assert.equal(list[0].version, '1.9.0', 'input is not mutated');
});

test('drafts are always dropped; pre-releases only unless allowed', () => {
  const list = parseReleaseList([rel('1.0.0'), rel('1.1.0', { draft: true }), rel('1.2.0-beta.1', { prerelease: true })]);
  assert.deepEqual(filterReleases(list, false).map((r) => r.version), ['1.0.0']);
  assert.deepEqual(filterReleases(list, true).map((r) => r.version), ['1.0.0', '1.2.0-beta.1']);
});

test('the choice list is capped at 30 and has one entry per version', () => {
  const many = Array.from({ length: 45 }, (_, i) => rel(`1.${i}.0`));
  const choices = releaseChoices([...many, rel('v1.44.0')], false);
  assert.equal(choices.length, 30);
  assert.equal(choices[0].version, '1.44.0');
  assert.equal(new Set(choices.map((c) => c.version)).size, 30);
});

test('minAppVersion comparison', () => {
  assert.equal(needsNewerApp('1.8.0', '1.7.2'), true);
  assert.equal(needsNewerApp('1.7.2', '1.7.2'), false);
  assert.equal(needsNewerApp('1.5.0', '1.7.2'), false);
  assert.equal(needsNewerApp('1.10.0', '1.9.9'), true);
  assert.equal(needsNewerApp('', '1.7.2'), false);
  assert.equal(needsNewerApp('soon', '1.7.2'), false);
});

test('the installed version is recognised across spellings', () => {
  assert.equal(isInstalledVersion('1.0.0', '1.0.0'), true);
  assert.equal(isInstalledVersion('1.0', '1.0.0'), true);
  assert.equal(isInstalledVersion('1.0.1', '1.0.0'), false);
});

test('asset selection needs main.js and manifest.json from the plugin repo; styles.css is optional', () => {
  const [full] = parseReleaseList([rel('1.0.0')]);
  const sel = selectAssets(full, 'me/p');
  assert.equal(sel?.main.name, 'main.js');
  assert.equal(sel?.styles?.name, 'styles.css');

  const [noStyles] = parseReleaseList([rel('1.0.0', { assets: [dl('1.0.0', 'main.js'), dl('1.0.0', 'manifest.json'), dl('1.0.0', 'main.js.map')] })]);
  assert.equal(selectAssets(noStyles, 'me/p')?.styles, null);

  const [noMain] = parseReleaseList([rel('1.0.0', { assets: [dl('1.0.0', 'manifest.json')] })]);
  assert.equal(selectAssets(noMain, 'me/p'), null);

  assert.equal(selectAssets(full, 'someone/else'), null, 'downloads from another repository are refused');
  const [evil] = parseReleaseList([rel('1.0.0', { assets: [{ name: 'main.js', browser_download_url: 'https://evil.example/main.js' }, dl('1.0.0', 'manifest.json')] })]);
  assert.equal(selectAssets(evil, 'me/p'), null);
});

test('which version to ignore after a rollback', () => {
  assert.equal(versionToIgnore('1.2.0', null, '1.1.0'), '1.2.0');
  assert.equal(versionToIgnore('1.2.0', '1.2.0', '1.1.0'), '1.2.0');
  assert.equal(versionToIgnore('1.2.0', '1.3.0', '1.1.0'), '1.3.0');
  assert.equal(versionToIgnore('1.2.0', '1.0.0', '1.1.0'), '1.2.0');
  assert.equal(versionToIgnore('1.2.0', null, '1.3.0'), null, 'installing a newer version is not a rollback');
  assert.equal(versionToIgnore('1.2.0', null, '1.2.0'), null);
});

test('notes preview is one plain line', () => {
  assert.equal(notesPreview('## Fixed\n- a **real** [fix](http://x)\n```js\ncode\n```\n'), 'Fixed a real fix');
  assert.equal(notesPreview(''), '');
  const long = notesPreview('word '.repeat(100), 20);
  assert.ok(long.length <= 20 && long.endsWith('…'));
});

function memory(files: Record<string, string>, failOn?: string): FileAdapter & { files: Record<string, string>; removed: string[] } {
  const store = { ...files };
  const removed: string[] = [];
  return {
    files: store,
    removed,
    exists: async (p) => p in store,
    read: async (p) => store[p],
    write: async (p, d) => {
      if (failOn && p.endsWith(failOn) && d !== files[p]) throw new Error(`disk full writing ${failOn}`);
      store[p] = d;
    },
    remove: async (p) => {
      removed.push(p);
      delete store[p];
    },
  };
}

const D = '.obsidian/plugins/p';
const old = { [`${D}/main.js`]: 'old main', [`${D}/manifest.json`]: '{"v":"2"}', [`${D}/styles.css`]: 'old css', [`${D}/data.json`]: '{"mine":1}' };

test('applyFiles replaces the three files and leaves data.json alone', async () => {
  const a = memory(old);
  await applyFiles(a, D, { main: 'new main', manifest: '{"v":"1"}', styles: 'new css' });
  assert.equal(a.files[`${D}/main.js`], 'new main');
  assert.equal(a.files[`${D}/manifest.json`], '{"v":"1"}');
  assert.equal(a.files[`${D}/styles.css`], 'new css');
  assert.equal(a.files[`${D}/data.json`], '{"mine":1}');
});

test('applyFiles removes an old styles.css when the release has none', async () => {
  const a = memory(old);
  await applyFiles(a, D, { main: 'm', manifest: 'x', styles: null });
  assert.equal(`${D}/styles.css` in a.files, false);
});

test('a failed write restores every file, including a removed styles.css', async () => {
  for (const failOn of ['main.js', 'manifest.json']) {
    const a = memory(old, failOn);
    await assert.rejects(applyFiles(a, D, { main: 'new main', manifest: 'new manifest', styles: null }), /disk full/);
    assert.deepEqual(a.files, old, `restored after failing on ${failOn}`);
  }
});

test('a failed write on a fresh install removes the files it created', async () => {
  const a = memory({ [`${D}/data.json`]: '{}' }, 'manifest.json');
  await assert.rejects(applyFiles(a, D, { main: 'm', manifest: 'x', styles: 'c' }), /disk full/);
  assert.deepEqual(a.files, { [`${D}/data.json`]: '{}' });
});

test('if restoring also fails the error says which files', async () => {
  const a = memory(old);
  a.write = async () => {
    throw new Error('read-only');
  };
  await assert.rejects(applyFiles(a, D, { main: 'm', manifest: 'x', styles: 'c' }), /could not restore main\.js, manifest\.json, styles\.css/);
});

test('a downloaded manifest must be JSON, for this plugin, and not need a newer app', () => {
  const m = (o: Record<string, unknown>) => JSON.stringify({ id: 'p', version: '1.0.0', minAppVersion: '1.5.0', ...o });
  const good = checkManifest(m({}), 'p', '1.7.0');
  assert.equal(good.ok, true);
  assert.equal(good.ok && good.minAppVersion, '1.5.0');
  assert.equal(checkManifest(m({ minAppVersion: undefined }), 'p', '1.0.0').ok, true, 'no floor means compatible');
  assert.match((checkManifest('<html>', 'p', '1.7.0') as { error: string }).error, /not valid JSON/);
  assert.match((checkManifest('[]', 'p', '1.7.0') as { error: string }).error, /not valid/);
  assert.match((checkManifest(m({ id: 'other' }), 'p', '1.7.0') as { error: string }).error, /different plugin \(other\)/);
  assert.match((checkManifest(m({ version: '' }), 'p', '1.7.0') as { error: string }).error, /no version/);
  assert.match((checkManifest(m({ minAppVersion: '1.9.0' }), 'p', '1.7.0') as { error: string }).error, /needs Obsidian 1\.9\.0; you have 1\.7\.0/);
});

test('asset selection ignores the case of the repository name', () => {
  const [r] = parseReleaseList([rel('1.0.0')]);
  assert.ok(selectAssets(r, 'ME/P'));
});
