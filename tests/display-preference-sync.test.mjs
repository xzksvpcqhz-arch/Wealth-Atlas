import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import * as preferences from '../lib/display-preferences.ts';
const require = createRequire(import.meta.url);
const ts = require('typescript');
function compile(file, dependency) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', code)(id => dependency(id), module, module.exports);
  return module.exports;
}
const { createDisplayPreferenceSync, parseDisplaySyncMeta, parseDisplayRemote } = compile('../lib/display-preference-sync.ts', id => { if (id === './display-preferences') return preferences; throw new Error('Unexpected import'); });
const { createDisplayPreferenceTransport } = compile('../lib/display-preference-transport.ts', id => id === './display-preferences' ? preferences : id === './display-preference-sync' ? { parseDisplayRemote } : (() => { throw new Error('Unexpected import'); })());
const clone = structuredClone;
function fixture(remoteInitial = null, localInitial = null) {
  let remote = clone(remoteInitial), local = localInitial ? clone(localInitial) : preferences.createDisplayPreferences(), stored = !!localInitial, dirty = false, active = true, meta = null, status;
  let writes = 0, fail = false, metaFail = false;
  const transport = { async read() { if (fail) throw new Error('synthetic offline'); return clone(remote); }, async write(value, revision) { if (fail) throw new Error('synthetic offline'); writes++; if ((remote?.revision ?? null) !== revision) return null; remote = { revision: (revision ?? 0) + 1, preferences: clone(value) }; return clone(remote); } };
  const session = createDisplayPreferenceSync({ transport, isActive: () => active, local: () => ({ value: clone(local), stored, dirty }), applyRemote: value => { if (dirty || !active) return false; local = clone(value); stored = true; return true; }, readMeta: () => meta, saveMeta: value => { if (metaFail) return false; meta = JSON.stringify(value); return true; }, onStatus: value => { status = value; } });
  return { session, transport, get local() { return local; }, get remote() { return remote; }, get status() { return status; }, get writes() { return writes; }, get meta() { return meta; }, edit(fn) { fn(local); stored = true; }, remoteEdit(fn) { fn(remote.preferences); remote.revision++; }, set dirty(value) { dirty = value; }, set active(value) { active = value; }, set fail(value) { fail = value; }, set metaFail(value) { metaFail = value; } };
}
test('display sync never creates a cloud row for untouched defaults', async () => { const f = fixture(); await f.session.sync(); assert.equal(f.writes, 0); assert.equal(f.status, 'ready'); });
test('explicit saved local display parameters upload and receive revision', async () => { const f = fixture(); f.edit(v => { v.devices.desktop.enabled = true; v.sidebar.hidden = ['budget']; }); await f.session.sync(); assert.equal(f.writes, 1); assert.equal(f.remote.revision, 1); assert.deepEqual(f.remote.preferences.sidebar.hidden, ['budget']); assert.equal(f.status, 'ready'); assert.ok(parseDisplaySyncMeta(f.meta)); });
test('new device pulls same-account saved display configuration', async () => { const v = preferences.createDisplayPreferences(); v.devices.mobile.enabled = true; v.sidebar.hidden = ['reports']; const f = fixture({ revision: 3, preferences: v }); await f.session.sync(); assert.deepEqual(f.local, v); assert.equal(f.writes, 0); assert.equal(f.status, 'ready'); });
test('first contact with differing independently saved schemes requires a choice', async () => { const v = preferences.createDisplayPreferences(), local = clone(v); local.sidebar.hidden = ['budget']; const f = fixture({ revision: 2, preferences: v }, local); await f.session.sync(); assert.equal(f.status, 'conflict'); assert.equal(f.writes, 0); assert.deepEqual(f.local, local); await f.session.resolve('remote'); assert.deepEqual(f.local, v); assert.equal(f.status, 'ready'); });
test('simultaneous edits stop instead of silently overwriting', async () => { const f = fixture(); f.edit(v => { v.devices.desktop.enabled = true; }); await f.session.sync(); f.edit(v => { v.sidebar.hidden = ['budget']; }); f.remoteEdit(v => { v.sidebar.hidden = ['accounts']; }); await f.session.sync(); assert.equal(f.status, 'conflict'); assert.equal(f.writes, 1); assert.deepEqual(f.local.sidebar.hidden, ['budget']); assert.deepEqual(f.remote.preferences.sidebar.hidden, ['accounts']); await f.session.resolve('local'); assert.equal(f.status, 'ready'); assert.deepEqual(f.remote.preferences.sidebar.hidden, ['budget']); });
test('a conflict choice cannot overwrite a newer unseen remote revision', async () => { const v = preferences.createDisplayPreferences(), local = clone(v); local.sidebar.hidden = ['budget']; const f = fixture({ revision: 2, preferences: v }, local); await f.session.sync(); f.remoteEdit(v => { v.sidebar.hidden = ['accounts']; }); await f.session.resolve('local'); assert.equal(f.status, 'conflict'); assert.equal(f.writes, 0); });
test('unsaved draft pauses incoming display changes', async () => { const v = preferences.createDisplayPreferences(); v.sidebar.hidden = ['budget']; const f = fixture({ revision: 2, preferences: v }); f.dirty = true; await f.session.sync(); assert.equal(f.status, 'waiting'); assert.deepEqual(f.local.sidebar.hidden, []); f.dirty = false; await f.session.sync(); assert.deepEqual(f.local.sidebar.hidden, ['budget']); });
test('offline errors preserve local data and a retry resumes', async () => { const f = fixture(); f.edit(v => { v.sidebar.hidden = ['fx']; }); const before = clone(f.local); f.fail = true; await f.session.sync(); assert.equal(f.status, 'error'); assert.deepEqual(f.local, before); f.fail = false; await f.session.sync(); assert.equal(f.status, 'ready'); assert.deepEqual(f.remote.preferences, before); });
test('metadata failure cannot claim a synchronized state', async () => { const f = fixture(); f.edit(v => { v.sidebar.hidden = ['fx']; }); f.metaFail = true; await f.session.sync(); assert.equal(f.status, 'error'); f.metaFail = false; await f.session.sync(); assert.equal(f.status, 'ready'); assert.equal(f.writes, 1); });
test('late read after account change is never applied or uploaded', async () => { const f = fixture(); let release; f.transport.read = () => new Promise(resolve => { release = resolve; }); const done = f.session.sync(); f.active = false; release({ revision: 9, preferences: preferences.createDisplayPreferences() }); await done; assert.equal(f.writes, 0); assert.equal(f.meta, null); });
test('disposed display session cannot start requests', async () => { const f = fixture(); let reads = 0; f.transport.read = async () => { reads++; return null; }; f.session.dispose(); await f.session.sync(); assert.equal(reads, 0); });

