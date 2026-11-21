import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const api = require('../desktop/investment/csv-mapping.cjs');
const ledger = require('../desktop/investment/ledger-model.cjs');
const { CsvMappingError, fieldsFor, normalizeName, parseCsv, checkMapping, mapCsv,
  validateMapped, createBook, validateBook, addTemplate, renameTemplate, deleteTemplate } = api;

// Invented, memory-only data. The browser VM test reads only the module source;
// no real financial data, network, user profiles or persistence APIs are accessed.
const snapshot = 'Ticker,Units,Entry,Description,Ignored\nDEMO.A,10,12.50,Synthetic Alpha,discard';
const snapshotMap = Object.freeze({ security_id: 'Ticker', quantity: 'Units', price: 'Entry', name: 'Description' });
const tradeHeaders = ['Ref', 'Day', 'Action', 'Ticker', 'Units', 'Total', 'FX', 'FXDay'];
const tradeMap = Object.freeze({ trade_id: 'Ref', date: 'Day', type: 'Action', security_id: 'Ticker',
  quantity: 'Units', amount: 'Total', fx_rate: 'FX', fx_asof: 'FXDay' });
const tradeCsv = (changes = {}) => {
  const row = { Ref: 'DEMO-T1', Day: '2026-11-20', Action: 'buy', Ticker: 'DEMO.A',
    Units: '2', Total: '25', FX: '4.5', FXDay: '2026-11-20', ...changes };
  return tradeHeaders.join(',') + '\n' + tradeHeaders.map(key => '"' + row[key].replaceAll('"', '""') + '"').join(',');
};
const context = Object.freeze({ broker: '其他', account: 'SYNTHETIC-TEST-ONLY', source: 'Synthetic CSV unit test',
  currency: 'USD', reportCurrency: 'MYR', asOf: '2026-11-20', fxRate: 4.5, fxAsOf: '2026-11-20', cash: 0 });
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const template = (n = 1, changes = {}) => ({ id: id(n), name: `Synthetic ${n}`, kind: 'snapshot',
  headers: ['Ticker', 'Units', 'Entry', 'Description'], mapping: { ...snapshotMap }, ...changes });
const throwsCode = (fn, code) => assert.throws(fn, error => {
  assert.ok(error instanceof CsvMappingError);
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assert.equal(error.cause, undefined);
  return true;
});
const deepFreeze = value => {
  if (value && typeof value === 'object') { Object.freeze(value); for (const item of Object.values(value)) deepFreeze(item); }
  return value;
};

test('minimal CommonJS exports and exact, detached snapshot/trade field contracts', () => {
  assert.deepEqual(Object.keys(api).sort(), ['CsvMappingError', 'fieldsFor', 'normalizeName', 'parseCsv',
    'checkMapping', 'mapCsv', 'validateMapped', 'createBook', 'validateBook', 'addTemplate', 'renameTemplate', 'deleteTemplate'].sort());
  assert.deepEqual(fieldsFor('snapshot').map(({ id, required }) => [id, required]),
    [['security_id', true], ['name', false], ['quantity', true], ['price', true]]);
  assert.deepEqual(fieldsFor('trades').map(f => f.id),
    ['trade_id', 'date', 'type', 'security_id', 'quantity', 'amount', 'fx_rate', 'fx_asof']);
  assert.ok(fieldsFor('trades').every(f => f.required && typeof f.label === 'string'));
  fieldsFor('snapshot')[0].id = 'changed';
  assert.equal(fieldsFor('snapshot')[0].id, 'security_id');
  for (const kind of ['__proto__', 'constructor', null, [], {}, 'Snapshot']) throwsCode(() => fieldsFor(kind), 'CSV_KIND_INVALID');
});

