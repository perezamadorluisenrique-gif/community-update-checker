import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyUpdate } from '../src/check.ts';
import type { InstalledPlugin } from '../src/check.ts';
import type { RemoteManifest } from '../src/sources.ts';

const installed: InstalledPlugin = { id: 'foo', name: 'Foo', version: '1.0.0' };
const remote = (version: string, minAppVersion = ''): RemoteManifest => ({ version, minAppVersion, raw: { version } });

test('a newer version this app can run is an update', () => {
  assert.deepEqual(classifyUpdate(installed, remote('1.1.0', '1.4.0'), '1.9.0', {}), {
    state: 'update',
    available: '1.1.0',
    requires: '',
  });
});

test('same or older version is current', () => {
  assert.equal(classifyUpdate(installed, remote('1.0.0'), '1.9.0', {}).state, 'current');
  assert.equal(classifyUpdate(installed, remote('0.9.0'), '1.9.0', {}).state, 'current');
});

test('a version whose minAppVersion is above the running app is blocked, with the floor', () => {
  const r = classifyUpdate(installed, remote('1.1.0', '1.10.0'), '1.9.2', {});
  assert.equal(r.state, 'blocked');
  assert.equal(r.requires, '1.10.0');
  assert.equal(classifyUpdate(installed, remote('1.1.0', '1.9.2'), '1.9.2', {}).state, 'update');
});

test('an unreadable minAppVersion is not a floor', () => {
  assert.equal(classifyUpdate(installed, remote('1.1.0', 'soon'), '1.9.2', {}).state, 'update');
});

test('ignoring a version hides only that version', () => {
  assert.equal(classifyUpdate(installed, remote('1.1.0'), '1.9.0', { foo: '1.1.0' }).state, 'ignored');
  assert.equal(classifyUpdate(installed, remote('1.2.0'), '1.9.0', { foo: '1.1.0' }).state, 'update');
  assert.equal(classifyUpdate(installed, remote('1.1.0'), '1.9.0', { bar: '1.1.0' }).state, 'update');
});

test('a pre-release of the next version is not an update over the same release', () => {
  const stable: InstalledPlugin = { id: 'foo', name: 'Foo', version: '2.0.0' };
  assert.equal(classifyUpdate(stable, remote('2.0.0-beta.1'), '1.9.0', {}).state, 'current');
  assert.equal(classifyUpdate({ ...stable, version: '2.0.0-beta.1' }, remote('2.0.0'), '1.9.0', {}).state, 'update');
});

test('versions that cannot be ordered count as an update when they differ', () => {
  assert.equal(classifyUpdate({ ...installed, version: '1.2.3.4' }, remote('1.2.3.5'), '1.9.0', {}).state, 'update');
  assert.equal(classifyUpdate({ ...installed, version: '2026.10.01' }, remote('2026.10.01'), '1.9.0', {}).state, 'current');
  assert.equal(classifyUpdate({ ...installed, version: 'dev' }, remote('1.1.0'), '1.9.0', {}).state, 'update');
  assert.equal(classifyUpdate({ ...installed, version: '1.2.3.4' }, remote('1.2.3.5'), '1.9.0', { foo: '1.2.3.5' }).state, 'ignored');
});
