'use strict';

/**
 * Pure broker CSV mapping API (CommonJS); no storage, I/O, logging or defaults.
 * fieldsFor(kind) -> [{id,label,required}]; normalizeName(value) -> string|null.
 * parseCsv(raw) -> {headers,rows}; mapCsv(kind,raw,mapping) -> {headers,rows,csv}.
 * checkMapping(kind,headers,mapping) -> {ok,errors};
 * validateMapped(kind,raw,mapping) -> {ok,errors,headers,rows,csv}.
 * Errors are fixed code strings, never source headers, identifiers or cell data.
 * Throwing APIs use CsvMappingError with code === message; no error.cause/data.
 *
 * Book schema, EXACT keys: {version:1,revision:<safe nonnegative integer>,templates:[]}.
 * Template schema, EXACT keys: {id,name,kind,headers,mapping}.
 * id: parent-supplied lowercase crypto.randomUUID() (v4), never changed/recycled here.
 * name: NFKC + trim, 1..30 Unicode codepoints, no controls/format/surrogates.
 * headers: 1..128 distinct, trimmed strings, each 1..160 UTF-16 code units.
 * mapping: ONLY canonical field IDs -> exact source header or '' (unmapped).
 * Required fields must be mapped; snapshot.name is optional. No financial rows,
 * context, account, cash, rate VALUES, timestamps or arbitrary metadata accepted.
 * At most 10 templates; names unique book-wide after NFKC + ASCII-only case fold.
 *
 * createBook() -> empty book; validateBook(book) -> detached validated book.
 * addTemplate(book,template), renameTemplate(book,id,name), deleteTemplate(book,id)
 * -> detached book with revision + 1. Invalid/missing targets throw, no upsert.
 * Inputs are never mutated; even unchanged-name renames advance the revision.
 * The parent MUST atomically compare the original revision at persistence time
 * and fence stale dialogs. Pure helpers cannot CAS a store or reject old books.
 * Template application is explicit checkMapping against CURRENT file headers;
 * column order/extra unrelated columns may change, exact mapped headers may not.
 * No broker alias, date, trade type, sign, locale or exchange-rate inference.
 */

const MAX_BYTES = 2000000;
const MAX_ROWS = 20000;
const MAX_COLUMNS = 128;
const MAX_HEADER = 160;
const MAX_TEMPLATES = 10;
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SCHEMAS = {
  snapshot: [
    ['security_id', '证券 ID', true], ['name', '证券名称', false],
    ['quantity', '持仓数量', true], ['price', '原币单价', true],
  ],
  trades: [
    ['trade_id', '成交 / 流水 ID', true], ['date', '交易日期', true],
    ['type', '交易类型', true], ['security_id', '证券 ID', true],
    ['quantity', '数量', true], ['amount', '原币金额', true],
    ['fx_rate', '换算汇率', true], ['fx_asof', '汇率日期', true],
  ],
};

class CsvMappingError extends Error {
  constructor(code) {
    // Even direct construction with untrusted text cannot leak it as diagnostics.
    const safe = ERROR_CODES.has(code) ? code : 'CSV_MAPPING_INVALID';
    super(safe);
    this.name = 'CsvMappingError';
    this.code = safe;
  }
}
const ERROR_CODES = new Set([
  'CSV_MAPPING_INVALID', 'CSV_KIND_INVALID', 'CSV_INPUT_INVALID', 'CSV_TOO_LARGE',
  'CSV_TOO_MANY_ROWS', 'CSV_TOO_MANY_COLUMNS', 'CSV_QUOTES_INVALID',
  'CSV_HEADER_INVALID', 'CSV_HEADER_DUPLICATE', 'CSV_COLUMNS_MISMATCH',
  'CSV_MAPPING_SCHEMA', 'CSV_MAPPING_REQUIRED', 'CSV_MAPPING_SOURCE_MISSING',
  'CSV_MAPPING_SOURCE_DUPLICATE', 'CSV_TRADES_EMPTY', 'CSV_SECURITY_ID_INVALID',
  'CSV_SECURITY_ID_DUPLICATE', 'CSV_NAME_INVALID', 'CSV_NUMBER_INVALID',
  'CSV_TRADE_ID_INVALID', 'CSV_TRADE_ID_DUPLICATE', 'CSV_TRADE_TYPE_INVALID',
  'CSV_DATE_INVALID', 'CSV_BOOK_SCHEMA', 'CSV_BOOK_VERSION', 'CSV_BOOK_REVISION',
  'CSV_TEMPLATE_SCHEMA', 'CSV_TEMPLATE_LIMIT', 'CSV_TEMPLATE_ID_INVALID',
  'CSV_TEMPLATE_ID_DUPLICATE', 'CSV_TEMPLATE_NAME_INVALID',
  'CSV_TEMPLATE_NAME_DUPLICATE', 'CSV_TEMPLATE_NOT_FOUND',
]);
const fail = code => { throw new CsvMappingError(code); };

