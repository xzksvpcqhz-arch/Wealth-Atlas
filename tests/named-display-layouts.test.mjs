import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const ts = createRequire(import.meta.url)("typescript");
// Resolve extensionless production imports in memory: no emitted files or loader hacks.
function moduleURL(file, imports = {}) {
  let code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  code = code.replace(/from ["']([^"']+)["']/g, (_, name) => {
    assert.ok(Object.hasOwn(imports, name), `Unexpected dependency: ${name}`);
    return `from ${JSON.stringify(imports[name])}`;
  });
  return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
}
const preferencesURL = moduleURL("../lib/display-preferences.ts");
const { createDisplayPreferences, displayStorageKey } = await import(preferencesURL);
const {
  createNamedLayoutLibrary, parseNamedLayoutLibrary, parseNamedLayoutEnvelope,
  normalizeLayoutName, layoutNameKey, namedLayoutStorageKey, readNamedLayouts, writeNamedLayouts,
} = await import(moduleURL("../lib/named-display-layouts.ts", { "./display-preferences": preferencesURL }));

const local = { kind: "local", ownerId: null };
const guest = { kind: "guest", ownerId: null };
const locked = { kind: "locked", ownerId: null };
const cloudA = { kind: "cloud", ownerId: "synthetic-owner_A" };
const cloudB = { kind: "cloud", ownerId: "synthetic-owner_B" };
const CAP = 256 * 1024;
const devices = ["desktop", "tablet", "mobile"];
const clone = structuredClone;
const id = (index) => `abcdef01-2345-4678-89ab-${index.toString(16).padStart(12, "0")}`;
const scheme = (index = 1, name = `Layout ${index}`) => ({ id: id(index), name, preferences: createDisplayPreferences() });
const library = (count = 1) => ({ version: 1, schemes: Array.from({ length: count }, (_, index) => scheme(index + 1)) });
const envelope = (count = 1, revision = null) => ({ version: 1, library: library(count), base: revision === null ? null : { revision, library: library(count) } });
const emptyEnvelope = () => ({ version: 1, library: createNamedLayoutLibrary(), base: null });
const failure = (reason) => ({ ok: false, reason });
const active = () => true;
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

class MemoryStorage {
  values;
  reads = [];
  writes = [];
  constructor(entries = []) { this.values = new Map(entries); }
  getItem(key) { this.reads.push(key); return this.values.get(key) ?? null; }
  setItem(key, raw) { this.writes.push([key, raw]); this.values.set(key, raw); }
}

// FIFO, per-key exclusive lock simulator, including async holders and rejected callbacks.
class MemoryLocks {
  requests = [];
  events = [];
  inside = new Set();
  tails = new Map();
  request(name, options, callback) {
    this.requests.push({ name, options: clone(options) });
    const result = (this.tails.get(name) ?? Promise.resolve()).then(async () => {
      assert.equal(this.inside.has(name), false);
      this.inside.add(name);
      this.events.push(["enter", name]);
      try { return await callback({ name, mode: options.mode }); }
      finally { this.inside.delete(name); this.events.push(["exit", name]); }
    });
    this.tails.set(name, result.then(() => undefined, () => undefined));
    return result;
  }
}

