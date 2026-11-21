'use strict';

// Standalone synthetic Electron app: no application preload, settings or backend.
const path = require('node:path');
const DATABASE = 'wealth-atlas-investment-csv-mappings-v1';
const PROFILE_PREFIX = 'wa-csv-mapping-store-qa-';

if (process.type === 'browser') {
  const {app, BrowserWindow, protocol} = require('electron');
  const assert = require('node:assert/strict');
  const profile = process.argv.find(value => value.startsWith('--qa-profile='))?.slice(13);
  const temporary = path.resolve(require('node:os').tmpdir());
  const resolved = profile && path.resolve(profile);
  if (!resolved || path.dirname(resolved) !== temporary
    || !new RegExp('^' + PROFILE_PREFIX + '[a-f0-9-]{36}$').test(path.basename(resolved))) {
    console.error('INVESTMENT_CSV_STORE_FAIL {"stage":"synthetic-profile-required"}');
    app.exit(1);
  } else {
    require('node:fs').mkdirSync(resolved, {recursive: true});
    app.setPath('userData', resolved);
    app.setPath('sessionData', resolved);
    app.commandLine.appendSwitch('disable-background-networking');
    app.commandLine.appendSwitch('no-proxy-server');
    app.on('window-all-closed', () => {});
    protocol.registerSchemesAsPrivileged([{scheme: 'wa-csv-mapping-qa', privileges: {standard: true, secure: true}}]);
    const checks = [];
    let network = 0, stage = 'startup';
    const timer = setTimeout(() => {
      console.error('INVESTMENT_CSV_STORE_FAIL {"stage":"finite-timeout"}');
      app.exit(1);
    }, 45000);
    app.whenReady().then(async () => {
      protocol.handle('wa-csv-mapping-qa', () => new Response('<!doctype html><title>Synthetic mapping fixture</title>', {
        headers: {'Content-Type': 'text/html'},
      }));
      async function makeWindow() {
        const window = new BrowserWindow({show: false, webPreferences: {nodeIntegration: true, contextIsolation: false, sandbox: false}});
        window.webContents.session.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']}, (_details, callback) => {
          network++; callback({cancel: true});
        });
        await window.loadURL('wa-csv-mapping-qa://fixture/');
        await window.webContents.executeJavaScript(`require(${JSON.stringify(__filename)}).setup()`);
        return window;
      }
      const run = (window, code) => window.webContents.executeJavaScript(`(async () => { const {assert, model} = qa; ${code} })()`);
      let a = await makeWindow();
      let localRevision;
      if (process.argv.includes('--verify-restart')) {
        stage = 'new-process-persistence';
        localRevision = Number(process.argv.find(value => value.startsWith('--qa-revision='))?.slice(14));
        assert.ok(Number.isSafeInteger(localRevision));
        await run(a, `assert.equal((await qa.api.read()).revision, ${localRevision});
          assert.equal((await qa.api.read()).templates[0].name, 'SYNTHETIC FINAL');
          for (const kind of ['guest', 'cloud']) {
            qa.active = qa.scope(kind); const book = await qa.api.read();
            assert.equal(book.revision, 1); assert.equal(book.templates.length, 1);
          }
          qa.active = qa.scope('cloud', 'synthetic-B');
          assert.deepEqual(await qa.api.read(), model.createBook());
          assert.equal((await qa.rows()).length, 3);
          qa.active = qa.scope('local');`);
        checks.push('new process retains local guest and owner-scoped mappings without adopting another owner');
        stage = 'versionchange';
        await run(a, `const before = JSON.stringify(await qa.rows());
          const upgraded = await qa.open(2);
          await assert.rejects(qa.api.read());
          const fresh = qa.newStore(); await assert.rejects(fresh.read()); fresh.close();
          assert.equal(JSON.stringify(await qa.rows(upgraded)), before); upgraded.close();`);
        checks.push('versionchange and unsupported version fail closed and preserve the original rows');
      } else {
        const b = await makeWindow();
        stage = 'read-only-empty';
        await run(a, `assert.deepEqual(await qa.api.read(), model.createBook());
          await qa.api.read(); assert.equal((await qa.rows()).length, 0);`);
        checks.push('absent row reads return an empty book without persisting any row');
        stage = 'validation-before-open';
        await run(a, `let opens = 0;
          const store = qa.newStore({indexedDB: {open() { opens++; throw Error('SYNTHETIC ONLY'); }}});
          const empty = model.createBook(), valid = qa.add(empty, 'synthetic-validation');
          for (const bad of [{...valid, csv: 'SYNTHETIC ROW'}, {...valid, revision: 0},
            {...valid, revision: 2}, {...valid, templates: [{...valid.templates[0], account: 'SYNTHETIC ONLY'}]}]) {
            await assert.rejects(store.write(empty, bad), {code: 'CSV_TEMPLATE_INVALID'});
          }
          await assert.rejects(store.write({...empty, revision: -1}, valid));
          assert.equal(opens, 0); store.close();
          const active = qa.active;
          for (const scope of [{...active, kind: 'locked', key: 'locked'}, {...active, key: 'guest'},
            {...qa.scope('cloud'), ownerId: 'synthetic-B'}, {...active, epoch: NaN}]) {
            qa.active = scope; await assert.rejects(qa.api.read());
          }
          qa.active = active; assert.equal((await qa.rows()).length, 0);`);
        checks.push('invalid books revisions extra payloads locked scopes and inconsistent owners reject before opening');
        stage = 'two-window-cas';
        const race = await Promise.all([run(a, 'return qa.tryWrite(model.createBook(), qa.add(model.createBook(), "synthetic-left"));'),
          run(b, 'return qa.tryWrite(model.createBook(), qa.add(model.createBook(), "synthetic-right"));')]);
        assert.equal(race.filter(result => result.ok).length, 1);
        assert.equal(race.filter(result => result.code === 'CSV_TEMPLATE_CONFLICT').length, 1);
        await run(a, `assert.equal((await qa.api.read()).revision, 1); assert.equal((await qa.rows()).length, 1);
          const current = await qa.api.read(), next = qa.add(model.createBook(), 'synthetic-stale');
          await assert.rejects(qa.api.write(model.createBook(), next), {code: 'CSV_TEMPLATE_CONFLICT'});
          assert.equal((await qa.api.read()).templates.length, 1);
          const copy = await qa.api.read(); copy.templates[0].name = 'SYNTHETIC MUTATION';
          assert.deepEqual(await qa.api.read(), current);`);
        checks.push('two real renderer windows serialize CAS and reject stale writers without merge or aliasing');
        stage = 'exact-json-cas';
        await run(a, `const current = await qa.api.read(), next = model.renameTemplate(current, current.templates[0].id, 'SYNTHETIC RENAME');
          const reordered = {templates: current.templates, revision: current.revision, version: 1};
          await assert.rejects(qa.api.write(reordered, next), {code: 'CSV_TEMPLATE_INVALID'});
          const row = (await qa.rows()).find(row => row.key === 'local');
          await qa.replace({...row, book: {...row.book, templates: [{...row.book.templates[0], name: 'SYNTHETIC EXTERNAL'}]}});
          await assert.rejects(qa.api.write(current, next), {code: 'CSV_TEMPLATE_CONFLICT'});
          await qa.replace(row); assert.deepEqual(await qa.api.write(current, next), next);
          await assert.rejects(qa.api.write(current, next), {code: 'CSV_TEMPLATE_CONFLICT'});`);
        checks.push('exact prior JSON and revision are both required including duplicate and same-revision divergent writes');
        stage = 'quota-and-abort';
        await run(a, `const before = JSON.stringify(await qa.rows());
          for (const mode of ['quota', 'abort']) {
            const original = IDBObjectStore.prototype.put;
            IDBObjectStore.prototype.put = function(...args) {
              if (this.name !== 'books') return original.apply(this, args);
              if (mode === 'quota') throw new DOMException('SYNTHETIC ONLY', 'QuotaExceededError');
              const request = original.apply(this, args); queueMicrotask(() => this.transaction.abort()); return request;
            };
            try { const book = await qa.api.read(); await assert.rejects(qa.api.write(book, model.renameTemplate(book, book.templates[0].id, 'SYNTHETIC FAILED'))); }
            finally { IDBObjectStore.prototype.put = original; }
            assert.equal(JSON.stringify(await qa.rows()), before);
          }`);
        checks.push('quota and asynchronous transaction abort roll back atomically and preserve the prior book');
        stage = 'corrupted-rows';
        await run(a, `const row = (await qa.rows()).find(row => row.key === 'local'), expected = row.book;
          const next = model.renameTemplate(expected, expected.templates[0].id, 'SYNTHETIC NOT SAVED');
          for (const corrupt of [{...row, version: 9}, {...row, owner: 'synthetic-other'}, {...row, extra: 'SYNTHETIC ONLY'},
            {...row, book: null}, {...row, book: {...row.book, version: 9}},
            {...row, book: {...row.book, csv: 'SYNTHETIC ONLY'}},
            ...[' SYNTHETIC RENAME ', 'ＳＹＮＴＨＥＴＩＣ'].map(name =>
              ({...row, book: {...row.book, templates: [{...row.book.templates[0], name}]}})),
            ...[{unknown: 'SYNTHETIC ONLY'}, {...row.book.templates[0].mapping, price: 'SYNTHETIC MISSING'},
              {...row.book.templates[0].mapping, price: 'quantity'}, {...row.book.templates[0].mapping, price: 0},
              {...row.book.templates[0].mapping, account: 'SYNTHETIC ONLY'}].map(mapping =>
              ({...row, book: {...row.book, templates: [{...row.book.templates[0], mapping}]}}))]) {
            await qa.replace(corrupt); const before = JSON.stringify(await qa.rows());
            await assert.rejects(qa.api.read(), {code: 'CSV_TEMPLATE_CORRUPT'});
            await assert.rejects(qa.api.write(expected, next), {code: 'CSV_TEMPLATE_CORRUPT'});
            assert.equal(JSON.stringify(await qa.rows()), before);
          }
          await qa.replace(row);`);
        checks.push('unknown wrapper schema owner mismatch malformed mappings and extra data fail without repairing or overwriting corruption');
        stage = 'scope-await-fences';
        await run(a, `const before = JSON.stringify(await qa.rows());
          for (const mode of ['read', 'write', 'mutated-epoch']) {
            const active = qa.active, current = await qa.api.read(), delayed = qa.delayed();
            const pending = (mode === 'read' ? delayed.store.read() : delayed.store.write(current,
              model.renameTemplate(current, current.templates[0].id, 'SYNTHETIC STALE'))).then(() => false, failure => failure.code);
            await delayed.started;
            if (mode === 'mutated-epoch') active.epoch++;
            else { qa.active = qa.scope('cloud', 'synthetic-B'); qa.active = {...active}; }
            delayed.release(); assert.equal(await pending, 'CSV_TEMPLATE_SCOPE_CHANGED');
            delayed.store.close(); if (mode === 'mutated-epoch') active.epoch--; qa.active = active;
            assert.equal(JSON.stringify(await qa.rows()), before);
          }`);
        checks.push('await fences reject A-to-B-to-A replacement identities and in-place epoch mutation');
        stage = 'transaction-scope-fences';
        await run(a, `const before = JSON.stringify(await qa.rows());
          for (const method of ['get', 'put']) {
            const current = await qa.api.read();
            await qa.switchDuring(method, () => qa.api.write(current,
              model.renameTemplate(current, current.templates[0].id, 'SYNTHETIC STALE')));
            assert.equal(JSON.stringify(await qa.rows()), before);
          }
          await qa.switchDuring('get', () => qa.api.read());
          await qa.switchDuring('complete', () => qa.api.read());
          assert.equal(JSON.stringify(await qa.rows()), before);`);
        checks.push('scope changes abort queued reads and writes and reject stale read completion');
        stage = 'failed-open-and-close';
        await run(a, `const before = JSON.stringify(await qa.rows());
          for (const mode of ['missing', 'throw', 'error', 'blocked']) {
            let request;
            const factory = mode === 'missing' ? null : {open() {
              if (mode === 'throw') throw Error('SYNTHETIC ONLY');
              request = {}; queueMicrotask(() => request[mode === 'blocked' ? 'onblocked' : 'onerror']()); return request;
            }};
            const store = qa.newStore({indexedDB: factory}); await assert.rejects(store.read());
            let didClose = false;
            if (request) { request.result = {close() { didClose = true; }}; request.onsuccess(); assert.equal(didClose, true); }
            store.close();
          }
          for (const mode of ['read', 'write']) {
            const book = await qa.api.read(), delayed = qa.delayed();
            const pending = (mode === 'read' ? delayed.store.read() : delayed.store.write(book,
              model.renameTemplate(book, book.templates[0].id, 'SYNTHETIC CLOSED'))).then(() => false, () => true);
            await delayed.started; delayed.store.close();
            const reopened = delayed.store.read(); delayed.release();
            assert.equal(await pending, true); assert.deepEqual(await reopened, book); delayed.store.close();
          }
          const current = await qa.api.read(), original = IDBObjectStore.prototype.put;
          IDBObjectStore.prototype.put = function(...args) { const request = original.apply(this, args);
            if (this.name === 'books') request.addEventListener('success', () => qa.api.close()); return request; };
          try { await assert.rejects(qa.api.write(current, model.renameTemplate(current, current.templates[0].id, 'SYNTHETIC CLOSED'))); }
          finally { IDBObjectStore.prototype.put = original; }
          assert.deepEqual(await qa.api.read(), current);
          assert.equal(JSON.stringify(await qa.rows()), before);`);
        checks.push('failed opens preserve rows and reusable close cancels old reads writes and transactions before a fresh generation reopens');
        stage = 'browser-without-node-globals';
        await run(a, `const before = JSON.stringify(await qa.rows());
          const browser = qa.browserFactory();
          const store = browser.create({...qa.options, indexedDB: undefined});
          const book = await store.read(); assert.deepEqual(book, await qa.api.read());
          const next = model.renameTemplate(book, book.templates[0].id, 'SYNTHETIC BROWSER');
          assert.deepEqual(await store.write(book, next), next);
          const raw = (await qa.rows()).find(row => row.key === 'local');
          assert.equal(raw.book.templates[0].name, 'SYNTHETIC BROWSER');
          store.close(); await qa.replace({...raw, book});
          assert.equal(JSON.stringify(await qa.rows()), before);`);
        checks.push('browser-evaluated store and shared validator persist templates with no Buffer process or Node require');
        stage = 'transient-open-retry-boundaries';
        await run(a, `const before = JSON.stringify(await qa.rows());
          for (const mode of ['throw', 'error', 'blocked', 'timeout']) {
            const clock = qa.fakeClock(), browser = qa.browserFactory(clock);
            let attempts = 0, failedRequest;
            const factory = {open(name, version) {
              assert.equal(name, qa.database); assert.equal(version, 1);
              if (++attempts > 1) return indexedDB.open(name, version);
              if (mode === 'throw') throw Error('SYNTHETIC ONLY');
              failedRequest = {};
              if (mode !== 'timeout') queueMicrotask(() => failedRequest[mode === 'blocked' ? 'onblocked' : 'onerror']());
              return failedRequest;
            }};
            const store = browser.create({...qa.options, indexedDB: factory});
            const first = store.read().then(() => false, () => true);
            if (mode === 'timeout') clock.fire();
            assert.equal(await first, true);
            const retry = store.read();
            if (failedRequest) {
              // A failed old attempt can still receive upgrade/error/success while
              // the next attempt is opening. None may invalidate the new attempt.
              let aborted = false, closed = false;
              failedRequest.result = {close() { closed = true; }, objectStoreNames: {length: 0},
                createObjectStore() { assert.fail('late upgrade must not create'); }};
              failedRequest.transaction = {abort() { aborted = true; }};
              failedRequest.onupgradeneeded({oldVersion: 0});
              failedRequest.onerror(); failedRequest.onsuccess();
              assert.equal(aborted, true); assert.equal(closed, true);
            }
            assert.deepEqual(await retry, await qa.api.read()); assert.equal(attempts, 2);
            const book = await store.read();
            const next = model.renameTemplate(book, book.templates[0].id, 'SYNTHETIC RETRY');
            assert.deepEqual(await store.write(book, next), next);
            store.close(); const row = (await qa.rows()).find(row => row.key === 'local');
            await qa.replace({...row, book}); assert.equal(JSON.stringify(await qa.rows()), before);
            assert.equal(clock.pending(), 0);
          }
          // Concurrent retries share one open; all callers use their own scope fence.
          let opens = 0;
          const store = qa.newStore({indexedDB: {open(name, version) { opens++; return indexedDB.open(name, version); }}});
          const pair = await Promise.all([store.read(), store.read()]);
          assert.deepEqual(pair[0], pair[1]); assert.equal(opens, 1); store.close();`);
        checks.push('same-instance retries recover from throw error blocked and timeout while ignoring late failed-attempt callbacks');
        stage = 'scope-separation-and-mutations';
        await run(a, `for (const kind of ['guest', 'cloud']) {
            qa.active = qa.scope(kind); const empty = await qa.api.read(); assert.deepEqual(empty, model.createBook());
            await qa.api.write(empty, qa.add(empty, 'synthetic-' + kind));
          }
          qa.active = qa.scope('cloud', 'synthetic-B'); assert.deepEqual(await qa.api.read(), model.createBook());
          assert.equal((await qa.rows()).length, 3);
          qa.active = qa.scope('local'); let book = await qa.api.read();
          book = await qa.api.write(book, model.deleteTemplate(book, book.templates[0].id)); assert.equal(book.templates.length, 0);
          book = await qa.api.write(book, qa.add(book, 'synthetic-final'));
          book = await qa.api.write(book, model.renameTemplate(book, book.templates[0].id, 'SYNTHETIC FINAL'));
          qa.api.close(); qa.api = qa.newStore(); assert.deepEqual(await qa.api.read(), book);`);
        checks.push('local guest and cloud-owner isolation with explicit add rename delete and refresh persistence');
        localRevision = await run(a, 'return (await qa.api.read()).revision;');
        await run(a, 'qa.api.close();'); a.destroy();
        await run(b, 'qa.api.close();'); b.destroy();
        a = await makeWindow();
        await run(a, `assert.equal((await qa.api.read()).revision, ${localRevision});
          assert.equal((await qa.api.read()).templates[0].name, 'SYNTHETIC FINAL');
          assert.deepEqual((await indexedDB.databases()).map(db => db.name), [qa.database]);`);
        checks.push('renderer recreation retains mappings and no other database was opened');
      }
      assert.equal(network, 0);
      await run(a, 'qa.api.close();'); a.destroy();
      clearTimeout(timer);
      console.log('INVESTMENT_CSV_STORE_PASS ' + JSON.stringify({checks, localRevision, realBackendRequests: network, productionDataAccessed: false}));
      app.exit(0);
    }).catch(() => {
      clearTimeout(timer);
      // Deliberately omit error messages, stacks, paths and template contents.
      console.error('INVESTMENT_CSV_STORE_FAIL ' + JSON.stringify({stage, completedChecks: checks.length}));
      app.exit(1);
    });
  }
} else {
  exports.setup = () => {
    const assert = require('node:assert/strict');
    const model = require('../desktop/investment/csv-mapping.cjs');
    const {createCsvTemplateStore} = require('../desktop/investment/csv-template-store.cjs');
    const qa = globalThis.qa = {assert, model, database: DATABASE};
    let epoch = 0;
    qa.scope = (kind, owner = 'synthetic-A') => ({kind, key: kind === 'cloud' ? 'cloud:' + owner : kind,
      ownerId: kind === 'cloud' ? owner : null, epoch: ++epoch});
    qa.active = qa.scope('local');
    const options = {getScope: () => qa.active, assertScope: scope => assert.equal(scope, qa.active),
      indexedDB: {open(name, version) { assert.equal(name, DATABASE); assert.equal(version, 1); return indexedDB.open(name, version); }}};
    qa.options = options;
    qa.newStore = overrides => createCsvTemplateStore({...options, ...overrides});
    qa.api = qa.newStore();
    qa.add = book => model.addTemplate(book, {id: require('node:crypto').randomUUID(), name: 'SYNTHETIC TEMPLATE', kind: 'snapshot',
      headers: ['security_id', 'name', 'quantity', 'price'],
      mapping: {security_id: 'security_id', name: 'name', quantity: 'quantity', price: 'price'}});
    qa.tryWrite = async (expected, next) => {
      try { await qa.api.write(expected, next); return {ok: true}; }
      catch (failure) { return {ok: false, code: failure.code}; }
    };
    qa.open = version => new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, version);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(Error('SYNTHETIC FIXTURE OPEN FAILURE'));
      request.onblocked = () => reject(Error('SYNTHETIC FIXTURE BLOCKED'));
    });
    qa.rows = async supplied => {
      const db = supplied || await qa.open(1);
      try { return await new Promise((resolve, reject) => {
        const tx = db.transaction('books'), request = tx.objectStore('books').getAll();
        let rows; request.onsuccess = () => { rows = request.result; };
        tx.oncomplete = () => resolve(rows); tx.onabort = () => reject(Error('SYNTHETIC FIXTURE READ FAILURE'));
      }); } finally { if (!supplied) db.close(); }
    };
    qa.replace = async row => {
      const db = await qa.open(1);
      try { await new Promise((resolve, reject) => {
        const tx = db.transaction('books', 'readwrite'); tx.objectStore('books').put(row);
        tx.oncomplete = resolve; tx.onabort = () => reject(Error('SYNTHETIC FIXTURE WRITE FAILURE'));
      }); } finally { db.close(); }
    };
    qa.delayed = () => {
      let release, started, attempts = 0;
      const signal = new Promise(resolve => { started = resolve; });
      const store = qa.newStore({indexedDB: {open(name, version) {
        assert.equal(name, DATABASE); assert.equal(version, 1);
        if (++attempts > 1) return indexedDB.open(name, version);
        const actual = indexedDB.open(name, version), proxy = {};
        for (const key of ['result', 'transaction']) Object.defineProperty(proxy, key, {get: () => actual[key]});
        for (const event of ['onupgradeneeded', 'onerror', 'onblocked']) actual[event] = value => proxy[event]?.(value);
        actual.onsuccess = event => { release = () => proxy.onsuccess(event); started(); };
        return proxy;
      }}});
      return {store, started: signal, release: () => release()};
    };
    qa.switchDuring = async (method, operation) => {
      const active = qa.active, prototype = method === 'complete' ? IDBDatabase.prototype : IDBObjectStore.prototype;
      const key = method === 'complete' ? 'transaction' : method, original = prototype[key];
      let switched = false;
      prototype[key] = function(...args) {
        const result = original.apply(this, args);
        if (method === 'complete' || this.name === 'books') result.addEventListener(method === 'complete' ? 'complete' : 'success', () => {
          if (!switched) { switched = true; qa.active = {...active}; }
        });
        return result;
      };
      try { await assert.rejects(operation(), {code: 'CSV_TEMPLATE_SCOPE_CHANGED'}); assert.equal(switched, true); }
      finally { prototype[key] = original; qa.active = active; }
    };
    qa.fakeClock = () => {
      let serial = 0;
      const timers = new Map();
      return {setTimeout(callback) { const id = ++serial; timers.set(id, callback); return id; },
        clearTimeout(id) { timers.delete(id); },
        fire() { const entry = timers.entries().next().value; assert.ok(entry); timers.delete(entry[0]); entry[1](); },
        pending: () => timers.size};
    };
    qa.browserFactory = clock => {
      const fs = require('node:fs');
      const mappingSource = fs.readFileSync(path.join(__dirname, '../desktop/investment/csv-mapping.cjs'), 'utf8');
      const storeSource = fs.readFileSync(path.join(__dirname, '../desktop/investment/csv-template-store.cjs'), 'utf8');
      const mappingModule = {exports: {}}, storeModule = {exports: {}};
      // Shadow Node-only globals; require is restricted to the pure mapping API.
      new Function('module', 'exports', 'Buffer', 'process', 'require', mappingSource)(mappingModule, mappingModule.exports,
        undefined, undefined, () => { throw Error('SYNTHETIC BROWSER REQUIRE FORBIDDEN'); });
      new Function('module', 'exports', 'Buffer', 'process', 'require', 'setTimeout', 'clearTimeout', storeSource)(
        storeModule, storeModule.exports, undefined, undefined,
        name => { assert.equal(name, './csv-mapping.cjs'); return mappingModule.exports; },
        clock ? clock.setTimeout : globalThis.setTimeout.bind(globalThis),
        clock ? clock.clearTimeout : globalThis.clearTimeout.bind(globalThis));
      return {create: storeModule.exports.createCsvTemplateStore};
    };
  };
}