function schemaFor(kind) {
  if (typeof kind !== 'string' || !Object.hasOwn(SCHEMAS, kind)) fail('CSV_KIND_INVALID');
  return SCHEMAS[kind];
}
function fieldsFor(kind) {
  return schemaFor(kind).map(([id, label, required]) => ({ id, label, required }));
}

// Only own, enumerable DATA properties on plain records; no getter invocation.
function record(value, allowed, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  const keys = Reflect.ownKeys(value);
  if (keys.length > allowed.length) fail(code);
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !allowed.includes(key) || !d.enumerable ||
        !Object.hasOwn(d, 'value')) fail(code);
  }
  return keys;
}
function exactRecord(value, keys, code) {
  if (record(value, keys, code).length !== keys.length) fail(code);
}
function denseArray(value, max, code) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > max || Reflect.ownKeys(value).length !== value.length + 1) fail(code);
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) fail(code);
  }
}
function headersCopy(headers) {
  denseArray(headers, MAX_COLUMNS, 'CSV_HEADER_INVALID');
  if (!headers.length) fail('CSV_HEADER_INVALID');
  const seen = new Set();
  return headers.map(header => {
    if (typeof header !== 'string' || !header || header.length > MAX_HEADER ||
        header.trim() !== header || INVISIBLE.test(header) || UNSAFE_KEYS.has(header)) {
      fail('CSV_HEADER_INVALID');
    }
    if (seen.has(header)) fail('CSV_HEADER_DUPLICATE');
    seen.add(header);
    return header;
  });
}
function normalizeName(value) {
  if (typeof value !== 'string' || value.length > 1000 || INVISIBLE.test(value)) return null;
  const name = value.normalize('NFKC').trim();
  const count = Array.from(name).length;
  return count >= 1 && count <= 30 && !INVISIBLE.test(name) ? name : null;
}
const nameKey = name => name.replace(/[A-Z]/g, letter => letter.toLowerCase());
const bytes = value => new TextEncoder().encode(value).byteLength;

function parseCsv(input) {
  if (typeof input !== 'string') fail('CSV_INPUT_INVALID');
  if (input.length > MAX_BYTES || bytes(input) > MAX_BYTES) fail('CSV_TOO_LARGE');
  // Permit exactly the transport BOM at the beginning, not invisible header text.
  const raw = input.startsWith('\uFEFF') ? input.slice(1) : input;
  const records = [];
  let row = [], value = '', mode = 'plain';
  const field = () => {
    row.push(value);
    value = '';
    mode = 'plain';
    if (row.length > MAX_COLUMNS) fail('CSV_TOO_MANY_COLUMNS');
  };
  const line = () => {
    field();
    // A physically empty/whitespace line is harmless; comma-only malformed rows
    // are not silently discarded, even when all their cells are blank.
    if (row.length !== 1 || row[0].trim() !== '') records.push(row);
    row = [];
    if (records.length > MAX_ROWS + 1) fail('CSV_TOO_MANY_ROWS');
  };
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (mode === 'quoted') {
      if (c === '"') {
        if (raw[i + 1] === '"') { value += '"'; i++; }
        else mode = 'closed';
      } else value += c;
      continue;
    }
    if (c === ',') { field(); continue; }
    if (c === '\n' || c === '\r') {
      line();
      if (c === '\r' && raw[i + 1] === '\n') i++;
      continue;
    }
    if (mode === 'closed') {
      if (c !== ' ' && c !== '\t') fail('CSV_QUOTES_INVALID');
      continue;
    }
    if (c === '"') {
      if (value !== '') fail('CSV_QUOTES_INVALID');
      mode = 'quoted';
    } else value += c;
  }
  if (mode === 'quoted') fail('CSV_QUOTES_INVALID');
  if (value !== '' || row.length || mode === 'closed') line();
  if (!records.length) fail('CSV_HEADER_INVALID');
  // Check invisible characters BEFORE trim: do not hide a tab/newline/control.
  const headerRow = records.shift();
  if (headerRow.some(header => INVISIBLE.test(header))) fail('CSV_HEADER_INVALID');
  const headers = headersCopy(headerRow.map(header => header.trim()));
  const rows = records.map(cells => {
    if (cells.length !== headers.length) fail('CSV_COLUMNS_MISMATCH');
    return Object.fromEntries(headers.map((header, i) => [header, cells[i].trim()]));
  });
  return { headers, rows };
}