test('browser consumer works with TextEncoder and no Buffer, process, require or Node globals', () => {
  const source = readFileSync(new URL('../desktop/investment/csv-mapping.cjs', import.meta.url), 'utf8');
  const sandbox = { module: { exports: {} }, TextEncoder };
  runInNewContext(source + `\n;(() => {
    if (typeof Buffer !== 'undefined' || typeof process !== 'undefined' || typeof require !== 'undefined') {
      throw Error('Node global leaked into browser fixture');
    }
    const api = module.exports;
    const mapping = { security_id: 'ID', quantity: 'Q', price: 'P' };
    const result = api.validateMapped('snapshot', 'ID,Q,P\\r\\nSYNTHETIC,2,3', mapping);
    if (!result.ok || result.rows.length !== 1) throw Error('Browser mapping failed');
    if (api.parseCsv('A\\n' + '中'.repeat(666666)).rows.length !== 1) throw Error('UTF-8 boundary failed');
    try { api.parseCsv('A\\n' + '中'.repeat(666667)); throw Error('Oversize accepted'); }
    catch (error) { if (error.code !== 'CSV_TOO_LARGE') throw error; }
    const book = api.addTemplate(api.createBook(), {
      id: '00000000-0000-4000-8000-000000000001', name: 'Browser', kind: 'snapshot',
      headers: ['ID', 'Q', 'P'], mapping,
    });
    if (api.validateBook(book).revision !== 1) throw Error('Browser book failed');
    module.exports.browserTestPassed = true;
  })();`, sandbox);
  assert.equal(sandbox.module.exports.browserTestPassed, true);
});

test('CSV BOM, CRLF/CR, escaped quotes, commas, embedded newlines, final empty fields', () => {
  const parsed = parseCsv('\uFEFFA,B,C\r\n"a,b","a""b","line1\r\nline2"\r\nlast,,\r');
  assert.deepEqual(parsed, { headers: ['A', 'B', 'C'], rows: [
    { A: 'a,b', B: 'a"b', C: 'line1\r\nline2' }, { A: 'last', B: '', C: '' }] });
  assert.deepEqual(parseCsv(' A , B \n\n a ,"b" \t\n').rows, [{ A: 'a', B: 'b' }]);
  assert.deepEqual(parseCsv('A,B\n"",\n').rows, [{ A: '', B: '' }]);
  assert.equal(parseCsv('A,B\n\n\r\n').rows.length, 0);
});

test('CSV malformed quotes/widths/headers rejected with fixed typed diagnostics', () => {
  for (const raw of ['A,B\n"open,y', 'A,B\n"a"tail,y', 'A,B\na"b,y', 'A,B\n "a",y', 'A,B\n"a" "b",y']) {
    throwsCode(() => parseCsv(raw), 'CSV_QUOTES_INVALID');
  }
  for (const raw of ['A,B\nx', 'A,B\nx,y,z', 'A,B\n,,', 'A\n,']) throwsCode(() => parseCsv(raw), 'CSV_COLUMNS_MISMATCH');
  for (const raw of ['', '  ', ',', 'A,,B', 'A,\u0000', 'A,"multi\nline"', '\uFEFF\uFEFFA', '__proto__,A', 'constructor,A']) {
    throwsCode(() => parseCsv(raw), 'CSV_HEADER_INVALID');
  }
  for (const raw of ['A,A\nx,y', 'A, A \nx,y']) throwsCode(() => parseCsv(raw), 'CSV_HEADER_DUPLICATE');
  for (const raw of [null, undefined, {}, Buffer.from('A')]) throwsCode(() => parseCsv(raw), 'CSV_INPUT_INVALID');
});

