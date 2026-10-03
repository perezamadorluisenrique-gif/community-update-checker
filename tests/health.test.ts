import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyHealth, formatAge } from '../src/health.ts';
import type { HealthInputs } from '../src/health.ts';

const NOW = Date.UTC(2026, 9, 2);
const daysAgo = (d: number) => NOW - d * 86_400_000;

const src: HealthInputs = {
  listed: new Set(['fresh', 'old', 'edge', 'gone-but-listed']),
  removed: new Map([['gone', 'Abandoned'], ['gone-but-listed', '']]),
  updated: new Map([['fresh', daysAgo(10)], ['old', daysAgo(1000)], ['edge', daysAgo(730)], ['gone', daysAgo(5)]]),
};

test('an active, listed plugin has no flags', () => {
  assert.deepEqual(classifyHealth('fresh', src, NOW), { flags: [], daysSinceRelease: 10, removedReason: '' });
});

test('two years without a release is stale, one day less is not', () => {
  assert.deepEqual(classifyHealth('old', src, NOW).flags, ['stale']);
  assert.deepEqual(classifyHealth('edge', src, NOW).flags, ['stale']);
  assert.deepEqual(classifyHealth('edge', src, NOW + 86_400_000 * -1 + 1).flags, []);
});

test('a removed plugin carries the reason and is not also "not listed"', () => {
  const h = classifyHealth('gone', src, NOW);
  assert.deepEqual(h.flags, ['removed']);
  assert.equal(h.removedReason, 'Abandoned');
});

test('the removed list wins over the listing', () => {
  assert.deepEqual(classifyHealth('gone-but-listed', src, NOW).flags, ['removed']);
});

test('a plugin outside the directory is flagged and has no age', () => {
  assert.deepEqual(classifyHealth('beta-only', src, NOW), { flags: ['not-listed'], daysSinceRelease: null, removedReason: '' });
});

test('a future timestamp does not give negative days', () => {
  assert.equal(classifyHealth('x', { ...src, updated: new Map([['x', NOW + 1e9]]) }, NOW).daysSinceRelease, 0);
});

test('formatAge picks a readable unit', () => {
  assert.equal(formatAge(0), 'today');
  assert.equal(formatAge(1), '1 day');
  assert.equal(formatAge(12), '12 days');
  assert.equal(formatAge(90), '3 months');
  assert.equal(formatAge(730), '2 years');
  assert.equal(formatAge(1000), '2.7 years');
});