function globalValue(t, name, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, name, original);
    else Reflect.deleteProperty(globalThis, name);
  });
}
function browser(t, storage = new MemoryStorage(), locks = new MemoryLocks()) {
  // Never resolve, read or modify the host's real browser storage/profile.
  globalValue(t, "localStorage", storage);
  globalValue(t, "navigator", { locks });
  return { storage, locks };
}
async function hold(locks, key) {
  const entered = deferred(), release = deferred();
  const done = locks.request(key, { mode: "exclusive" }, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  return { release: release.resolve, done };
}

test("empty libraries have no fake records and are independent mutable snapshots", () => {
  const first = createNamedLayoutLibrary(), second = createNamedLayoutLibrary();
  assert.deepEqual(first, { version: 1, schemes: [] });
  assert.notEqual(first, second);
  assert.notEqual(first.schemes, second.schemes);
  first.schemes.push(scheme());
  assert.deepEqual(second, { version: 1, schemes: [] });
  assert.deepEqual(parseNamedLayoutLibrary(second), second);
});

test("name normalization is trimmed NFKC and counts Unicode codepoints, not UTF-16 units", () => {
  for (const [input, expected] of [
    ["  Ｍｙ　Ｌａｙｏｕｔ  ", "My Layout"], ["\u00a0Ａ\u00a0", "A"],
    ["e\u0301", "é"], ["ﬃ", "ffi"], ["  中文布局  ", "中文布局"],
    ["A  B", "A  B"], ["😀".repeat(30), "😀".repeat(30)],
    ["𐐀".repeat(30), "𐐀".repeat(30)], ["ﬃ".repeat(10), "ffi".repeat(10)],
  ]) assert.equal(normalizeLayoutName(input), expected);
  for (const value of ["", " ", "\u00a0", "x".repeat(31), "😀".repeat(31), "ﬃ".repeat(11), null, undefined, 1, true, {}, [], new String("A")]) {
    assert.equal(normalizeLayoutName(value), null);
  }
});

test("all C0/C1 controls and Unicode format/line controls fail even at trimmed edges", () => {
  const controls = [
    ...Array.from({ length: 32 }, (_, index) => String.fromCodePoint(index)),
    ...Array.from({ length: 33 }, (_, index) => String.fromCodePoint(127 + index)),
    "\u00ad", "\u061c", "\u200b", "\u200c", "\u200d", "\u200e", "\u2028", "\u2029",
    "\u202a", "\u202e", "\u2060", "\u2066", "\u2069", "\ufeff", "\ufff9", "\u{e0001}", "\ud800", "\udfff",
  ];
  for (const control of controls) {
    for (const name of [`${control}A`, `A${control}`, `A${control}B`]) {
      assert.equal(normalizeLayoutName(name), null, JSON.stringify(name));
      const value = library(); value.schemes[0].name = name;
      assert.equal(parseNamedLayoutLibrary(value), null);
    }
  }
});

test("name keys change only ASCII A-Z, independent of Unicode and locale", () => {
  assert.equal(layoutNameKey("AZ az 012 ÉİΣẞ𐐀 中文"), "az az 012 ÉİΣẞ𐐀 中文");
  assert.notEqual(layoutNameKey("É"), layoutNameKey("é"));
  assert.notEqual(layoutNameKey("İ"), layoutNameKey("i"));
  const value = library(10);
  ["É", "é", "İ", "i", "Σ", "σ", "ς", "ẞ", "ß", "ı"].forEach((name, index) => { value.schemes[index].name = name; });
  assert.deepEqual(parseNamedLayoutLibrary(value), value);
});

test("persisted names must already be canonical; duplicate keys use normalized ASCII only", () => {
  for (const name of [" A", "A ", "Ａ", "e\u0301", "ﬃ", "", "x".repeat(31), null, 1]) {
    const value = library(); value.schemes[0].name = name;
    assert.equal(parseNamedLayoutLibrary(value), null);
  }
  for (const pair of [["Work", "WORK"], ["same", "same"], ["Ａ", "a"], ["e\u0301", "é"]]) {
    const value = library(2);
    pair.forEach((name, index) => { value.schemes[index].name = normalizeLayoutName(name); });
    assert.equal(parseNamedLayoutLibrary(value), null);
  }
  for (const name of ["x", "x".repeat(30), "😀".repeat(30), "__proto__", "constructor"]) {
    const value = library(); value.schemes[0].name = name;
    assert.ok(parseNamedLayoutLibrary(value));
  }
});

test("IDs require exact lowercase hexadecimal UUID grouping, including no terminal newline", () => {
  for (const bad of ["", "x", id(1).toUpperCase(), `${id(1)}\n`, ` ${id(1)}`, `${id(1)} `, id(1).replaceAll("-", ""), id(1).replace("a", "g"), `{${id(1)}}`, null, 123, {}, new String(id(1))]) {
    const value = library(); value.schemes[0].id = bad;
    assert.equal(parseNamedLayoutLibrary(value), null);
  }
  for (const good of [id(1), "00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"]) {
    const value = library(); value.schemes[0].id = good;
    assert.ok(parseNamedLayoutLibrary(value));
  }
  const repeated = library(2); repeated.schemes[1].id = repeated.schemes[0].id;
  assert.equal(parseNamedLayoutLibrary(repeated), null);
});

test("zero through ten schemes are valid, eleven or duplicate tail records fail", () => {
  for (let count = 0; count <= 10; count += 1) assert.deepEqual(parseNamedLayoutLibrary(library(count)), library(count));
  assert.equal(parseNamedLayoutLibrary(library(11)), null);
  for (const field of ["id", "name"]) {
    const value = library(10); value.schemes[9][field] = value.schemes[0][field];
    assert.equal(parseNamedLayoutLibrary(value), null);
  }
});

test("base revisions match positive signed PostgreSQL integer bounds without coercion", () => {
  for (const revision of [1, 2147483647]) assert.ok(parseNamedLayoutEnvelope(envelope(1, revision)));
  for (const revision of [0, -0, -1, 1.5, 2147483648, Number.MAX_SAFE_INTEGER, NaN, Infinity, -Infinity, "1", 1n, true, {}, null, undefined]) {
    const value = envelope(1, 1); value.base.revision = revision;
    assert.equal(parseNamedLayoutEnvelope(value), null);
  }
  assert.deepEqual(parseNamedLayoutEnvelope(emptyEnvelope()), emptyEnvelope());
});

test("parsing deeply clones every preference, current/base library and aliased scheme", () => {
  const value = envelope(2, 7);
  value.base.library = value.library;
  value.library.schemes[1].preferences = value.library.schemes[0].preferences;
  const before = clone(value), parsed = parseNamedLayoutEnvelope(value);
  assert.deepEqual(parsed, before);
  const snapshots = [parsed.library.schemes[0], parsed.library.schemes[1], parsed.base.library.schemes[0], parsed.base.library.schemes[1]];
  assert.equal(new Set(snapshots.map((item) => item.preferences)).size, 4);
  for (const device of devices) assert.equal(new Set(snapshots.map((item) => item.preferences.devices[device].items[0])).size, 4);
  parsed.library.schemes[0].preferences.sidebar.hidden.push("accounts");
  parsed.library.schemes[0].preferences.devices.desktop.items[0].height = 400;
  parsed.base.library.schemes.pop();
  assert.deepEqual(value, before);
  assert.deepEqual(parsed.library.schemes[1].preferences, before.library.schemes[1].preferences);
});

const shapeTargets = [
  ["envelope", (value) => value], ["library", (value) => value.library],
  ["scheme", (value) => value.library.schemes[0]], ["base", (value) => value.base],
  ["base library", (value) => value.base.library], ["base scheme", (value) => value.base.library.schemes[0]],
  ...["current", "base"].flatMap((side) => {
    const prefs = (value) => (side === "current" ? value.library : value.base.library).schemes[0].preferences;
    return [
      [`${side} preferences`, prefs], [`${side} sidebar`, (value) => prefs(value).sidebar],
      [`${side} devices`, (value) => prefs(value).devices],
      ...devices.flatMap((device) => [
        [`${side} ${device}`, (value) => prefs(value).devices[device]],
        [`${side} ${device} module`, (value) => prefs(value).devices[device].items[0]],
      ]),
    ];
  }),
];
for (const [label, select] of shapeTargets) {
  test(`${label}: missing/extra/non-enumerable/symbol/prototype/accessor fields fail closed`, () => {
    for (const key of Object.keys(select(envelope(1, 1)))) {
      for (const mode of ["missing", "undefined", "hidden", "getter"]) {
        const value = envelope(1, 1), target = select(value);
        let calls = 0;
        if (mode === "missing") delete target[key];
        if (mode === "undefined") target[key] = undefined;
        if (mode === "hidden") Object.defineProperty(target, key, { enumerable: false });
        if (mode === "getter") Object.defineProperty(target, key, { enumerable: true, get() { calls += 1; throw new Error("must not run"); } });
        assert.equal(parseNamedLayoutEnvelope(value), null, `${label}/${key}/${mode}`);
        assert.equal(calls, 0);
      }
    }
    for (const key of ["balance", "transactions", "ownerId", "token", "css", "__proto__", "constructor", "toJSON", Symbol("extra")]) {
      const value = envelope(1, 1);
      Object.defineProperty(select(value), key, { enumerable: true, value: "synthetic-only" });
      assert.equal(parseNamedLayoutEnvelope(value), null);
    }
    for (const mode of ["hidden extra", "extra getter", "custom prototype"]) {
      const value = envelope(1, 1), target = select(value);
      let calls = 0;
      if (mode === "hidden extra") Object.defineProperty(target, "extra", { value: true });
      if (mode === "extra getter") Object.defineProperty(target, "extra", { enumerable: true, get() { calls += 1; throw new Error("must not run"); } });
      if (mode === "custom prototype") Object.setPrototypeOf(target, { synthetic: true });
      assert.equal(parseNamedLayoutEnvelope(value), null);
      assert.equal(calls, 0);
    }
  });
}

test("null-prototype records are accepted consistently, but all output records are fresh", () => {
  function nullRecords(value) {
    if (Array.isArray(value)) return value.map(nullRecords);
    if (value === null || typeof value !== "object") return value;
    return Object.assign(Object.create(null), Object.fromEntries(Object.entries(value).map(([key, item]) => [key, nullRecords(item)])));
  }
  const input = nullRecords(envelope(2, 3));
  assert.deepEqual(parseNamedLayoutEnvelope(input), envelope(2, 3));
  assert.notEqual(parseNamedLayoutEnvelope(input).library, input.library);
});

test("arrays reject holes, extra keys, accessors, subclasses and modified prototypes", () => {
  const targets = [
    (value) => value.library.schemes, (value) => value.base.library.schemes,
    ...["current", "base"].flatMap((side) => {
      const prefs = (value) => (side === "current" ? value.library : value.base.library).schemes[0].preferences;
      return [(value) => prefs(value).sidebar.hidden, ...devices.map((device) => (value) => prefs(value).devices[device].items)];
    }),
  ];
  for (const select of targets) {
    for (const mode of ["hole", "extra", "symbol", "hidden", "getter", "prototype", "subclass"]) {
      const value = envelope(1, 1), array = select(value);
      if (array.length === 0) array.push("accounts");
      let calls = 0;
      if (mode === "hole") delete array[0];
      if (mode === "extra") array.extra = "synthetic";
      if (mode === "symbol") array[Symbol("extra")] = true;
      if (mode === "hidden") Object.defineProperty(array, "0", { enumerable: false });
      if (mode === "getter") Object.defineProperty(array, "0", { get() { calls += 1; throw new Error("must not run"); } });
      if (mode === "prototype") Object.setPrototypeOf(array, null);
      if (mode === "subclass") Object.setPrototypeOf(array, class extends Array {}.prototype);
      assert.equal(parseNamedLayoutEnvelope(value), null, mode);
      assert.equal(calls, 0);
    }
  }
});

test("strict existing display parsing applies independently to every scheme and device", () => {
  for (const side of ["current", "base"]) for (let index = 0; index < 10; index += 1) for (const device of devices) {
    for (const mutate of [
      (prefs) => { prefs.devices[device].items[0].amount = 999999; },
      (prefs) => { prefs.devices[device].items[0].width = 5; },
      (prefs) => { prefs.devices[device].items[1].id = prefs.devices[device].items[0].id; },
      (prefs) => { prefs.sidebar.hidden = ["home"]; },
      (prefs) => { prefs.devices[device].enabled = "true"; },
      (prefs) => { prefs.devices[device].items.pop(); },
    ]) {
      const value = envelope(10, 1);
      mutate((side === "current" ? value.library : value.base.library).schemes[index].preferences);
      assert.equal(parseNamedLayoutEnvelope(value), null, `${side}/${index}/${device}`);
    }
  }
});

test("unknown versions, cycles, revoked proxies and arbitrary malformed objects never throw", () => {
  for (const version of [0, 2, "1", null, true, {}, NaN]) for (const select of [(value) => value, (value) => value.library, (value) => value.base.library]) {
    const value = envelope(1, 1); select(value).version = version;
    assert.equal(parseNamedLayoutEnvelope(value), null);
  }
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const cyclic = {}; cyclic.library = cyclic;
  const bad = [null, undefined, false, 1, "{}", JSON.stringify(envelope()), 1n, Symbol(), () => {}, [], new Date(), cyclic, revoked.proxy];
  for (const trap of ["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"]) bad.push(new Proxy(library(), { [trap]() { throw new Error("synthetic private error"); } }));
  for (const value of bad) {
    assert.equal(parseNamedLayoutLibrary(value), null);
    assert.equal(parseNamedLayoutEnvelope(value), null);
    const nested = envelope(1, 1); nested.base.library = value;
    assert.equal(parseNamedLayoutEnvelope(nested), null);
  }
  const proxied = new Proxy(library(), { get() { assert.fail("data getter must not run"); } });
  assert.deepEqual(parseNamedLayoutLibrary(proxied), library());
  for (const field of ["library", "base"]) {
    const value = envelope(1, 1); value[field] = value;
    assert.equal(parseNamedLayoutEnvelope(value), null);
  }
});

test("keys isolate local, guest and case-sensitive cloud owners from display preference keys", () => {
  const scopes = [local, guest, cloudA, cloudB, { kind: "cloud", ownerId: "SYNTHETIC-owner_A" }];
  assert.equal(new Set(scopes.map(namedLayoutStorageKey)).size, scopes.length);
  assert.equal(namedLayoutStorageKey(local), "wealth-atlas.named-display-layouts.v1.local");
  for (const scope of scopes) assert.notEqual(namedLayoutStorageKey(scope), displayStorageKey(scope));
  for (const kind of ["local", "guest"]) {
    assert.equal(namedLayoutStorageKey({ kind, ownerId: "synthetic name@example.invalid" }), namedLayoutStorageKey({ kind, ownerId: null }));
  }
  for (const ownerId of ["a", "A_9-z", "x".repeat(128)]) assert.ok(namedLayoutStorageKey({ kind: "cloud", ownerId }));
  for (const ownerId of [null, "", "x".repeat(129), "../owner", "owner.id", "a\n", "a\r\n", "a\u2028", "a ", "名字", "synthetic@example.invalid", 123, {}, undefined]) {
    assert.equal(namedLayoutStorageKey({ kind: "cloud", ownerId }), null);
  }
  for (const value of [locked, null, undefined, {}, { ...cloudA, epoch: 1 }, { kind: "cloud" }, { kind: "unknown", ownerId: null }, { ...local, ownerId: 123 }]) {
    assert.equal(namedLayoutStorageKey(value), null);
  }
  let calls = 0;
  const getter = Object.defineProperty({ ...cloudA }, "ownerId", { get() { calls += 1; throw new Error("must not run"); } });
  assert.equal(namedLayoutStorageKey(getter), null);
  assert.equal(calls, 0);
  assert.equal(namedLayoutStorageKey(Object.assign(Object.create(null), cloudA)), namedLayoutStorageKey(cloudA));
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  assert.equal(namedLayoutStorageKey(revoked.proxy), null);
});

test("locked/invalid scopes never resolve browser storage or locks", async (t) => {
  browser(t);
  let lookups = 0;
  for (const name of ["localStorage", "navigator"]) Object.defineProperty(globalThis, name, {
    configurable: true, get() { lookups += 1; throw new Error("synthetic private error"); },
  });
  for (const scope of [locked, null, { kind: "cloud", ownerId: null }, { kind: "cloud", ownerId: "bad.id" }]) {
    assert.deepEqual(readNamedLayouts(scope), { envelope: emptyEnvelope(), raw: null, status: "locked" });
    assert.deepEqual(await writeNamedLayouts(scope, envelope(), null, active), failure("inactive"));
  }
  assert.equal(lookups, 0);
});

test("reads default to empty without initializing, migrating or reading legacy/other-owner keys", (t) => {
  const storage = new MemoryStorage([
    [displayStorageKey(local), JSON.stringify(createDisplayPreferences())],
    [namedLayoutStorageKey(local), JSON.stringify(envelope())],
    ["wealth-atlas.named-display-layouts", JSON.stringify(envelope())],
    ["wealth-atlas.preview-only.home-diy.v4.demo-a", JSON.stringify(envelope())],
  ]);
  browser(t, storage);
  for (const scope of [guest, cloudA, cloudB]) {
    const result = readNamedLayouts(scope);
    assert.deepEqual(result, { envelope: emptyEnvelope(), raw: null, status: "default" });
    result.envelope.library.schemes.push(scheme());
  }
  assert.deepEqual(storage.reads, [guest, cloudA, cloudB].map(namedLayoutStorageKey));
  assert.deepEqual(storage.writes, []);
  assert.deepEqual(readNamedLayouts(guest).envelope, emptyEnvelope());
});

test("writes atomically roundtrip current/base snapshots, with all storage access under an exclusive scope lock", async (t) => {
  const { storage, locks } = browser(t);
  const scopes = [local, guest, cloudA, cloudB];
  const originalGet = storage.getItem, originalSet = storage.setItem;
  storage.getItem = function (key) { assert.ok(locks.inside.has(key)); return originalGet.call(this, key); };
  storage.setItem = function (key, raw) { assert.ok(locks.inside.has(key)); return originalSet.call(this, key, raw); };
  const saved = [];
  for (const [index, scope] of scopes.entries()) {
    const value = envelope(10, index + 1);
    value.library.schemes[0].preferences.devices.desktop.gap = 12 + index;
    value.library.schemes[0].preferences.sidebar.hidden = ["accounts"];
    value.library.schemes[0].preferences.devices.mobile.items.reverse();
    const before = clone(value), result = await writeNamedLayouts(scope, value, null, active);
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(result.raw), before);
    assert.deepEqual(value, before);
    assert.ok(Buffer.byteLength(result.raw, "utf8") <= CAP);
    assert.doesNotMatch(result.raw, /"(?:balance|transactions|ownerId|access_token|css|style)":|synthetic-owner/);
    saved.push({ envelope: before, raw: result.raw, status: "stored" });
  }
  assert.deepEqual(locks.requests, scopes.map((scope) => ({ name: namedLayoutStorageKey(scope), options: { mode: "exclusive" } })));
  assert.deepEqual(storage.writes.map(([key]) => key), scopes.map(namedLayoutStorageKey));
  assert.equal(storage.values.size, 4);
  assert.deepEqual(storage.reads, scopes.flatMap((scope) => [namedLayoutStorageKey(scope), namedLayoutStorageKey(scope)]));
  storage.getItem = originalGet;
  scopes.forEach((scope, index) => assert.deepEqual(readNamedLayouts(scope), saved[index]));
  const first = readNamedLayouts(cloudA);
  first.envelope.library.schemes[0].preferences.sidebar.hidden.push("reports");
  first.envelope.base.library.schemes[0].preferences.devices.tablet.gap = 32;
  assert.deepEqual(readNamedLayouts(cloudA), saved[2]);
});