test('CSV exact row/column/header/UTF-8 byte boundaries and expansion bound', () => {
  assert.equal(parseCsv('A\n' + 'x\n'.repeat(20000)).rows.length, 20000);
  throwsCode(() => parseCsv('A\n' + 'x\n'.repeat(20001)), 'CSV_TOO_MANY_ROWS');
  const cols = Array.from({ length: 128 }, (_, i) => `H${i}`).join(',');
  assert.equal(parseCsv(cols).headers.length, 128);
  throwsCode(() => parseCsv(cols + ',extra'), 'CSV_TOO_MANY_COLUMNS');
  assert.equal(parseCsv('H'.repeat(160)).headers[0].length, 160);
  throwsCode(() => parseCsv('H'.repeat(161)), 'CSV_HEADER_INVALID');
  assert.equal(parseCsv('A\n' + 'x'.repeat(1999998)).rows.length, 1);
  throwsCode(() => parseCsv('A\n' + 'x'.repeat(1999999)), 'CSV_TOO_LARGE');
  assert.equal(parseCsv('A\n' + '中'.repeat(666666)).rows.length, 1);
  throwsCode(() => parseCsv('A\n' + '中'.repeat(666667)), 'CSV_TOO_LARGE');
  const raw = 'I,Q,P,N\nS,1,1,' + 'x'.repeat(1999980);
  throwsCode(() => mapCsv('snapshot', raw, { security_id: 'I', quantity: 'Q', price: 'P', name: 'N' }), 'CSV_TOO_LARGE');
});

test('header controls, invisible Unicode, forged prototypes, symbols/accessors, sparse arrays', () => {
  for (const character of ['\u0000', '\t', '\u007f', '\u200b', '\u202e', '\ud800', '\u2028', '\u2029']) {
    throwsCode(() => parseCsv(`A${character},B`), 'CSV_HEADER_INVALID');
  }
  const malformed = [Object.assign(Object.create({ inherited: true }), snapshotMap),
    { ...snapshotMap, extra: 'Ticker' }, { ...snapshotMap, [Symbol('hidden')]: 'Ticker' },
    Object.defineProperty({ ...snapshotMap }, 'price', { get() { assert.fail('getter ran'); }, enumerable: true }),
    Object.defineProperty({ ...snapshotMap }, 'private', { value: 42 }),
    JSON.parse('{"__proto__":{"polluted":true}}'), [], null];
  for (const mapping of malformed) assert.equal(checkMapping('snapshot', ['Ticker', 'Units', 'Entry', 'Description'], mapping).ok, false);
  for (const headers of [[, 'Units'], Object.assign(['Ticker'], { extra: 'value' }), new Set(['Ticker']),
    Object.defineProperty(['Ticker'], '0', { get() { assert.fail('getter ran'); } })]) {
    assert.equal(checkMapping('snapshot', headers, snapshotMap).ok, false);
  }
  assert.equal({}.polluted, undefined);
});

test('mapping is exact, rejects duplicate/missing/unknown sources, never infers aliases', () => {
  const headers = parseCsv(snapshot).headers;
  assert.deepEqual(checkMapping('snapshot', headers, snapshotMap), { ok: true, errors: [] });
  for (const changes of [{ security_id: '0' }, { security_id: 'ticker' }, { security_id: ' Ticker' },
    { price: 'Missing' }, { quantity: 'Ticker' }, { price: '' }, { price: null }, { price: 0 }, { account: 'Ignored' }]) {
    assert.equal(checkMapping('snapshot', headers, { ...snapshotMap, ...changes }).ok, false);
  }
  assert.equal(checkMapping('trades', headers, snapshotMap).ok, false);
  assert.equal(checkMapping('snapshot', ['Ticker', 'Ticker'], snapshotMap).ok, false);
  assert.equal(checkMapping('snapshot', [], snapshotMap).ok, false);
  const result = mapCsv('snapshot', snapshot, deepFreeze({ ...snapshotMap }));
  assert.deepEqual(Object.keys(result.rows[0]), ['security_id', 'name', 'quantity', 'price']);
  assert.equal(result.rows[0].Ignored, undefined);
  assert.equal(result.csv.includes('discard'), false);
});

