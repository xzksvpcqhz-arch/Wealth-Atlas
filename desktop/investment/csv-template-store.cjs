'use strict';

// Mapping metadata only. Never open the financial database or contact a backend.
const {createBook, validateBook} = require('./csv-mapping.cjs');
const DATABASE = 'wealth-atlas-investment-csv-mappings-v1';
const TIMEOUT_MS = 10000;
const failures = new WeakSet();
const error = (code = 'CSV_TEMPLATE_UNAVAILABLE', status = 503) => {
  const failure = Object.assign(new Error(code === 'CSV_TEMPLATE_CONFLICT'
    ? 'CSV mappings changed. Refresh before saving; no templates were overwritten.'
    : 'CSV mappings are unavailable or invalid. Existing templates were not replaced.'),
    {code, status});
  failures.add(failure);
  return failure;
};
const safeError = failure => failures.has(failure) ? failure : error();

function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && Object.getPrototypeOf(prototype) !== null) throw error();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== allowed.length || keys.some(key => !allowed.includes(key))) throw error();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw error();
  }
}

function jsonData(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object') throw error();
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1) throw error();
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw error();
      jsonData(descriptor.value);
    }
  } else {
    const keys = Reflect.ownKeys(value);
    fields(value, keys.filter(key => typeof key === 'string'));
    for (const key of keys) jsonData(value[key]);
  }
}

// Reject extra fields rather than silently persisting CSV rows, account details,
// or arbitrary caller state alongside a template. Keep JSON order for exact CAS.
function bookSnapshot(value, code = 'CSV_TEMPLATE_INVALID') {
  try {
    fields(value, ['version', 'revision', 'templates']);
    if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
      || !Array.isArray(value.templates)) throw error();
    for (const template of value.templates) {
      fields(template, ['id', 'name', 'kind', 'headers', 'mapping']);
    }
    jsonData(value);
    const json = JSON.stringify(value);
    if (json.length > 2000000) throw error();
    const book = JSON.parse(json);
    const validated = validateBook(book);
    // A validator must not turn a malformed stored row into a valid replacement.
    if (JSON.stringify(validated) !== json || JSON.stringify(book) !== json) throw error();
    return {book, json};
  } catch {
    throw error(code, code === 'CSV_TEMPLATE_CORRUPT' ? 422 : 400);
  }
}