test("malformed JSON, unknown schemas, private extras and oversized raw stay unchanged on read/save", async (t) => {
  const { storage } = browser(t);
  const key = namedLayoutStorageKey(local);
  const invalidEnvelope = envelope(); invalidEnvelope.library.schemes[0].preferences.balance = "synthetic-only";
  const raws = ["", "{", "null", "[]", "true", "1", JSON.stringify(library()), JSON.stringify({ ...envelope(), version: 2 }), JSON.stringify(invalidEnvelope),
    '{"version":1,"library":{"version":1,"schemes":[]},"base":null,"__proto__":{"synthetic":true}}',
    " ".repeat(CAP + 1),
  ];
  for (const raw of raws) {
    storage.values.set(key, raw);
    assert.deepEqual(readNamedLayouts(local), { envelope: emptyEnvelope(), raw, status: "invalid" });
    assert.deepEqual(await writeNamedLayouts(local, envelope(), raw, active), failure("invalid"));
    assert.equal(storage.values.get(key), raw);
  }
  assert.deepEqual(storage.writes, []);
  assert.equal(Object.prototype.synthetic, undefined);
});

test("raw limit is inclusive 256 KiB UTF-8 bytes, not JS string length", async (t) => {
  const { storage } = browser(t), key = namedLayoutStorageKey(local);
  const value = envelope(); value.library.schemes[0].name = "😀".repeat(30);
  const compact = JSON.stringify(value);
  const boundary = `${compact}${" ".repeat(CAP - Buffer.byteLength(compact, "utf8"))}`;
  assert.equal(Buffer.byteLength(boundary, "utf8"), CAP);
  assert.ok(boundary.length < CAP);
  storage.values.set(key, boundary);
  assert.deepEqual(readNamedLayouts(local), { envelope: value, raw: boundary, status: "stored" });
  assert.equal((await writeNamedLayouts(local, value, boundary, active)).ok, true);
  for (const raw of [`${boundary} `, `${boundary}\n`, " ".repeat(CAP + 1)]) {
    storage.values.set(key, raw);
    assert.equal(readNamedLayouts(local).status, "invalid");
    assert.deepEqual(await writeNamedLayouts(local, value, raw, active), failure("invalid"));
    assert.equal(storage.values.get(key), raw);
  }
  assert.equal(storage.writes.length, 1);
});