test('optional name, header-only cash snapshot, and canonical validation use original ledger', () => {
  const mapping = { security_id: 'Ticker', quantity: 'Units', price: 'Entry' };
  for (const raw of [snapshot, 'Ticker,Units,Entry']) {
    const result = validateMapped('snapshot', raw, mapping);
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    const actual = ledger.validate('snapshot', { ...context, cash: 10, csv: result.csv });
    assert.equal(actual.positions.length, raw === snapshot ? 1 : 0);
    if (actual.positions.length) assert.equal(actual.positions[0].name, 'DEMO.A');
  }
  assert.equal(checkMapping('snapshot', parseCsv(snapshot).headers, { ...mapping, name: '' }).ok, true);
  assert.equal(validateMapped('trades', tradeHeaders.join(','), tradeMap).ok, false);
});

test('quote/newline/currency-like source text round-trips without execution or conversion', () => {
  const raw = 'Ticker,Units,Entry,Description\r\n"DEMO, ""A""",2.00,1e2,"line1\nline2 =SUM(A1)"';
  const result = validateMapped('snapshot', raw, snapshotMap);
  assert.equal(result.ok, true);
  assert.equal(result.rows[0].quantity, '2.00');
  assert.equal(result.rows[0].price, '1e2');
  assert.deepEqual(parseCsv(result.csv).rows, result.rows);
  assert.equal(ledger.validate('snapshot', { ...context, csv: result.csv }).positions[0].name, 'line1\nline2 =SUM(A1)');
});

test('all six original ledger trade types; non-buy quantity/security remain allowed blanks', () => {
  for (const Action of ['buy', 'sell', 'dividend', 'fee', 'deposit', 'withdrawal']) {
    const changes = ['buy', 'sell'].includes(Action) ? { Action } : { Action, Ticker: '', Units: '' };
    const result = validateMapped('trades', tradeCsv(changes), tradeMap);
    assert.equal(result.ok, true, Action);
    const actual = ledger.validate('trades', { ...context, csv: result.csv }).trades[0];
    assert.equal(actual.type, Action);
    assert.equal(actual.quantity, ['buy', 'sell'].includes(Action) ? 2 : null);
  }
});

test('no guessed dates, rates, signs, trade aliases, locale/hex numbers or invalid numeric bounds', () => {
  for (const changes of [{ Action: 'BUY' }, { Action: 'purchase' }, { Action: '=buy' }, { Day: '11/20/2026' },
    { Day: '2026-02-30' }, { Day: '2025-02-29' }, { FXDay: '2026-13-01' }, { Day: '2026-01-32' },
    { FX: '' }, { FX: '0' }, { FX: '-1' }, { FX: '1e-999' }, { FX: 'Infinity' }, { Total: '-1' },
    { Total: 'NaN' }, { Total: '1,000' }, { Total: '1.000,00' }, { Total: '0x10' }, { Total: '0b10' },
    { Total: 'RM 10' }, { Total: '=1+2' }, { Total: '1e309' }, { Units: '0' }, { Units: '' }, { Ticker: '' }]) {
    const result = validateMapped('trades', tradeCsv(changes), tradeMap);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length && result.errors.every(code => /^CSV_[A-Z_]+$/.test(code)));
  }
  assert.equal(validateMapped('trades', tradeCsv({ Day: '2024-02-29', Total: '0', Units: '1e-10' }), tradeMap).ok, true);
});

test('ledger text limits, duplicates, zero/nonnegative snapshot values and bounded errors', () => {
  for (const raw of [snapshot.replace('DEMO.A', 'x'.repeat(101)), snapshot.replace('Synthetic Alpha', 'x'.repeat(181)),
    snapshot.replace('10,12.50', '-1,12.50'), snapshot.replace('10,12.50', ',12.50'),
    snapshot + '\nDEMO.A,1,1,Another,ignored']) assert.equal(validateMapped('snapshot', raw, snapshotMap).ok, false);
  assert.equal(validateMapped('snapshot', snapshot.replace('10,12.50', '0,0'), snapshotMap).ok, true);
  for (const changes of [{ Ref: 'x'.repeat(121) }, { Ref: '' }, { Ticker: 'x'.repeat(101) }]) {
    assert.equal(validateMapped('trades', tradeCsv(changes), tradeMap).ok, false);
  }
  const duplicates = tradeCsv() + '\n' + tradeCsv().split('\n')[1];
  assert.deepEqual(validateMapped('trades', duplicates, tradeMap).errors, ['CSV_TRADE_ID_DUPLICATE']);
  const many = 'Ticker,Units,Entry,Description\n' + 'S,bad,bad,N\n'.repeat(20000);
  assert.ok(validateMapped('snapshot', many, snapshotMap).errors.length <= 3);
});