function createCsvTemplateStore({getScope, assertScope, indexedDB = globalThis.indexedDB}) {
  let connection = null, pending = null, generation = 0, unavailable = false;
  const transactions = new Set();
  const ensureOpen = () => { if (unavailable) throw error(); };

  function capture() {
    let scope, identity;
    const lease = generation;
    try {
      ensureOpen();
      scope = getScope();
      identity = {kind: scope.kind, key: scope.key, owner: scope.ownerId, epoch: scope.epoch};
      const {kind, key, owner, epoch} = identity;
      if (!Number.isSafeInteger(epoch) || epoch < 0
        || !['local', 'guest', 'cloud'].includes(kind)
        || (kind === 'cloud'
          ? typeof owner !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(owner) || key !== `cloud:${owner}`
          : owner !== null || key !== kind)) throw error();
    } catch { throw error('CSV_TEMPLATE_SCOPE_CHANGED', 409); }
    const guard = () => {
      try {
        ensureOpen();
        if (generation !== lease || getScope() !== scope || scope.kind !== identity.kind || scope.key !== identity.key
          || scope.ownerId !== identity.owner || scope.epoch !== identity.epoch
          || assertScope(scope) === false) throw error();
        // assertScope is supplied by the caller; do not trust it to be side-effect free.
        if (generation !== lease || getScope() !== scope || scope.kind !== identity.kind || scope.key !== identity.key
          || scope.ownerId !== identity.owner || scope.epoch !== identity.epoch) throw error();
      } catch { throw error('CSV_TEMPLATE_SCOPE_CHANGED', 409); }
    };
    guard();
    return {...identity, guard};
  }

  function invalidate(db, lease) {
    if (connection !== db || generation !== lease) return;
    unavailable = true;
    for (const transaction of transactions) transaction.cancel(error());
    pending?.cancel();
    connection?.close();
    connection = null;
  }

  function open() {
    ensureOpen();
    if (connection) return Promise.resolve(connection);
    if (pending) return pending.promise;
    const state = {}, lease = generation;
    pending = state;
    state.promise = new Promise((resolve, reject) => {
      let request, settled = false;
      const timer = setTimeout(() => fail(), TIMEOUT_MS);
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error());
      };
      state.cancel = fail;
      try {
        if (!indexedDB || typeof indexedDB.open !== 'function') throw error();
        request = indexedDB.open(DATABASE, 1);
      } catch { fail(); return; }
      // Transient failures settle only this attempt. An explicit read can retry
      // on the same UI-owned instance; late events cannot poison that retry.
      request.onblocked = request.onerror = fail;
      request.onupgradeneeded = event => {
        try {
          if (settled || generation !== lease || unavailable || event.oldVersion !== 0
            || request.result.objectStoreNames.length !== 0) throw error();
          request.result.createObjectStore('books', {keyPath: 'key'});
        } catch {
          try { request.transaction.abort(); } catch { /* already inactive */ }
          fail();
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        if (settled || generation !== lease || unavailable) { db.close(); fail(); return; }
        if (db.version !== 1 || db.objectStoreNames.length !== 1 || !db.objectStoreNames.contains('books')) {
          unavailable = true; db.close(); fail(); return;
        }
        settled = true;
        clearTimeout(timer);
        db.onversionchange = db.onclose = () => invalidate(db, lease);
        connection = db;
        resolve(db);
      };
    });
    state.promise = state.promise.finally(() => { if (pending === state) pending = null; });
    return state.promise;
  }

  function storedBook(row, scope) {
    if (row === undefined) return bookSnapshot(createBook(), 'CSV_TEMPLATE_CORRUPT');
    try {
      fields(row, ['version', 'key', 'owner', 'book']);
      if (row.version !== 1 || row.key !== scope.key || row.owner !== scope.owner) throw error();
      return bookSnapshot(row.book, 'CSV_TEMPLATE_CORRUPT');
    } catch { throw error('CSV_TEMPLATE_CORRUPT', 422); }
  }

  async function transact(scope, expected, next) {
    scope.guard();
    const db = await open();
    scope.guard();
    const result = await new Promise((resolve, reject) => {
      let tx, result, reason, finished = false, timer;
      const operation = {cancel};
      function finish(failure) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        transactions.delete(operation);
        if (failure) reject(failure); else resolve(result);
      }
      function cancel(failure = error()) {
        reason = failure;
        try { tx?.abort(); } catch { /* committed or inactive */ }
        finish(failure);
      }
      try {
        scope.guard();
        tx = db.transaction('books', next ? 'readwrite' : 'readonly');
        transactions.add(operation);
        timer = setTimeout(() => cancel(), TIMEOUT_MS);
        tx.onabort = () => finish(reason || error());
        tx.onerror = () => cancel();
        tx.oncomplete = () => {
          try { scope.guard(); finish(); } catch (failure) { finish(failure); }
        };
        const store = tx.objectStore('books');
        if (store.keyPath !== 'key' || store.autoIncrement || store.indexNames.length !== 0) throw error();
        const request = store.get(scope.key);
        request.onerror = () => cancel();
        request.onsuccess = () => {
          if (finished) return;
          try {
            scope.guard();
            const current = storedBook(request.result, scope);
            scope.guard();
            if (!next) { result = current.book; return; }
            if (current.book.revision !== expected.book.revision || current.json !== expected.json) {
              throw error('CSV_TEMPLATE_CONFLICT', 409);
            }
            scope.guard();
            const write = store.put({version: 1, key: scope.key, owner: scope.owner, book: next.book});
            write.onerror = () => cancel();
            write.onsuccess = () => {
              try { scope.guard(); result = next.book; } catch (failure) { cancel(failure); }
            };
          } catch (failure) { cancel(safeError(failure)); }
        };
      } catch (failure) { cancel(safeError(failure)); }
    });
    scope.guard();
    return result;
  }

  return {
    async read() { return transact(capture()); },
    async write(expectedBook, nextBook) {
      const scope = capture();
      // Both detached inputs are checked before opening a transaction or awaiting.
      const expected = bookSnapshot(expectedBook), next = bookSnapshot(nextBook);
      if (!Number.isSafeInteger(expected.book.revision + 1)
        || next.book.revision !== expected.book.revision + 1) throw error('CSV_TEMPLATE_INVALID', 400);
      scope.guard();
      return transact(scope, expected, next);
    },
    close() {
      // Reusable for React StrictMode cleanup/setup, but never resume old work.
      generation++;
      for (const transaction of transactions) transaction.cancel(error());
      const oldPending = pending, oldConnection = connection;
      pending = null;
      connection = null;
      oldPending?.cancel();
      oldConnection?.close();
    },
  };
}

module.exports = {createCsvTemplateStore};
