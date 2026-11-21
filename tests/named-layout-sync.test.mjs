import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import * as preferences from '../lib/display-preferences.ts';
const { createDisplayPreferences } = preferences;
const require = createRequire(import.meta.url), ts = require('typescript');
function compile(file, dependencies) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', code)(id => { if (!(id in dependencies)) throw new Error('Unexpected dependency'); return dependencies[id]; }, module, module.exports);
  return module.exports;
}
const model = compile('../lib/named-display-layouts.ts', { './display-preferences': preferences });
const syncModule = compile('../lib/named-layout-sync.ts', { './named-display-layouts': model });
const { createNamedLayoutSync, parseNamedLayoutRemote } = syncModule;
const { createNamedLayoutTransport } = compile('../lib/named-layout-transport.ts', { './named-display-layouts': model, './named-layout-sync': syncModule });
const clone = structuredClone;
const book = (name = '日常') => ({ version: 1, schemes: [{ id: '00000000-0000-4000-8000-000000000001', name, preferences: createDisplayPreferences() }] });
const empty = () => ({ version: 1, schemes: [] });
function fixture(initial = null, local = empty()) {
  let remote = clone(initial), envelope = { version: 1, library: clone(local), base: null }, raw = null, active = true, status;
  let writes = 0, fail = false, commitFail = false;
  const transport = { async read() { if (fail) throw new Error('offline'); return clone(remote); }, async write(library, revision) { if (fail) throw new Error('offline'); writes++; if (revision !== (remote?.revision ?? null)) return null; remote = { revision: (revision ?? 0) + 1, library: clone(library) }; return clone(remote); } };
  const session = createNamedLayoutSync({ transport, active: () => active, local: () => ({ envelope: clone(envelope), raw }), commit: async (value, expected) => { if (commitFail || !active || expected !== raw) return false; envelope = clone(value); raw = JSON.stringify(envelope); return true; }, onStatus: value => { status = value; } });
  return { session, transport, get remote() { return remote; }, get envelope() { return envelope; }, get status() { return status; }, get writes() { return writes; }, set active(v) { active = v; }, set fail(v) { fail = v; }, set commitFail(v) { commitFail = v; }, edit(fn) { fn(envelope.library); raw = JSON.stringify(envelope); }, remoteEdit(fn) { fn(remote.library); remote.revision++; } };
}
test('empty untouched library creates no cloud row', async () => { const f = fixture(); await f.session.sync(); assert.equal(f.writes, 0); assert.equal(f.status, 'ready'); });
test('complete snapshots upload to separate library and retain all three devices', async () => { const value = book(); value.schemes[0].preferences.devices.mobile.enabled = true; const f = fixture(null, value); await f.session.sync(); assert.deepEqual(f.remote.library, value); assert.deepEqual(f.envelope.base.library, value); assert.equal(f.status, 'ready'); });
test('another device receives library without applying current display', async () => { const current = createDisplayPreferences(), before = clone(current), f = fixture({ revision: 3, library: book() }); await f.session.sync(); assert.deepEqual(f.envelope.library, book()); assert.deepEqual(current, before); assert.equal(f.writes, 0); });
test('independent local and remote libraries conflict until an explicit choice', async () => { const f = fixture({ revision: 4, library: book('远端') }, book('本机')); await f.session.sync(); assert.equal(f.status, 'conflict'); assert.equal(f.writes, 0); await f.session.resolve('remote', f.session.getConflictToken()); assert.deepEqual(f.envelope.library, book('远端')); assert.equal(f.status, 'ready'); });
test('local conflict resolution writes only at the observed remote revision', async () => { const f = fixture({ revision: 4, library: book('远端') }, book('本机')); await f.session.sync(); await f.session.resolve('local', f.session.getConflictToken()); assert.equal(f.remote.revision, 5); assert.equal(f.remote.library.schemes[0].name, '本机'); });
test('a changed remote invalidates the confirmation rather than overwriting it', async () => { const f = fixture({ revision: 4, library: book('远端') }, book('本机')); await f.session.sync(); const token = f.session.getConflictToken(); f.remoteEdit(v => { v.schemes[0].name = '更新'; }); await f.session.resolve('local', token); assert.equal(f.status, 'conflict'); assert.equal(f.writes, 0); });
test('a changed local library also invalidates the conflict confirmation', async () => { const f = fixture({ revision: 4, library: book('远端') }, book('本机')); await f.session.sync(); const token = f.session.getConflictToken(); f.edit(v => { v.schemes[0].name = '本机更新'; }); await f.session.resolve('remote', token); assert.equal(f.status, 'conflict'); assert.equal(f.envelope.library.schemes[0].name, '本机更新'); });
test('background polling cannot authorize an old confirmation for a newer remote revision', async () => {
  const f = fixture({ revision: 4, library: book('远端') }, book('本机')); await f.session.sync();
  const token = f.session.getConflictToken(); f.remoteEdit(v => { v.schemes[0].name = '后台取得的新版本'; });
  await f.session.sync(); assert.equal(f.session.getConflictToken().remote, 5);
  await f.session.resolve('local', token); assert.equal(f.writes, 0); assert.equal(f.remote.revision, 5);
  assert.equal(f.remote.library.schemes[0].name, '后台取得的新版本'); assert.equal(f.status, 'conflict');
  await f.session.resolve('local', f.session.getConflictToken()); assert.equal(f.remote.revision, 6);
});
test('background polling cannot authorize an old confirmation for newer local content', async () => {
  const f = fixture({ revision: 4, library: book('远端') }, book('本机')); await f.session.sync();
  const token = f.session.getConflictToken(); f.edit(v => { v.schemes[0].name = '新本机'; }); await f.session.sync();
  await f.session.resolve('remote', token); assert.equal(f.envelope.library.schemes[0].name, '新本机'); assert.equal(f.status, 'conflict');
  await f.session.resolve('remote', null); assert.equal(f.envelope.library.schemes[0].name, '新本机');
});
test('explicit resolution retains its own outcome when a queued sync starts immediately', async () => {
  const f=fixture({revision:4,library:book('远端')},book('本机'));await f.session.sync();const token=f.session.getConflictToken();
  let releaseFirst,releaseNext,startedFirst,startedNext,reads=0;const firstStarted=new Promise(r=>{startedFirst=r;}),nextStarted=new Promise(r=>{startedNext=r;});
  const original=f.transport.read;f.transport.read=async()=>{reads++;if(reads===1){startedFirst();await new Promise(r=>{releaseFirst=r;});}else{startedNext();await new Promise(r=>{releaseNext=r;});}return original();};
  const resolving=f.session.resolve('remote',token);await firstStarted;f.session.sync();releaseFirst();
  assert.equal(await resolving,'ready');await nextStarted;assert.equal(f.session.getStatus(),'syncing');assert.deepEqual(f.envelope.library,book('远端'));releaseNext();f.session.dispose();
});
test('a confirmation during background work cannot borrow that operation result', async () => {
  const f=fixture({revision:4,library:book('远端')},book('本机'));await f.session.sync();const token=f.session.getConflictToken();
  let release,started;const began=new Promise(r=>{started=r;}),original=f.transport.read;f.transport.read=async()=>{started();await new Promise(r=>{release=r;});return original();};
  const background=f.session.sync();await began;assert.equal(await f.session.resolve('remote',token),'waiting');assert.deepEqual(f.envelope.library,book('本机'));release();await background;
  assert.equal(f.status,'conflict');assert.equal(f.writes,0);
});
test('a stale offline library cannot silently resurrect a remotely deleted template', async () => { const f = fixture(null, book()); await f.session.sync(); f.remoteEdit(v => { v.schemes = []; }); f.edit(v => { v.schemes[0].name = '离线修改'; }); await f.session.sync(); assert.equal(f.status, 'conflict'); assert.equal(f.remote.library.schemes.length, 0); assert.equal(f.writes, 1); });
test('unchanged stale library adopts deletion without altering applied preferences', async () => { const f = fixture(null, book()); await f.session.sync(); f.remoteEdit(v => { v.schemes = []; }); await f.session.sync(); assert.equal(f.envelope.library.schemes.length, 0); assert.equal(f.status, 'ready'); });
test('offline library mutations survive a failed request and can retry', async () => { const f = fixture(null, book()); f.fail = true; await f.session.sync(); assert.equal(f.status, 'error'); assert.deepEqual(f.envelope.library, book()); f.fail = false; await f.session.sync(); assert.equal(f.status, 'ready'); });
test('failed atomic acknowledgement never reports synchronized', async () => { const f = fixture(null, book()); f.commitFail = true; await f.session.sync(); assert.notEqual(f.status, 'ready'); f.commitFail = false; await f.session.sync(); assert.equal(f.writes, 1); assert.equal(f.status, 'ready'); });
test('local mutation during upload is preserved, not overwritten by stale acknowledgement', async () => {
  const f = fixture(null, book()); let release, started; const begin = new Promise(r => { started = r; }), original = f.transport.write;
  f.transport.write = async (...args) => { started(); await new Promise(r => { release = r; }); return original(...args); };
  const run = f.session.sync(); await begin; f.edit(v => { v.schemes[0].name = '较新本机'; }); release(); await run;
  assert.equal(f.envelope.library.schemes[0].name, '较新本机'); assert.notEqual(f.status, 'ready'); assert.equal(f.envelope.base, null);
});
test('competing cloud writer cannot be silently overwritten', async () => { const f = fixture(null, book()); await f.session.sync(); f.edit(v => { v.schemes[0].name = '本机'; }); const original = f.transport.write; f.transport.write = async (...a) => { f.remoteEdit(v => { v.schemes[0].name = '其他设备'; }); return original(...a); }; await f.session.sync(); assert.equal(f.status, 'conflict'); assert.equal(f.remote.library.schemes[0].name, '其他设备'); });
test('late responses after owner change cannot mutate the new owner', async () => { const f = fixture(); let release; f.transport.read = () => new Promise(r => { release = r; }); const run = f.session.sync(); f.active = false; release({ revision: 2, library: book() }); await run; assert.equal(f.envelope.base, null); assert.equal(f.writes, 0); assert.equal(f.envelope.library.schemes.length, 0); });
test('late upload after disposal cannot persist an acknowledgement', async () => { const f = fixture(null, book()); let release; f.transport.write = library => new Promise(r => { release = () => r({ revision: 1, library }); }); const run = f.session.sync(); while (!release) await Promise.resolve(); f.session.dispose(); release(); await run; assert.equal(f.envelope.base, null); });
test('malformed or private remote snapshots are rejected', () => { assert.equal(parseNamedLayoutRemote({ revision: 1, library: { ...book(), transactions: [] } }), null); for (const revision of [0,-1,1.5,2147483648,'1']) assert.equal(parseNamedLayoutRemote({ revision, library: book() }), null); });
function transportFixture(timeout = 100) {
  const calls = []; let reply = { data: { revision: 2, library: book() }, error: null }, stalled = false;
  const q = { select(v) { calls.push(['select',v]); return this; }, eq(k,v) { calls.push(['eq',k,v]); return this; }, insert(v) { calls.push(['insert',v]); return this; }, update(v) { calls.push(['update',v]); return this; }, abortSignal(s) { calls.push(['signal',s]); return this; }, maybeSingle() { return stalled ? new Promise(() => {}) : Promise.resolve(reply); } };
  const abort = new AbortController(); const transport = createNamedLayoutTransport({ from(n) { calls.push(['table',n]); return q; } }, 'synthetic-owner', () => true, abort.signal, timeout);
  return { transport, calls, abort, set reply(v) { reply=v; }, set stalled(v) { stalled=v; } };
}
test('transport never accesses financial or legacy display tables', async () => { const f = transportFixture(); await f.transport.read(); await f.transport.write(book(),null); await f.transport.write(book(),1); assert.ok(f.calls.filter(c=>c[0]==='table').every(c=>c[1]==='user_ui_layout_libraries')); assert.deepEqual(Object.keys(f.calls.find(c=>c[0]==='insert')[1]).sort(),['library','user_id']); assert.deepEqual(Object.keys(f.calls.find(c=>c[0]==='update')[1]),['library']); assert.ok(f.calls.some(c=>c[0]==='eq'&&c[1]==='revision'&&c[2]===1)); });
test('insert collision and stale CAS are explicit conflicts', async () => { const f=transportFixture(); f.reply={data:null,error:{code:'23505'}}; assert.equal(await f.transport.write(book(),null),null); f.reply={data:null,error:null}; assert.equal(await f.transport.write(book(),1),null); });
test('stalled requests time out even when SDK ignores cancellation and can retry', async () => { const f=transportFixture(5); f.stalled=true; await assert.rejects(f.transport.read(),/Layout request stopped/); assert.equal(f.calls.find(c=>c[0]==='signal')[1].aborted,true); f.stalled=false; assert.equal((await f.transport.read()).revision,2); });
test('aborted sessions cannot start or complete a queued request', async () => { const f=transportFixture(); const pending=f.transport.read(); f.abort.abort(); await assert.rejects(pending); assert.equal(f.calls.filter(c=>c[0]==='table').length,0); });
test('invalid revisions or financial payloads cannot reach the client', async () => { const f=transportFixture(); await assert.rejects(f.transport.write({...book(),accounts:[]},1)); await assert.rejects(f.transport.write(book(),0)); assert.equal(f.calls.length,0); });