test('no sensitive strings leak into diagnostics, even through unknown thrown objects', () => {
  const secret = 'SENSITIVE-SYNTHETIC-STRING';
  for (const result of [checkMapping('snapshot', ['A'], { ...snapshotMap, security_id: secret }),
    validateMapped('snapshot', 'A,B\n"' + secret, snapshotMap),
    validateMapped('trades', tradeCsv({ Ref: '', Total: secret, Ticker: secret }), tradeMap)]) {
    assert.equal(JSON.stringify(result.errors).includes(secret), false);
  }
  assert.equal(new CsvMappingError(secret).message, 'CSV_MAPPING_INVALID');
  const trap = new Proxy({}, { getPrototypeOf() { throw Error(secret); } });
  assert.deepEqual(checkMapping('snapshot', ['A'], trap).errors, ['CSV_MAPPING_INVALID']);
  throwsCode(() => mapCsv('snapshot', snapshot, trap), 'CSV_MAPPING_INVALID');
  throwsCode(() => validateBook(trap), 'CSV_MAPPING_INVALID');
  throwsCode(() => addTemplate(createBook(), trap), 'CSV_MAPPING_INVALID');
  throwsCode(() => renameTemplate(trap, id(1), 'x'), 'CSV_MAPPING_INVALID');
  throwsCode(() => deleteTemplate(trap, id(1)), 'CSV_MAPPING_INVALID');
  const nestedTrap = new Proxy({}, { getPrototypeOf() { throw trap; } });
  assert.deepEqual(checkMapping('snapshot', ['A'], nestedTrap).errors, ['CSV_MAPPING_INVALID']);
});

test('name NFKC, codepoints, controls, surrogates, whitespace and ASCII-only uniqueness', () => {
  assert.equal(normalizeName('  Ｄｅｍｏ  '), 'Demo');
  assert.equal(normalizeName('😀'.repeat(30)), '😀'.repeat(30));
  assert.equal(normalizeName('e\u0301'), 'é');
  assert.equal(normalizeName('<b>Demo</b>'), '<b>Demo</b>');
  for (const name of ['', '  ', '😀'.repeat(31), 'a\u0000b', 'a\nb', 'a\u007fb', 'a\u200bb',
    'a\u202eb', '\ud800', '\u2028', '\u2029', {}, null]) assert.equal(normalizeName(name), null);
  const book = addTemplate(createBook(), template(1, { name: 'Ｄｅｍｏ' }));
  throwsCode(() => addTemplate(book, template(2, { name: ' demo ' })), 'CSV_TEMPLATE_NAME_DUPLICATE');
  const accented = addTemplate(createBook(), template(1, { name: 'Ä' }));
  assert.equal(addTemplate(accented, template(2, { name: 'ä' })).templates.length, 2);
});

test('book helpers are detached and immutable with monotonic revision and immutable UUIDs', () => {
  const empty = deepFreeze(createBook()), entry = deepFreeze(template());
  assert.deepEqual(empty, { version: 1, revision: 0, templates: [] });
  assert.notEqual(createBook().templates, createBook().templates);
  const added = deepFreeze(addTemplate(empty, entry));
  assert.equal(added.revision, 1);
  assert.equal(empty.templates.length, 0);
  const renamed = deepFreeze(renameTemplate(added, entry.id, 'New name'));
  assert.equal(renamed.revision, 2);
  assert.equal(renamed.templates[0].id, entry.id);
  assert.deepEqual(renamed.templates[0].mapping, entry.mapping);
  assert.equal(added.templates[0].name, entry.name);
  assert.notEqual(renamed.templates[0].mapping, added.templates[0].mapping);
  assert.notEqual(renamed.templates[0].headers, added.templates[0].headers);
  assert.equal(renameTemplate(renamed, entry.id, 'New name').revision, 3);
  const removed = deleteTemplate(renamed, entry.id);
  assert.deepEqual(removed, { version: 1, revision: 3, templates: [] });
  const copy = validateBook(added);
  copy.templates[0].mapping.price = 'other'; copy.templates[0].headers.push('new');
  assert.deepEqual(added.templates[0], entry);
});