test("invalid envelopes and CAS token types do not resolve storage or request locks", async (t) => {
  const { locks } = browser(t);
  let lookups = 0;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { lookups += 1; throw new Error("must not run"); } });
  const getter = envelope();
  let calls = 0;
  Object.defineProperty(getter.library.schemes[0], "preferences", { get() { calls += 1; throw new Error("must not run"); } });
  for (const value of [null, undefined, {}, { ...envelope(), version: 2 }, envelope(11), envelope(1, 2147483648), getter]) {
    assert.deepEqual(await writeNamedLayouts(local, value, null, active), failure("invalid"));
  }
  for (const token of [undefined, 0, true, {}, [], new String("raw"), " ".repeat(CAP + 1)]) {
    assert.deepEqual(await writeNamedLayouts(local, envelope(), token, active), failure("invalid"));
  }
  assert.equal(calls, 0);
  assert.equal(lookups, 0);
  assert.deepEqual(locks.requests, []);
});

test("CAS rejects missing, deleted, stale and semantically equal but byte-different snapshots", async (t) => {
  const { storage } = browser(t), key = namedLayoutStorageKey(local), raw = JSON.stringify(envelope());
  for (const [current, expected] of [[raw, null], [null, raw], [raw, `${raw}\n`], ["corrupt", null]]) {
    if (current === null) storage.values.delete(key); else storage.values.set(key, current);
    assert.deepEqual(await writeNamedLayouts(local, envelope(), expected, active), failure("conflict"));
    assert.equal(storage.values.get(key) ?? null, current);
  }
  assert.deepEqual(storage.writes, []);
  storage.values.clear();
  const first = await writeNamedLayouts(local, envelope(1, 1), null, active);
  const updated = envelope(2, 2);
  const second = await writeNamedLayouts(local, updated, first.raw, active);
  assert.equal(second.ok, true);
  assert.deepEqual(await writeNamedLayouts(local, envelope(3, 1), first.raw, active), failure("conflict"));
  assert.deepEqual(JSON.parse(storage.values.get(key)), updated);
  assert.equal(storage.writes.length, 2);
});