test('a save during an in-flight upload is serialized and uploads the newest saved version', async () => {
  const f = fixture(); f.edit(v => { v.sidebar.hidden = ['budget']; });
  const originalWrite = f.transport.write; let release, started;
  const uploading = new Promise(resolve => { started = resolve; });
  f.transport.write = async (...args) => { started(); await new Promise(resolve => { release = resolve; }); f.transport.write = originalWrite; return originalWrite(...args); };
  const first = f.session.sync(); await uploading;
  f.edit(v => { v.sidebar.hidden = ['reports']; }); const second = f.session.sync();
  assert.equal(first, second); release(); await first;
  for (let i = 0; i < 10 && f.remote?.preferences.sidebar.hidden[0] !== 'reports'; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.writes, 2); assert.deepEqual(f.remote.preferences.sidebar.hidden, ['reports']); assert.equal(f.status, 'ready');
});

test('a failed compare-and-swap cannot overwrite another device', async () => {
  const f = fixture(); f.edit(v => { v.sidebar.hidden = ['budget']; }); await f.session.sync();
  f.edit(v => { v.sidebar.hidden = ['reports']; });
  const originalWrite = f.transport.write;
  f.transport.write = async (...args) => { f.remoteEdit(v => { v.sidebar.hidden = ['accounts']; }); return originalWrite(...args); };
  await f.session.sync(); assert.equal(f.status, 'conflict'); assert.deepEqual(f.remote.preferences.sidebar.hidden, ['accounts']); assert.deepEqual(f.local.sidebar.hidden, ['reports']);
});

