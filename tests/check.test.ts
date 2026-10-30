import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyUpdate } from '../src/check.ts';
import { DAY_MS, NO_HOLDS } from '../src/holds.ts';
import type { Holds } from '../src/holds.ts';
import type { InstalledPlugin } from '../src/check.ts';
import type { RemoteManifest } from '../src/sources.ts';

const installed: InstalledPlugin = { id: 'foo', name: 'Foo', version: '1.0.0' };
const NOW = Date.UTC(2026, 9, 2);
const holds = (over: Partial<Holds> = {}): Holds => ({ ...NO_HOLDS, ...over });
const remote = (version: string, minAppVersion = ''): RemoteManifest => ({ version, minAppVersion, raw: { version } });

test('a newer version this app can run is an update', () => {
  assert.deepEqual(classifyUpdate(installed, remote('1.1.0', '1.4.0'), '1.9.0', holds(), NOW), {
    state: 'update',
    available: '1.1.0',
    requires: '',
    until: 0,
    readyAt: 0,
  });
});

test('same or older version is current', () => {
  assert.equal(classifyUpdate(installed, remote('1.0.0'), '1.9.0', holds(), NOW).state, 'current');
  assert.equal(classifyUpdate(installed, remote('0.9.0'), '1.9.0', holds(), NOW).state, 'current');
});

test('a version whose minAppVersion is above the running app is blocked, with the floor', () => {
  const r = classifyUpdate(installed, remote('1.1.0', '1.10.0'), '1.9.2', holds(), NOW);
  assert.equal(r.state, 'blocked');
  assert.equal(r.requires, '1.10.0');
  assert.equal(classifyUpdate(installed, remote('1.1.0', '1.9.2'), '1.9.2', holds(), NOW).state, 'update');
});

test('an unreadable minAppVersion is not a floor', () => {
  assert.equal(classifyUpdate(installed, remote('1.1.0', 'soon'), '1.9.2', holds(), NOW).state, 'update');
});

test('ignoring a version hides only that version', () => {
  assert.equal(classifyUpdate(installed, remote('1.1.0'), '1.9.0', holds({ ignored: { foo: '1.1.0' } }), NOW).state, 'ignored');
  assert.equal(classifyUpdate(installed, remote('1.2.0'), '1.9.0', holds({ ignored: { foo: '1.1.0' } }), NOW).state, 'update');
  assert.equal(classifyUpdate(installed, remote('1.1.0'), '1.9.0', holds({ ignored: { bar: '1.1.0' } }), NOW).state, 'update');
});

test('a pre-release of the next version is not an update over the same release', () => {
  const stable: InstalledPlugin = { id: 'foo', name: 'Foo', version: '2.0.0' };
  assert.equal(classifyUpdate(stable, remote('2.0.0-beta.1'), '1.9.0', holds(), NOW).state, 'current');
  assert.equal(classifyUpdate({ ...stable, version: '2.0.0-beta.1' }, remote('2.0.0'), '1.9.0', holds(), NOW).state, 'update');
});

test('versions that cannot be ordered count as an update when they differ', () => {
  assert.equal(classifyUpdate({ ...installed, version: '1.2.3.4' }, remote('1.2.3.5'), '1.9.0', holds(), NOW).state, 'update');
  assert.equal(classifyUpdate({ ...installed, version: '2026.10.01' }, remote('2026.10.01'), '1.9.0', holds(), NOW).state, 'current');
  assert.equal(classifyUpdate({ ...installed, version: 'dev' }, remote('1.1.0'), '1.9.0', holds(), NOW).state, 'update');
  assert.equal(classifyUpdate({ ...installed, version: '1.2.3.4' }, remote('1.2.3.5'), '1.9.0', holds({ ignored: { foo: '1.2.3.5' } }), NOW).state, 'ignored');
});

test('a snoozed plugin with a newer version is snoozed, with the end of the snooze', () => {
  const r = classifyUpdate(installed, remote('1.1.0'), '1.9.0', holds({ snoozed: { foo: NOW + DAY_MS } }), NOW);
  assert.equal(r.state, 'snoozed');
  assert.equal(r.until, NOW + DAY_MS);
});

test('an ended snooze is an update again', () => {
  assert.equal(classifyUpdate(installed, remote('1.1.0'), '1.9.0', holds({ snoozed: { foo: NOW } }), NOW).state, 'update');
  assert.equal(classifyUpdate(installed, remote('1.1.0'), '1.9.0', holds({ snoozed: { foo: NOW - 1 } }), NOW).state, 'update');
});

test('snoozed beats ignored and blocked, and a snooze with nothing newer is current', () => {
  const h = holds({ snoozed: { foo: NOW + DAY_MS }, ignored: { foo: '1.1.0' } });
  assert.equal(classifyUpdate(installed, remote('1.1.0'), '1.9.0', h, NOW).state, 'snoozed');
  assert.equal(classifyUpdate(installed, remote('1.1.0', '9.0.0'), '1.9.0', h, NOW).state, 'snoozed');
  assert.equal(classifyUpdate(installed, remote('1.0.0'), '1.9.0', h, NOW).state, 'current');
  assert.equal(classifyUpdate(installed, remote('1.1.0'), '1.9.0', holds({ snoozed: { bar: NOW + DAY_MS } }), NOW).state, 'update');
});

test('a release seen for fewer days than asked is waiting; at exactly that age it is an update', () => {
  const seen = (at: number) => ({ foo: { version: '1.1.0', at } });
  const wait = (at: number) => classifyUpdate(installed, remote('1.1.0'), '1.9.0', holds({ minAgeDays: 7, seen: seen(at) }), NOW);
  const young = wait(NOW - 2 * DAY_MS);
  assert.equal(young.state, 'waiting');
  assert.equal(young.readyAt, NOW + 5 * DAY_MS);
  assert.equal(wait(NOW - 7 * DAY_MS).state, 'update');
  assert.equal(wait(NOW - 8 * DAY_MS).state, 'update');
  assert.equal(wait(NOW - 7 * DAY_MS + 1).state, 'waiting');
});

test('with no wait set, nothing is ever waiting', () => {
  assert.equal(classifyUpdate(installed, remote('1.1.0'), '1.9.0', holds({ minAgeDays: 0, seen: { foo: { version: '1.1.0', at: NOW } } }), NOW).state, 'update');
});

test('a version not seen yet, or seen as another version, starts its wait now', () => {
  const r = classifyUpdate(installed, remote('1.1.0'), '1.9.0', holds({ minAgeDays: 3 }), NOW);
  assert.equal(r.state, 'waiting');
  assert.equal(r.readyAt, NOW + 3 * DAY_MS);
  const stale = holds({ minAgeDays: 3, seen: { foo: { version: '1.0.5', at: NOW - 30 * DAY_MS } } });
  assert.equal(classifyUpdate(installed, remote('1.1.0'), '1.9.0', stale, NOW).state, 'waiting');
});

test('blocked beats waiting, and ignored beats waiting', () => {
  const h = holds({ minAgeDays: 7, seen: { foo: { version: '1.1.0', at: NOW } } });
  assert.equal(classifyUpdate(installed, remote('1.1.0', '9.0.0'), '1.9.0', h, NOW).state, 'blocked');
  assert.equal(classifyUpdate(installed, remote('1.1.0'), '1.9.0', { ...h, ignored: { foo: '1.1.0' } }, NOW).state, 'ignored');
});