function mappingCopy(kind, headers, mapping) {
  const fields = schemaFor(kind);
  headersCopy(headers);
  record(mapping, fields.map(([id]) => id), 'CSV_MAPPING_SCHEMA');
  const errors = new Set(), used = new Set(), clean = {};
  for (const [id, , required] of fields) {
    const source = Object.hasOwn(mapping, id) ? mapping[id] : '';
    if (typeof source !== 'string') { errors.add('CSV_MAPPING_SCHEMA'); continue; }
    if (!source) {
      if (required) errors.add('CSV_MAPPING_REQUIRED');
    } else {
      if (!headers.includes(source)) errors.add('CSV_MAPPING_SOURCE_MISSING');
      if (used.has(source)) errors.add('CSV_MAPPING_SOURCE_DUPLICATE');
      used.add(source);
    }
    // Preserve omitted optional properties, but never unknown fields/row data.
    if (Object.hasOwn(mapping, id)) clean[id] = source;
  }
  return { mapping: clean, errors: [...errors] };
}
function errorCode(error) {
  try {
    if (error instanceof CsvMappingError && ERROR_CODES.has(error.code)) return error.code;
  } catch { /* Untrusted proxies may even throw while inspecting an error. */ }
  return 'CSV_MAPPING_INVALID';
}
function checkMapping(kind, headers, mapping) {
  try {
    const { errors } = mappingCopy(kind, headers, mapping);
    return { ok: errors.length === 0, errors };
  } catch (error) { return { ok: false, errors: [errorCode(error)] }; }
}
const quote = value => '"' + value.replaceAll('"', '""') + '"';
function mapCsv(kind, raw, mapping) {
  schemaFor(kind);
  const parsed = parseCsv(raw);
  const checked = mappingCopy(kind, parsed.headers, mapping);
  if (checked.errors.length) fail(checked.errors[0]);
  const headers = fieldsFor(kind).map(field => field.id);
  const rows = parsed.rows.map(row => Object.fromEntries(headers.map(id =>
    [id, checked.mapping[id] ? row[checked.mapping[id]] : ''])));
  const csv = [headers.map(quote).join(','), ...rows.map(row =>
    headers.map(id => quote(row[id])).join(','))].join('\n');
  // Canonical quoting can expand input; don't emit CSV the ledger cannot accept.
  if (csv.length > MAX_BYTES || bytes(csv) > MAX_BYTES) fail('CSV_TOO_LARGE');
  return { headers, rows, csv };
}
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
const validText = (value, max) => value !== '' && value.length <= max;
// Explicit decimal/exponent notation only; no locale, hex, currency or signs fixed.
const validNumber = (value, positive = false) => DECIMAL.test(value) &&
  Number.isFinite(Number(value)) && (positive ? Number(value) > 0 : Number(value) >= 0);
function validateMapped(kind, raw, mapping) {
  try {
    const result = mapCsv(kind, raw, mapping), errors = new Set(), ids = new Set();
    if (kind === 'trades' && !result.rows.length) errors.add('CSV_TRADES_EMPTY');
    for (const row of result.rows) {
      if (kind === 'snapshot') {
        if (!validText(row.security_id, 100)) errors.add('CSV_SECURITY_ID_INVALID');
        if (!validText(row.name || row.security_id, 180)) errors.add('CSV_NAME_INVALID');
        if (ids.has(row.security_id)) errors.add('CSV_SECURITY_ID_DUPLICATE');
        ids.add(row.security_id);
        if (!validNumber(row.quantity) || !validNumber(row.price)) errors.add('CSV_NUMBER_INVALID');
      } else {
        if (!validText(row.trade_id, 120)) errors.add('CSV_TRADE_ID_INVALID');
        if (ids.has(row.trade_id)) errors.add('CSV_TRADE_ID_DUPLICATE');
        ids.add(row.trade_id);
        if (!['buy', 'sell', 'dividend', 'fee', 'deposit', 'withdrawal'].includes(row.type)) {
          errors.add('CSV_TRADE_TYPE_INVALID');
        }
        if (!validDate(row.date) || !validDate(row.fx_asof)) errors.add('CSV_DATE_INVALID');
        const purchase = row.type === 'buy' || row.type === 'sell';
        if ((purchase && !validText(row.security_id, 100)) || row.security_id.length > 100) {
          errors.add('CSV_SECURITY_ID_INVALID');
        }
        if (!validNumber(row.amount) || !validNumber(row.fx_rate, true) ||
            (purchase && !validNumber(row.quantity, true))) errors.add('CSV_NUMBER_INVALID');
      }
    }
    return { ...result, ok: errors.size === 0, errors: [...errors] };
  } catch (error) {
    return { ok: false, errors: [errorCode(error)], headers: [], rows: [], csv: '' };
  }
}

