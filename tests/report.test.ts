import test from 'node:test';
import assert from 'node:assert/strict';

import { DAY_MS, NO_HOLDS } from '../src/holds.ts';
import { buildReports, healthConcerns, newerVersions, pendingUpdates } from '../src/report.ts';
import type { ReportInputs } from '../src/report.ts';
import type { RemoteManifest } from '../src/sources.ts';

const NOW = Date.UTC(2026, 9, 2);
const m = (version: string, minAppVersion = ''): RemoteManifest => ({ version, minAppVersion, raw: {} });

const base: ReportInputs = {
  installed: [
    { id: 'zeta', name: 'Zeta', version: '1.0.0' },
    { id: 'alpha', name: 'Alpha', version: '1.0.0' },
    { id: 'old', name: 'Old', version: '1.0.0' },
    { id: 'gone', name: 'Gone', version: '1.0.0' },
    { id: 'beta-only', name: 'Beta Only', version: '0.1.0' },
    { id: 'down', name: 'Down', version: '1.0.0' },
  ],
  directory: new Map([
    ['zeta', { id: 'zeta', name: 'Zeta', repo: 'me/zeta' }],
    ['alpha', { id: 'alpha', name: 'Alpha', repo: 'me/alpha' }],
    ['old', { id: 'old', name: 'Old', repo: 'me/old' }],
    ['down', { id: 'down', name: 'Down', repo: 'me/down' }],
  ]),
  removed: new Map([['gone', 'Abandoned']]),
  updated: new Map([['old', NOW - 1000 * 86_400_000], ['alpha', NOW - 86_400_000]]),
  remotes: new Map<string, RemoteManifest | null>([
    ['zeta', m('1.1.0', '9.0.0')],
    ['alpha', m('2.0.0')],
    ['old', m('1.0.0')],
    ['down', null],
  ]),
  appVersion: '1.9.0',
  holds: NO_HOLDS,
  now: NOW,
};

test('reports are sorted by name and carry the repo', () => {
  const r = buildReports(base);
  assert.deepEqual(r.map((x) => x.plugin.name), ['Alpha', 'Beta Only', 'Down', 'Gone', 'Old', 'Zeta']);
  assert.equal(r[0].repo, 'me/alpha');
  assert.equal(r[1].repo, '');
});

test('pending updates exclude blocked, ignored and current plugins', () => {
  assert.deepEqual(pendingUpdates(buildReports(base)).map((x) => x.plugin.id), ['alpha']);
  assert.deepEqual(pendingUpdates(buildReports({ ...base, holds: { ...NO_HOLDS, ignored: { alpha: '2.0.0' } } })), []);
});

test('a blocked update keeps the floor so the view can say why', () => {
  const zeta = buildReports(base).find((x) => x.plugin.id === 'zeta');
  assert.equal(zeta?.update?.state, 'blocked');
  assert.equal(zeta?.update?.requires, '9.0.0');
});

test('a failed request is reported as failed, not as up to date', () => {
  const r = buildReports(base);
  assert.equal(r.find((x) => x.plugin.id === 'down')?.failed, true);
  assert.equal(r.find((x) => x.plugin.id === 'down')?.update, null);
  assert.equal(r.find((x) => x.plugin.id === 'beta-only')?.failed, false);
});

test('health concerns are ordered removed, stale, not listed', () => {
  assert.deepEqual(healthConcerns(buildReports(base)).map((x) => x.plugin.id), ['gone', 'old', 'beta-only']);
});

test('pending updates exclude snoozed and waiting plugins', () => {
  const snoozed = { ...NO_HOLDS, snoozed: { alpha: NOW + DAY_MS } };
  assert.deepEqual(pendingUpdates(buildReports({ ...base, holds: snoozed })), []);
  assert.equal(buildReports({ ...base, holds: snoozed }).find((r) => r.plugin.id === 'alpha')?.update?.state, 'snoozed');
  const waiting = { ...NO_HOLDS, minAgeDays: 7, seen: { alpha: { version: '2.0.0', at: NOW - DAY_MS } } };
  assert.deepEqual(pendingUpdates(buildReports({ ...base, holds: waiting })), []);
  assert.equal(buildReports({ ...base, holds: waiting }).find((r) => r.plugin.id === 'alpha')?.update?.state, 'waiting');
});

