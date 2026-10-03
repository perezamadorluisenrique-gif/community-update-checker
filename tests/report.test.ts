import test from 'node:test';
import assert from 'node:assert/strict';

import { buildReports, healthConcerns, pendingUpdates } from '../src/report.ts';
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
  ignored: {},
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
  assert.deepEqual(pendingUpdates(buildReports({ ...base, ignored: { alpha: '2.0.0' } })), []);
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