test('UUID injection: actual parent randomUUID, malformed/duplicate/missing IDs, no upserts', () => {
  const uuid = randomUUID();
  const book = addTemplate(createBook(), template(1, { id: uuid }));
  assert.equal(book.templates[0].id, uuid);
  for (const bad of ['', undefined, null, 'demo-1', '__proto__', '00000000-0000-0000-0000-000000000000',
    '10000000-0000-4000-7000-000000000000', uuid + '\n']) {
    throwsCode(() => addTemplate(createBook(), template(2, { id: bad })), 'CSV_TEMPLATE_ID_INVALID');
  }
  throwsCode(() => addTemplate(book, template(2, { id: uuid })), 'CSV_TEMPLATE_ID_DUPLICATE');
  throwsCode(() => renameTemplate(book, id(999), 'missing'), 'CSV_TEMPLATE_NOT_FOUND');
  throwsCode(() => deleteTemplate(book, id(999)), 'CSV_TEMPLATE_NOT_FOUND');
  throwsCode(() => deleteTemplate(book, '__proto__'), 'CSV_TEMPLATE_ID_INVALID');
  const deleted = deleteTemplate(book, uuid);
  throwsCode(() => deleteTemplate(deleted, uuid), 'CSV_TEMPLATE_NOT_FOUND');
});

test('10 template bound, shared name namespace, failed operations leave source unchanged', () => {
  let book = createBook();
  for (let n = 1; n <= 10; n++) book = addTemplate(book, template(n));
  deepFreeze(book);
  assert.equal(book.revision, 10);
  throwsCode(() => addTemplate(book, template(11)), 'CSV_TEMPLATE_LIMIT');
  throwsCode(() => validateBook({ ...book, templates: [...book.templates, template(11)] }), 'CSV_TEMPLATE_LIMIT');
  throwsCode(() => renameTemplate(book, id(2), book.templates[0].name), 'CSV_TEMPLATE_NAME_DUPLICATE');
  throwsCode(() => renameTemplate(book, id(2), 'bad\nname'), 'CSV_TEMPLATE_NAME_INVALID');
  assert.equal(book.revision, 10);
  const tradesTemplate = template(11, { kind: 'trades', headers: tradeHeaders, mapping: { ...tradeMap }, name: 'Synthetic 1' });
  throwsCode(() => addTemplate(addTemplate(createBook(), template()), tradesTemplate), 'CSV_TEMPLATE_NAME_DUPLICATE');
});