test("identical saves skip setItem only after lock, CAS, validation and active checks", async (t) => {
  const { storage, locks } = browser(t), key = namedLayoutStorageKey(local), value = envelope(1, 2), raw = JSON.stringify(value);
  storage.values.set(key, raw);
  Object.defineProperty(storage, "setItem", { get() { assert.fail("no-op must not resolve setItem"); } });
  assert.deepEqual(await writeNamedLayouts(local, value, raw, active), { ok: true, raw });
  assert.deepEqual(await writeNamedLayouts(local, value, null, active), failure("conflict"));
  assert.deepEqual(await writeNamedLayouts(local, value, raw, () => false), failure("inactive"));
  assert.equal(locks.requests.length, 2);
  assert.deepEqual(storage.writes, []);
  assert.deepEqual(storage.reads, [key, key]);
});

test("same-scope contention allows only one writer with the original CAS token", async (t) => {
  const { storage, locks } = browser(t), key = namedLayoutStorageKey(local);
  const blocker = await hold(locks, key);
  const pending = Array.from({ length: 20 }, (_, index) => {
    const value = envelope(1, index + 1); value.library.schemes[0].name = `Writer ${index}`;
    return writeNamedLayouts(local, value, null, active);
  });
  assert.deepEqual(storage.reads, []);
  assert.deepEqual(storage.writes, []);
  blocker.release();
  const results = await Promise.all(pending); await blocker.done;
  assert.equal(results[0].ok, true);
  assert.deepEqual(results.slice(1), Array(19).fill(failure("conflict")));
  assert.equal(storage.writes.length, 1);
  assert.equal(JSON.parse(storage.values.get(key)).library.schemes[0].name, "Writer 0");
  assert.equal(JSON.parse(storage.values.get(key)).base.revision, 1);
  assert.equal(locks.inside.size, 0);
});