test('a snoozed plugin keeps its health warnings', () => {
  const r = buildReports({ ...base, holds: { ...NO_HOLDS, snoozed: { old: NOW + DAY_MS, gone: NOW + DAY_MS } } });
  assert.deepEqual(healthConcerns(r).map((x) => x.plugin.id), ['gone', 'old', 'beta-only']);
});

test('newerVersions lists newer releases, and null for a failed manifest', () => {
  const latest = newerVersions(base.installed, base.remotes, base.appVersion);
  assert.deepEqual([...latest], [['zeta', '1.1.0'], ['alpha', '2.0.0'], ['down', null]]);
});

// ---- extension holds (API v1)

import { applyExtHolds } from '../src/report.ts';
import { classifyUpdate } from '../src/check.ts';

const held = (reports: ReturnType<typeof buildReports>, rule: (id: string) => boolean, seen = {}) =>
  applyExtHolds(reports, (q) => (rule(q.id) ? { owner: 'rules', label: `hold ${q.id}` } : null), seen, NOW);

test('golden: with no extension holding anything the output is exactly the 0.4.0 output', () => {
  const reports = buildReports(base);
  const same = applyExtHolds(reports, () => null, {}, NOW);
  assert.deepEqual(same, reports);
  assert.ok(same.every((r, i) => r === reports[i]), 'the very same objects');
  for (const r of reports) assert.ok(!r.update || !('held' in r.update), 'no held field appears');
});

test('a hold moves an offered update to held, and pendingUpdates leaves it out', () => {
  const reports = held(buildReports(base), (id) => id === 'alpha');
  const alpha = reports.find((r) => r.plugin.id === 'alpha');
  assert.equal(alpha?.update?.state, 'held');
  assert.deepEqual(alpha?.update?.held, { owner: 'rules', label: 'hold alpha' });
  assert.equal(alpha?.update?.available, '2.0.0');
  assert.deepEqual(pendingUpdates(reports).map((r) => r.plugin.id), []);
});

test('precedence: current, snoozed, ignored and blocked beat held; held beats waiting and update', () => {
  const holds = { ...NO_HOLDS, snoozed: { s: NOW + DAY_MS }, ignored: { i: '2.0.0' }, minAgeDays: 3, seen: { w: { version: '2.0.0', at: NOW - DAY_MS } } };
  const installed = ['c', 's', 'i', 'b', 'w', 'u'].map((id) => ({ id, name: id, version: id === 'c' ? '2.0.0' : '1.0.0' }));
  const remotes = new Map<string, RemoteManifest | null>(installed.map((p) => [p.id, m('2.0.0', p.id === 'b' ? '9.0.0' : '')]));
  // 'u' has been waiting long enough, 'w' has not.
  const reports = buildReports({ ...base, installed, directory: new Map(), remotes, appVersion: '1.9.0', holds: { ...holds, seen: { ...holds.seen, u: { version: '2.0.0', at: NOW - 10 * DAY_MS } } } });
  const before = Object.fromEntries(reports.map((r) => [r.plugin.id, r.update?.state]));
  assert.deepEqual(before, { c: 'current', s: 'snoozed', i: 'ignored', b: 'blocked', w: 'waiting', u: 'update' });
  const after = Object.fromEntries(held(reports, () => true).map((r) => [r.plugin.id, r.update?.state]));
  assert.deepEqual(after, { c: 'current', s: 'snoozed', i: 'ignored', b: 'blocked', w: 'held', u: 'held' });
});

test('the hold is asked with the installed and available versions and when the release was first seen', () => {
  const asked: unknown[] = [];
  const reports = buildReports({ ...base, holds: NO_HOLDS });
  applyExtHolds(reports, (q) => (asked.push(q), null), { alpha: { version: '2.0.0', at: 123 }, zeta: { version: '0.0.1', at: 5 } }, NOW);
  assert.deepEqual(asked, [{ id: 'alpha', name: 'Alpha', installed: '1.0.0', available: '2.0.0', firstSeen: 123, now: NOW }]);
});

test('classifyUpdate itself never returns held', () => {
  assert.notEqual(classifyUpdate({ id: 'a', name: 'a', version: '1.0.0' }, m('2.0.0'), '1.9.0', NO_HOLDS, NOW).state, 'held');
});