test('exact book/template schema excludes rows, context and arbitrary metadata at all levels', () => {
  for (const field of ['rows', 'csv', 'account', 'broker', 'cash', 'fxRate', 'rates', 'data', 'createdAt', 'constructor']) {
    throwsCode(() => validateBook({ ...createBook(), [field]: 'forbidden' }), 'CSV_BOOK_SCHEMA');
    throwsCode(() => addTemplate(createBook(), template(1, { [field]: 'forbidden' })), 'CSV_TEMPLATE_SCHEMA');
  }
  for (const book of [null, [], new Date(), Object.create({ version: 1 }),
    { version: 1, revision: 0 }, { ...createBook(), [Symbol('secret')]: 1 },
    JSON.parse('{"version":1,"revision":0,"templates":[],"__proto__":{"polluted":true}}')]) {
    throwsCode(() => validateBook(book), 'CSV_BOOK_SCHEMA');
  }
  for (const version of [0, 2, '1', null]) throwsCode(() => validateBook({ ...createBook(), version }), 'CSV_BOOK_VERSION');
  for (const revision of [-1, 0.5, '0', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    throwsCode(() => validateBook({ ...createBook(), revision }), 'CSV_BOOK_REVISION');
  }
  const full = { ...createBook(), revision: Number.MAX_SAFE_INTEGER };
  assert.equal(validateBook(full).revision, full.revision);
  throwsCode(() => addTemplate(full, template()), 'CSV_BOOK_REVISION');
  const getter = Object.defineProperty(createBook(), 'templates', { get() { assert.fail('getter invoked'); } });
  throwsCode(() => validateBook(getter), 'CSV_BOOK_SCHEMA');
  throwsCode(() => validateBook({ ...createBook(), templates: [,] }), 'CSV_BOOK_SCHEMA');
  for (const entry of [Object.assign(Object.create({ unexpected: true }), template()),
    Object.defineProperty(template(), 'headers', { get() { assert.fail('getter invoked'); } }),
    Object.defineProperty(template(), 'hidden', { value: 'forbidden' }),
    { ...template(), [Symbol('secret')]: 1 }]) {
    throwsCode(() => addTemplate(createBook(), entry), 'CSV_TEMPLATE_SCHEMA');
  }
});

test('template headers and mappings must themselves be valid; no repair, guess or cross-kind reuse', () => {
  for (const changes of [{ headers: [] }, { headers: ['Ticker', 'Ticker'] }, { headers: ['x'.repeat(161)] },
    { headers: Array.from({ length: 129 }, (_, i) => 'H' + i) }, { headers: [' Ticker', 'Units', 'Entry'] },
    { kind: 'trades' }, { mapping: { ...snapshotMap, name: 'Absent' } },
    { mapping: { ...snapshotMap, security_id: 'Units' } }, { mapping: {} }]) {
    assert.throws(() => addTemplate(createBook(), template(1, changes)), CsvMappingError);
  }
  const book = addTemplate(createBook(), template());
  const serialized = JSON.parse(JSON.stringify(book));
  assert.deepEqual(validateBook(serialized), book);
  assert.deepEqual(Object.keys(book.templates[0]).sort(), ['id', 'name', 'kind', 'headers', 'mapping'].sort());
});

test('stale template semantics: exact current headers required; reordered/extra columns allowed', () => {
  const saved = addTemplate(createBook(), template()).templates[0];
  assert.equal(checkMapping('snapshot', ['Entry', 'Description', 'Extra', 'Units', 'Ticker'], saved.mapping).ok, true);
  for (const headers of [['Ticker', 'Units', 'Renamed price', 'Description'], ['Ticker', 'Units', 'Entry'],
    ['ticker', 'Units', 'Entry', 'Description']]) assert.equal(checkMapping('snapshot', headers, saved.mapping).ok, false);
  assert.equal(checkMapping('trades', tradeHeaders, saved.mapping).ok, false);
  assert.deepEqual(saved.mapping, snapshotMap);
});

test('out-of-order/repeated operations expose revisions for parent CAS; no fictitious store locking', () => {
  const baseline = addTemplate(createBook(), template());
  const left = renameTemplate(baseline, id(1), 'Left');
  const right = deleteTemplate(baseline, id(1));
  assert.equal(left.revision, 2); assert.equal(right.revision, 2);
  // Model the parent's atomic compare with its baseline. Helpers have no store.
  let current = baseline;
  const commit = (expectedRevision, candidate) => {
    if (current.revision !== expectedRevision) return false;
    current = candidate; return true;
  };
  assert.equal(commit(baseline.revision, left), true);
  assert.equal(commit(baseline.revision, right), false);
  assert.equal(current.templates[0].name, 'Left');
  const recovered = validateBook(JSON.parse(JSON.stringify(current)));
  assert.equal(deleteTemplate(recovered, id(1)).revision, 3);
  throwsCode(() => addTemplate(current, template()), 'CSV_TEMPLATE_ID_DUPLICATE');
});
