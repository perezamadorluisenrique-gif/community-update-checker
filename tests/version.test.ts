import test from 'node:test';
import assert from 'node:assert/strict';

import { compareVersions, isNewer, parseVersion } from '../src/version.ts';

test('parses plain, v-prefixed, short and build-suffixed versions', () => {
  assert.deepEqual(parseVersion('1.2.3')?.nums, [1, 2, 3]);
  assert.deepEqual(parseVersion('v2.0.1')?.nums, [2, 0, 1]);
  assert.deepEqual(parseVersion('1.4')?.nums, [1, 4, 0]);
  assert.deepEqual(parseVersion('1.2.3+abc.1')?.pre, []);
  assert.deepEqual(parseVersion('1.2.3-beta.2')?.pre, ['beta', '2']);
});

test('rejects things that are not versions', () => {
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion('latest'), null);
  assert.equal(parseVersion('1.2.3.4'), null);
  assert.equal(parseVersion('1.x'), null);
});

test('compares numerically, not as text', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
});

test('a pre-release is older than its release and orders by identifier', () => {
  assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.10'), -1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0-alpha'), 1);
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
});

test('isNewer is false whenever a side cannot be compared', () => {
  assert.equal(isNewer('2.0.0', '1.9.9'), true);
  assert.equal(isNewer('1.0.0', '1.0.0'), false);
  assert.equal(isNewer('1.0.0', '2.0.0'), false);
  assert.equal(isNewer('nightly', '1.0.0'), false);
  assert.equal(isNewer('1.0.1', 'dev'), false);
});