test("independent owners do not block one another or read/write one another's keys", async (t) => {
  const { storage, locks } = browser(t), keyA = namedLayoutStorageKey(cloudA), keyB = namedLayoutStorageKey(cloudB);
  const blocker = await hold(locks, keyA);
  const pendingA = writeNamedLayouts(cloudA, envelope(1, 1), null, active);
  const resultB = await writeNamedLayouts(cloudB, envelope(2, 2), null, active);
  assert.equal(resultB.ok, true);
  assert.deepEqual(storage.reads, [keyB, keyB]);
  assert.deepEqual(storage.writes.map(([key]) => key), [keyB]);
  blocker.release(); await blocker.done;
  assert.equal((await pendingA).ok, true);
  assert.deepEqual(storage.writes.map(([key]) => key), [keyB, keyA]);
});

test("queued writer re-reads CAS inside its lock and snapshots inputs before waiting", async (t) => {
  const { storage, locks } = browser(t), key = namedLayoutStorageKey(local);
  let blocker = await hold(locks, key);
  const value = envelope(1, 4), before = clone(value), mutableScope = { ...local };
  const pending = writeNamedLayouts(mutableScope, value, null, active);
  value.library.schemes[0].name = "Changed while waiting";
  value.library.schemes[0].preferences.devices.desktop.gap = 32;
  value.base.library.schemes.pop();
  mutableScope.kind = "guest";
  blocker.release(); await blocker.done;
  assert.equal((await pending).ok, true);
  assert.deepEqual(JSON.parse(storage.values.get(key)), before);
  const raw = storage.values.get(key);
  blocker = await hold(locks, key);
  const stale = writeNamedLayouts(local, envelope(2, 5), raw, active);
  const newer = JSON.stringify(envelope(3, 6));
  storage.values.set(key, newer);
  blocker.release(); await blocker.done;
  assert.deepEqual(await stale, failure("conflict"));
  assert.equal(storage.values.get(key), newer);
  assert.equal(storage.writes.length, 1);
});