test('late upload acknowledgement after profile switch cannot persist metadata', async () => {
  const f = fixture(); f.edit(v => { v.sidebar.hidden = ['budget']; });
  let release, started; const uploading = new Promise(resolve => { started = resolve; });
  f.transport.write = value => { started(); return new Promise(resolve => { release = () => resolve({ revision: 1, preferences: value }); }); };
  const done = f.session.sync(); await uploading; f.active = false; release(); await done;
  assert.equal(f.meta, null); assert.deepEqual(f.local.sidebar.hidden, ['budget']);
});
test('remote and metadata reject unversioned or private payloads', () => { const v = preferences.createDisplayPreferences(); assert.equal(parseDisplayRemote({ revision: 0, preferences: v }), null); assert.equal(parseDisplayRemote({ revision: 1, preferences: { ...v, transactions: [] } }), null); assert.throws(() => parseDisplaySyncMeta(JSON.stringify({ version: 1, revision: 2, base: { ...v, token: 'synthetic-only' } }))); });
test('production transport only inserts display payload and CAS-patches preferences', async () => {
  const calls = [], value = preferences.createDisplayPreferences(); let reply = { data: { revision: 3, preferences: value }, error: null };
  const query = { select(v) { calls.push(['select', v]); return this; }, eq(k, v) { calls.push(['eq', k, v]); return this; }, abortSignal() { return this; }, maybeSingle() { return Promise.resolve(reply); }, insert(v) { calls.push(['insert', v]); return this; }, update(v) { calls.push(['update', v]); return this; } };
  const transport = createDisplayPreferenceTransport({ from(name) { calls.push(['from', name]); return query; } }, 'synthetic-user', () => true, new AbortController().signal);
  await transport.read(); await transport.write(value, null); await transport.write(value, 2);
  assert.ok(calls.filter(c => c[0] === 'from').every(c => c[1] === 'user_ui_preferences')); assert.deepEqual(Object.keys(calls.find(c => c[0] === 'insert')[1]).sort(), ['preferences', 'user_id']); assert.deepEqual(Object.keys(calls.find(c => c[0] === 'update')[1]), ['preferences']); assert.ok(calls.some(c => c[0] === 'eq' && c[1] === 'revision' && c[2] === 2)); reply = { data: null, error: { code: '23505' } }; assert.equal(await transport.write(value, null), null);
});

test('stalled display requests abort at a deadline even if the SDK ignores abort, and retry works', async () => {
  const value = preferences.createDisplayPreferences(), signals = []; let stalled = true;
  const query = { select() { return this; }, eq() { return this; }, insert() { return this; }, update() { return this; }, abortSignal(signal) { signals.push(signal); return this; }, maybeSingle() { return stalled ? new Promise(() => {}) : Promise.resolve({ data: { revision: 1, preferences: value }, error: null }); } };
  const session = new AbortController();
  const transport = createDisplayPreferenceTransport({ from() { return query; } }, 'synthetic-user', () => true, session.signal, 5);
  await assert.rejects(transport.read(), /Display request stopped/); assert.equal(signals[0].aborted, true); assert.equal(session.signal.aborted, false);
  await assert.rejects(transport.write(value, null), /Display request stopped/); assert.equal(signals[1].aborted, true);
  stalled = false; assert.equal((await transport.read()).revision, 1); assert.equal(signals[2].aborted, false);
});

test('account cancellation releases stalled display requests and prevents a queued request from starting', async () => {
  let calls = 0; const signals = [];
  const query = { select() { return this; }, eq() { return this; }, abortSignal(signal) { signals.push(signal); return this; }, maybeSingle() { calls++; return new Promise(() => {}); } };
  const controller = new AbortController(); const transport = createDisplayPreferenceTransport({ from() { return query; } }, 'synthetic-user', () => true, controller.signal, 1000);
  const pending = transport.read(); await Promise.resolve(); controller.abort(); await assert.rejects(pending, /Display request stopped/); assert.equal(signals[0].aborted, true);
  await assert.rejects(transport.read(), /Display session changed/); assert.equal(calls, 1);
  const next = new AbortController(); const queued = createDisplayPreferenceTransport({ from() { return query; } }, 'synthetic-user', () => true, next.signal, 1000).read(); next.abort(); await assert.rejects(queued); assert.equal(calls, 1);
});