function templateCopy(template) {
  exactRecord(template, ['id', 'name', 'kind', 'headers', 'mapping'], 'CSV_TEMPLATE_SCHEMA');
  if (typeof template.id !== 'string' || !UUID.test(template.id)) fail('CSV_TEMPLATE_ID_INVALID');
  const name = normalizeName(template.name);
  if (name === null) fail('CSV_TEMPLATE_NAME_INVALID');
  const headers = headersCopy(template.headers);
  const checked = mappingCopy(template.kind, headers, template.mapping);
  if (checked.errors.length) fail(checked.errors[0]);
  return { id: template.id, name, kind: template.kind, headers, mapping: checked.mapping };
}
function createBook() { return { version: 1, revision: 0, templates: [] }; }
function validateBook(book) {
  exactRecord(book, ['version', 'revision', 'templates'], 'CSV_BOOK_SCHEMA');
  if (book.version !== 1) fail('CSV_BOOK_VERSION');
  if (!Number.isSafeInteger(book.revision) || book.revision < 0) fail('CSV_BOOK_REVISION');
  if (Array.isArray(book.templates) && book.templates.length > MAX_TEMPLATES) fail('CSV_TEMPLATE_LIMIT');
  denseArray(book.templates, MAX_TEMPLATES, 'CSV_BOOK_SCHEMA');
  const templates = book.templates.map(templateCopy), ids = new Set(), names = new Set();
  for (const template of templates) {
    if (ids.has(template.id)) fail('CSV_TEMPLATE_ID_DUPLICATE');
    if (names.has(nameKey(template.name))) fail('CSV_TEMPLATE_NAME_DUPLICATE');
    ids.add(template.id);
    names.add(nameKey(template.name));
  }
  return { version: 1, revision: book.revision, templates };
}
function nextBook(book) {
  const clean = validateBook(book);
  if (clean.revision === Number.MAX_SAFE_INTEGER) fail('CSV_BOOK_REVISION');
  clean.revision++;
  return clean;
}
function addTemplate(book, template) {
  const next = nextBook(book), entry = templateCopy(template);
  if (next.templates.length === MAX_TEMPLATES) fail('CSV_TEMPLATE_LIMIT');
  next.templates.push(entry);
  return validateBook(next);
}
function findTemplate(book, id) {
  if (typeof id !== 'string' || !UUID.test(id)) fail('CSV_TEMPLATE_ID_INVALID');
  const index = book.templates.findIndex(template => template.id === id);
  if (index < 0) fail('CSV_TEMPLATE_NOT_FOUND');
  return index;
}
function renameTemplate(book, id, value) {
  const next = nextBook(book), index = findTemplate(next, id), name = normalizeName(value);
  if (name === null) fail('CSV_TEMPLATE_NAME_INVALID');
  next.templates[index].name = name;
  return validateBook(next);
}
function deleteTemplate(book, id) {
  const next = nextBook(book), index = findTemplate(next, id);
  next.templates.splice(index, 1);
  return next;
}

// Public throwing APIs also sanitize failures from hostile reflection traps.
// None of their arbitrary thrown messages/causes escape the API boundary.
const guarded = operation => (...args) => {
  try { return operation(...args); }
  catch (error) { fail(errorCode(error)); }
};
module.exports = {
  CsvMappingError, fieldsFor, normalizeName, parseCsv, checkMapping,
  mapCsv: guarded(mapCsv), validateMapped, createBook,
  validateBook: guarded(validateBook), addTemplate: guarded(addTemplate),
  renameTemplate: guarded(renameTemplate), deleteTemplate: guarded(deleteTemplate),
};