test("epoch invalidation while queued prevents old writes even after switching back to the same owner", async (t) => {
  const { storage, locks } = browser(t), key = namedLayoutStorageKey(cloudA);
  const blocker = await hold(locks, key);
  let epoch = 1;
  const captured = epoch;
  const pending = writeNamedLayouts(cloudA, envelope(), null, () => epoch === captured);
  epoch += 1; // A -> B
  epoch += 1; // B -> A, but NOT the original session
  blocker.release(); await blocker.done;
  assert.deepEqual(await pending, failure("inactive"));
  assert.deepEqual(storage.reads, []);
  assert.deepEqual(storage.writes, []);
});

test("inactive, throwing and non-boolean guards fail closed before browser lookups", async (t) => {
  const { locks, storage } = browser(t);
  for (const guard of [undefined, null, false, () => false, () => 1, () => "true", async () => true, () => { throw new Error("synthetic"); }]) {
    assert.deepEqual(await writeNamedLayouts(local, envelope(), null, guard), failure("inactive"));
  }
  assert.deepEqual(locks.requests, []);
  assert.deepEqual(storage.reads, []);
});

for (const phase of ["storage getter", "getItem getter", "CAS read", "setItem getter", "readback", "lock acknowledgement"]) {
  test(`active epoch guard is rechecked after ${phase}`, async (t) => {
    const { storage, locks } = browser(t);
    let current = true, writes = 0, reads = 0;
    const originalGet = storage.getItem, originalSet = storage.setItem;
    const get = function (key) {
      reads += 1;
      if ((phase === "CAS read" && reads === 1) || (phase === "readback" && reads === 2)) current = false;
      return originalGet.call(storage, key);
    };
    const set = function (key, raw) { writes += 1; return originalSet.call(storage, key, raw); };
    storage.getItem = get; storage.setItem = set;
    if (phase === "storage getter") Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { current = false; return storage; } });
    if (phase === "getItem getter") Object.defineProperty(storage, "getItem", { get() { current = false; return get; } });
    if (phase === "setItem getter") Object.defineProperty(storage, "setItem", { get() { current = false; return set; } });
    if (phase === "lock acknowledgement") {
      const request = locks.request.bind(locks);
      locks.request = async (...args) => { const result = await request(...args); current = false; return result; };
    }
    assert.deepEqual(await writeNamedLayouts(local, envelope(), null, () => current), failure("inactive"));
    assert.equal(writes, ["readback", "lock acknowledgement"].includes(phase) ? 1 : 0);
  });
}

