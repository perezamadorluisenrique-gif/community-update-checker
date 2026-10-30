import test from 'node:test';
import assert from 'node:assert/strict';

import { API_VERSION, createExtensions } from '../src/api.ts';
import type { ApiHost, InstallIntent } from '../src/api.ts';

const intent: InstallIntent = { id: 'p', name: 'P', repo: 'me/p', from: '1.0.0', to: '1.1.0', kind: 'update', bulk: 1 };
const setup = (timeoutMs = 50) => {
  const logs: string[] = [];
  const ext = createExtensions((m) => logs.push(m), { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }, timeoutMs);
  return { ext, logs };
};
const host = (over: Partial<ApiHost> = {}): ApiHost => ({
  reports: () => [],
  release: async () => null,
  ignore: async () => {},
  busy: () => false,
  refresh: () => {},
  ...over,
});

test('the API is frozen, versioned and passes its calls to the host', async () => {
  const { ext } = setup();
  const calls: string[] = [];
  const api = ext.api(host({ busy: () => true, refresh: () => calls.push('refresh'), ignore: async (id, v) => void calls.push(`ignore ${id} ${v}`) }));
  assert.equal(api.apiVersion, API_VERSION);
  assert.ok(Object.isFrozen(api));
  assert.equal(api.busy(), true);
  api.refresh();
  await api.ignore('x', '2.0.0');
  assert.deepEqual(calls, ['refresh', 'ignore x 2.0.0']);
});

test('registering needs an id and a function', () => {
  const { ext } = setup();
  assert.throws(() => ext.beforeInstall('', () => {}), TypeError);
  assert.throws(() => ext.holds('a', null as never), TypeError);
  assert.throws(() => ext.rowActions('a', 3 as never), TypeError);
  assert.throws(() => ext.on('checked', 'no' as never), TypeError);
});

test('beforeInstall handlers run one after the other, in order, and see the intent', async () => {
  const { ext } = setup();
  const order: string[] = [];
  ext.beforeInstall('a', async (i) => {
    order.push(`a-start ${i.to}`);
    await new Promise((r) => setTimeout(r, 10));
    order.push('a-end');
  });
  ext.beforeInstall('b', () => void order.push('b'));
  assert.equal(await ext.runBefore(intent), null);
  assert.deepEqual(order, ['a-start 1.1.0', 'a-end', 'b']);
});

test('the first veto wins, names its owner and skips the rest', async () => {
  const { ext } = setup();
  const ran: string[] = [];
  ext.beforeInstall('a', () => void ran.push('a'));
  ext.beforeInstall('b', () => ({ veto: true, reason: 'no snapshot' }));
  ext.beforeInstall('c', () => void ran.push('c'));
  assert.deepEqual(await ext.runBefore(intent), { owner: 'b', reason: 'no snapshot' });
  assert.deepEqual(ran, ['a']);
});

test('a handler that throws, rejects or returns junk does not block', async () => {
  const { ext, logs } = setup();
  ext.beforeInstall('throws', () => {
    throw new Error('boom');
  });
  ext.beforeInstall('rejects', () => Promise.reject(new Error('nope')));
  ext.beforeInstall('junk', () => ({ veto: false }) as never);
  assert.equal(await ext.runBefore(intent), null);
  assert.equal(logs.length, 2);
});

test('a handler that never answers is given up on after the timeout', async () => {
  const { ext, logs } = setup(30);
  ext.beforeInstall('slow', () => new Promise(() => {}));
  ext.beforeInstall('after', () => ({ veto: true, reason: 'x' }));
  const started = Date.now();
  const result = await ext.runBefore(intent);
  assert.equal(result?.owner, 'after', 'the next handler still runs');
  assert.ok(Date.now() - started < 1000);
  assert.match(logs[0], /slow/);
});

test('registering an id again replaces it, and the disposer only removes its own', async () => {
  const { ext } = setup();
  const first = ext.beforeInstall('a', () => ({ veto: true, reason: 'first' }));
  const second = ext.beforeInstall('a', () => ({ veto: true, reason: 'second' }));
  assert.equal((await ext.runBefore(intent))?.reason, 'second');
  first();
  assert.equal((await ext.runBefore(intent))?.reason, 'second', 'the stale disposer does nothing');
  second();
  second();
  assert.equal(await ext.runBefore(intent), null);
});

test('holds: first provider with an answer wins, owner falls back to the id, a throwing one counts as none', () => {
  const { ext, logs } = setup();
  const q = { id: 'p', name: 'P', installed: '1.0.0', available: '2.0.0', firstSeen: 0, now: 1 };
  ext.holds('bad', () => {
    throw new Error('x');
  });
  ext.holds('none', () => null);
  assert.equal(ext.holdFor(q), null);
  ext.holds('rules', () => ({ owner: '', label: 'major update' }));
  assert.deepEqual(ext.holdFor(q), { owner: 'rules', label: 'major update' });
  ext.holdFor(q);
  assert.equal(logs.length, 1, 'the failure is logged once');
});

test('rowActions: collects from every provider and ignores malformed entries and failures', () => {
  const { ext } = setup();
  const row = { id: 'p', name: 'P', version: '1.0.0', repo: 'me/p', state: 'update' as const };
  assert.equal(ext.hasRowActions(), false);
  ext.rowActions('one', (r) => [{ label: `Inspect ${r.name}`, icon: 'search', run: () => {} }, { label: '', run: () => {} }, { label: 'x' } as never]);
  ext.rowActions('two', () => {
    throw new Error('boom');
  });
  ext.rowActions('three', () => [{ label: 'Snapshot', run: () => {} }]);
  assert.equal(ext.hasRowActions(), true);
  assert.deepEqual(ext.actionsFor(row).map((a) => a.label), ['Inspect P', 'Snapshot']);
});

test('events reach every listener; a failing one affects nobody', async () => {
  const { ext, logs } = setup();
  const seen: string[] = [];
  ext.on('installed', () => {
    throw new Error('sync');
  });
  ext.on('installed', () => Promise.reject(new Error('async')));
  const off = ext.on('installed', (e) => void seen.push(e.to));
  ext.emit('installed', { id: 'p', name: 'P', from: '1', to: '2', kind: 'update' });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen, ['2']);
  assert.equal(logs.length, 2);
  off();
  ext.emit('installed', { id: 'p', name: 'P', from: '2', to: '3', kind: 'update' });
  assert.deepEqual(seen, ['2']);
});

test('after close nothing registers and the API goes quiet', async () => {
  const { ext } = setup();
  const api = ext.api(host({ busy: () => true, reports: () => [{ id: 'p', name: 'P', version: '1', repo: '', state: 'none', available: '', heldBy: null }] }));
  ext.beforeInstall('a', () => ({ veto: true, reason: 'x' }));
  ext.close();
  const off = api.beforeInstall('late', () => ({ veto: true, reason: 'late' }));
  assert.equal(typeof off, 'function');
  off();
  assert.equal(await ext.runBefore(intent), null);
  assert.deepEqual(api.reports(), []);
  assert.equal(api.busy(), false);
  assert.equal(await api.release('me/p', '1'), null);
  assert.equal(ext.holdFor({ id: 'p', name: 'P', installed: '1', available: '2', firstSeen: 0, now: 0 }), null);
});
