import test from 'node:test';
import assert from 'node:assert/strict';

import { DAY_MS, MAX_SNOOZE_DAYS, nextSeen, parseMinAgeDays, parseSeen, parseSnoozed, pruneSnoozed } from '../src/holds.ts';

const NOW = Date.UTC(2026, 9, 2);

test('pruneSnoozed drops ended snoozes and plugins that are gone', () => {
  const snoozed = { keep: NOW + DAY_MS, ended: NOW, past: NOW - DAY_MS, gone: NOW + DAY_MS };
  assert.deepEqual(pruneSnoozed(snoozed, new Set(['keep', 'ended', 'past']), NOW), { keep: NOW + DAY_MS });
  assert.deepEqual(pruneSnoozed(snoozed, null, NOW), { keep: NOW + DAY_MS, gone: NOW + DAY_MS });
});

test('parseSnoozed drops what is not a finite number and caps the length at 366 days', () => {
  const parsed = parseSnoozed({ a: 'soon', b: NaN, c: null, d: Infinity, e: NOW + 5 * DAY_MS, f: NOW + 10_000 * DAY_MS }, NOW);
  assert.deepEqual(parsed, { e: NOW + 5 * DAY_MS, f: NOW + MAX_SNOOZE_DAYS * DAY_MS });
  for (const bad of [null, undefined, 3, 'x', [1, 2]]) assert.deepEqual(parseSnoozed(bad, NOW), {});
});

test('parseSeen keeps well-formed entries only', () => {
  const parsed = parseSeen({ ok: { version: '1.0.0', at: 5 }, noAt: { version: '1.0.0' }, noVersion: { at: 5 }, empty: { version: '', at: 5 }, nan: { version: '1', at: NaN }, str: 'x' });
  assert.deepEqual(parsed, { ok: { version: '1.0.0', at: 5 } });
  assert.deepEqual(parseSeen([]), {});
});

test('parseMinAgeDays accepts only the offered values', () => {
  assert.equal(parseMinAgeDays(7), 7);
  assert.equal(parseMinAgeDays(0), 0);
  for (const bad of [5, -1, '7', null, undefined, NaN]) assert.equal(parseMinAgeDays(bad), 0);
});

test('nextSeen keeps the time while the version is the same and restarts it when the version changes', () => {
  const seen = { a: { version: '1.1.0', at: 100 }, b: { version: '2.0.0', at: 100 } };
  const next = nextSeen(seen, new Map<string, string | null>([['a', '1.1.0'], ['b', '2.1.0'], ['c', '3.0.0']]), NOW);
  assert.deepEqual(next, { a: { version: '1.1.0', at: 100 }, b: { version: '2.1.0', at: NOW }, c: { version: '3.0.0', at: NOW } });
});

test('nextSeen drops plugins with nothing newer and keeps the entry when a check failed', () => {
  const seen = { updated: { version: '1.1.0', at: 100 }, offline: { version: '1.1.0', at: 100 } };
  const next = nextSeen(seen, new Map<string, string | null>([['offline', null], ['fresh', null]]), NOW);
  assert.deepEqual(next, { offline: { version: '1.1.0', at: 100 } });
});