test("missing navigator/Web Locks always returns unsupported, without touching storage", async (t) => {
  browser(t);
  let lookups = 0;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { lookups += 1; throw new Error("must not run"); } });
  for (const value of [undefined, null, {}, { locks: null }, { locks: {} }, { locks: { request: 1 } }]) {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value });
    assert.deepEqual(await writeNamedLayouts(local, envelope(), null, active), failure("unsupported"));
  }
  assert.equal(lookups, 0);
});

test("lock lookup/request errors return unavailable without storage access or retries", async (t) => {
  const { storage } = browser(t);
  let attempts = 0;
  const unavailable = () => { attempts += 1; throw new Error("synthetic private error"); };
  for (const value of [
    Object.defineProperty({}, "locks", { get: unavailable }),
    { locks: Object.defineProperty({}, "request", { get: unavailable }) },
    { locks: { request: unavailable } },
    { locks: { request() { attempts += 1; return Promise.reject(new Error("synthetic private error")); } } },
  ]) {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value });
    assert.deepEqual(await writeNamedLayouts(local, envelope(), null, active), failure("unavailable"));
  }
  Object.defineProperty(globalThis, "navigator", { configurable: true, get: unavailable });
  assert.deepEqual(await writeNamedLayouts(local, envelope(), null, active), failure("unavailable"));
  assert.equal(attempts, 5);
  assert.deepEqual(storage.reads, []);
  assert.deepEqual(storage.writes, []);
});

for (const mode of ["missing", "null", "missing methods", "storage getter", "getItem getter", "read throw", "read undefined", "read object"]) {
  test(`unavailable storage (${mode}) returns safe statuses without writes`, async (t) => {
    let writes = 0;
    const storage = {
      getItem() { if (mode === "read throw") throw new Error("synthetic private error"); return mode === "read object" ? {} : undefined; },
      setItem() { writes += 1; },
    };
    browser(t, storage);
    if (mode === "missing" || mode === "null" || mode === "missing methods") Object.defineProperty(globalThis, "localStorage", { configurable: true, value: mode === "missing" ? undefined : mode === "null" ? null : {} });
    if (mode === "storage getter") Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("synthetic private error"); } });
    if (mode === "getItem getter") Object.defineProperty(storage, "getItem", { get() { throw new Error("synthetic private error"); } });
    assert.deepEqual(readNamedLayouts(local), { envelope: emptyEnvelope(), raw: null, status: "unavailable" });
    assert.deepEqual(await writeNamedLayouts(local, envelope(), null, active), failure("unavailable"));
    assert.equal(writes, 0);
  });
}

for (const mode of ["quota", "setItem getter", "ignored", "transformed", "readback throws", "readback non-string"]) {
  test(`failed/modified writes (${mode}) cannot claim success, split metadata or retry`, async (t) => {
    const value = envelope(1, 8), prior = JSON.stringify(envelope(2, 7)), key = namedLayoutStorageKey(local);
    let current = prior, reads = 0, writes = 0;
    const storage = {
      getItem() {
        reads += 1;
        if (reads > 1 && mode === "readback throws") throw new Error("synthetic private error");
        if (reads > 1 && mode === "readback non-string") return {};
        return current;
      },
      setItem(actualKey, raw) {
        assert.equal(actualKey, key);
        writes += 1;
        if (mode === "quota") throw new DOMException("synthetic quota", "QuotaExceededError");
        if (mode === "transformed") current = `${raw}\n`;
        if (mode === "readback throws" || mode === "readback non-string") current = raw;
      },
    };
    if (mode === "setItem getter") Object.defineProperty(storage, "setItem", { get() { throw new Error("synthetic private error"); } });
    browser(t, storage);
    assert.deepEqual(await writeNamedLayouts(local, value, prior, active), failure("unavailable"));
    assert.equal(writes, mode === "setItem getter" ? 0 : 1);
    assert.equal(reads, ["quota", "setItem getter"].includes(mode) ? 1 : 2);
    if (["quota", "setItem getter", "ignored"].includes(mode)) assert.equal(current, prior);
    else assert.deepEqual(JSON.parse(current), value); // both base+library in the one envelope
  });
}

test("a quota failure releases the lock and a later explicit retry can succeed", async (t) => {
  const { storage, locks } = browser(t), originalSet = storage.setItem;
  storage.setItem = () => { throw new DOMException("synthetic quota", "QuotaExceededError"); };
  assert.deepEqual(await writeNamedLayouts(local, envelope(), null, active), failure("unavailable"));
  assert.equal(locks.inside.size, 0);
  assert.equal(storage.values.size, 0);
  storage.setItem = originalSet;
  const result = await writeNamedLayouts(local, envelope(), null, active);
  assert.equal(result.ok, true);
  assert.equal(storage.writes.length, 1);
  assert.deepEqual(readNamedLayouts(local), { envelope: envelope(), raw: result.raw, status: "stored" });
});
