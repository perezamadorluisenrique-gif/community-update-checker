import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDirectory, parseManifest, parseRelease, parseRemoved, parseUpdated } from '../src/sources.ts';

test('directory keeps well-formed entries and drops the rest', () => {
  const d = parseDirectory([
    { id: 'a', name: 'A', repo: 'me/a', author: 'x' },
    { id: 'b', repo: 'me/b' },
    { id: 'c', name: 'C', repo: 'not a repo' },
    { name: 'no id', repo: 'me/d' },
    'junk',
    null,
  ]);
  assert.deepEqual([...d.keys()], ['a', 'b']);
  assert.equal(d.get('b')?.name, 'b');
  assert.equal(d.get('a')?.repo, 'me/a');
});

test('directory of the wrong shape is empty, never a throw', () => {
  assert.equal(parseDirectory({ a: 1 }).size, 0);
  assert.equal(parseDirectory(null).size, 0);
  assert.equal(parseDirectory('x').size, 0);
});

test('removed list maps id to reason', () => {
  const r = parseRemoved([{ id: 'a', name: 'A', reason: 'Merged into B' }, { id: 'b' }, { reason: 'x' }]);
  assert.equal(r.get('a'), 'Merged into B');
  assert.equal(r.get('b'), '');
  assert.equal(r.size, 2);
});

test('stats keep only a numeric `updated`', () => {
  const u = parseUpdated({ a: { downloads: 5, updated: 1789603289000, '1.0.0': 3 }, b: { downloads: 1 }, c: { updated: 'yesterday' }, d: 4 });
  assert.deepEqual([...u], [['a', 1789603289000]]);
  assert.equal(parseUpdated([]).size, 0);
});

test('manifest needs a version and keeps the raw object', () => {
  const m = parseManifest({ id: 'a', version: '1.2.3', minAppVersion: '1.0.0', name: 'A' });
  assert.equal(m?.version, '1.2.3');
  assert.equal(m?.minAppVersion, '1.0.0');
  assert.equal(m?.raw.name, 'A');
  assert.equal(parseManifest({ id: 'a' }), null);
  assert.equal(parseManifest('<html>404</html>'), null);
  assert.equal(parseManifest({ version: '1.0.0' })?.minAppVersion, '');
});

test('release parsing keeps the notes and date, tolerating a null body', () => {
  const r = parseRelease({ html_url: 'https://github.com/me/a/releases/tag/1.0.0', body: '  - fixed\n', published_at: '2026-09-01T10:00:00Z' });
  assert.deepEqual(r, { body: '- fixed', published: '2026-09-01T10:00:00Z', url: 'https://github.com/me/a/releases/tag/1.0.0' });
  assert.equal(parseRelease({ html_url: 'u', body: null })?.body, '');
  assert.equal(parseRelease({ message: 'Not Found' }), null);
});
