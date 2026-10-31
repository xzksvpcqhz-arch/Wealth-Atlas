import assert from "node:assert/strict";
import test from "node:test";
import {
  HOME_MODULES, SIDEBAR_ITEMS, createDisplayPreferences, parseDisplayPreferences,
  displayStorageKey, readDisplayPreferences, writeDisplayPreferences,
} from "../lib/display-preferences.ts";

const devices = ["desktop", "tablet", "mobile"];
const motions = ["none", "fade", "up", "down", "left", "right", "spring", "zoom", "reveal"];
const local = { kind: "local", ownerId: null };
const guest = { kind: "guest", ownerId: null };
const locked = { kind: "locked", ownerId: null };
const cloudA = { kind: "cloud", ownerId: "synthetic-owner_A" };
const cloudB = { kind: "cloud", ownerId: "synthetic-owner_B" };
const moduleKeys = [
  "id", "width", "height", "padding", "title", "amount", "body", "titleWeight",
  "amountWeight", "bodyWeight", "motion", "duration", "visible", "detailsExpanded",
];
const clone = (value) => structuredClone(value);
const encodedDefaults = () => JSON.stringify(createDisplayPreferences());

class MemoryStorage {
  values = new Map();
  reads = [];
  writes = [];
  constructor(entries = []) { this.values = new Map(entries); }
  getItem(key) { this.reads.push(key); return this.values.get(key) ?? null; }
  setItem(key, raw) { this.writes.push([key, raw]); this.values.set(key, raw); }
}

test("static metadata matches the approved preview without sample finance values", () => {
  assert.deepEqual(HOME_MODULES.map((item) => [item.id, item.label, item.icon, item.width, item.height, item.amount]), [
    ["free", "本月可自由使用", "Sparkle", 12, 224, 44],
    ["income", "本月收入", "ArrowDownLeft", 6, 160, 30],
    ["expense", "本月支出", "ArrowUpRight", 6, 160, 30],
    ["net-worth", "净资产", "ChartLineUp", 4, 160, 28],
    ["budget", "预算剩余", "Scales", 4, 160, 28],
    ["accounts", "账户总览", "Wallet", 4, 208, 28],
    ["sgd-myr", "SGD/MYR 汇率", "Coins", 4, 160, 30],
    ["usd-sgd", "USD/SGD 汇率", "Coins", 4, 160, 30],
    ["currency", "货币暴露", "Globe", 4, 208, 28],
    ["recent", "最近收支记录", "Receipt", 8, 208, 28],
    ["watchlist", "Watchlist", "Binoculars", 4, 184, 28],
    ["reminders", "理财师提醒", "Bell", 4, 184, 28],
    ["quick", "快捷操作", "Lightning", 12, 160, 28],
  ]);
  assert.deepEqual(SIDEBAR_ITEMS.map(({ id, label }) => [id, label]), [
    ["home", "首页"], ["accounts", "账户总览"], ["reports", "报表中心"],
    ["transactions", "收支记录"], ["budget", "预算管理"], ["assets", "资产管理"],
    ["goals", "目标与计划"], ["cashflow", "未来现金流"], ["watchlists", "Watchlist"],
    ["insurance", "保险管理"], ["insights", "理财师提醒"], ["fx", "汇率中心"],
    ["trash", "回收站"], ["settings", "设置"], ["capture", "记一笔"],
    ["transfer", "记转账"], ["obsidian", "同步 Obsidian"], ["excel", "导出 Excel"],
    ["theme-mode", "日间／夜间模式"], ["appearance", "外观"],
  ]);
  assert.deepEqual(SIDEBAR_ITEMS.filter((item) => item.locked).map((item) => item.id), ["home", "settings"]);
  assert.deepEqual(SIDEBAR_ITEMS.map((item) => item.group), [...Array(14).fill("pages"), ...Array(6).fill("shortcuts")]);
  for (const [entries, keys] of [[HOME_MODULES, ["id", "label", "icon", "width", "height", "amount"]], [SIDEBAR_ITEMS, ["id", "label", "locked", "group"]]]) {
    assert.ok(Object.isFrozen(entries));
    for (const item of entries) {
      assert.ok(Object.isFrozen(item));
      assert.deepEqual(Object.keys(item), keys);
    }
  }
});

test("fresh nested defaults preserve the baseline and match every preview setting", () => {
  const first = createDisplayPreferences();
  const second = createDisplayPreferences();
  assert.equal(first.version, 1);
  assert.deepEqual(first.sidebar, { hidden: [] });
  for (const device of devices) {
    assert.equal(first.devices[device].enabled, false);
    assert.equal(first.devices[device].gap, 24);
    assert.equal(first.devices[device].groupMotion, "none");
    assert.deepEqual(first.devices[device].items, HOME_MODULES.map(({ id, width, height, amount }) => ({
      id, width, height, padding: 22, title: 18, amount, body: 13,
      titleWeight: 600, amountWeight: 700, bodyWeight: 400,
      motion: "none", duration: 280, visible: true, detailsExpanded: true,
    })));
    assert.notEqual(first.devices[device], second.devices[device]);
    assert.notEqual(first.devices[device].items, second.devices[device].items);
    assert.notEqual(first.devices[device].items[0], second.devices[device].items[0]);
  }
  first.sidebar.hidden.push("accounts");
  first.devices.desktop.items[0].width = 4;
  first.devices.tablet.items.reverse();
  assert.deepEqual(second, createDisplayPreferences());
  assert.equal(first.devices.mobile.items[0].width, 12);
  assert.equal(first.devices.desktop.items[0].id, "free");
});

test("parser clones all nested data without modifying inputs", () => {
  const input = createDisplayPreferences();
  const before = clone(input);
  const parsed = parseDisplayPreferences(input);
  assert.deepEqual(parsed, input);
  parsed.sidebar.hidden.push("reports");
  for (const device of devices) parsed.devices[device].items[0].height = 400;
  assert.deepEqual(input, before);
  assert.notEqual(parsed.devices.desktop.items[0], parsed.devices.mobile.items[0]);
});

const bounds = { height: [144, 400], padding: [14, 32], title: [13, 28], amount: [20, 64], body: [13, 18], duration: [120, 600], gap: [12, 32] };
for (const device of devices) {
  for (const [field, [min, max]] of Object.entries(bounds)) {
    test(`${device}: ${field} accepts inclusive integer bounds only`, () => {
      for (const value of [min, max, min - 1, max + 1, min + 0.5, NaN, Infinity, -Infinity, String(min), true, null, undefined, {}, 1n]) {
        const prefs = createDisplayPreferences();
        const target = field === "gap" ? prefs.devices[device] : prefs.devices[device].items[0];
        target[field] = value;
        assert.equal(parseDisplayPreferences(prefs) !== null, value === min || value === max, String(value));
      }
    });
  }
  for (const [field, allowed] of [["width", [4, 6, 8, 12]], ["titleWeight", [400, 600, 700]], ["amountWeight", [400, 600, 700]], ["bodyWeight", [400, 600, 700]], ["motion", motions]]) {
    test(`${device}: ${field} is an exact allowlist`, () => {
      for (const value of [...allowed, 0, 5, 10, 500, 800, 4.5, "400", "slide", "scale", "fade; color:red", {}, null, true]) {
        const prefs = createDisplayPreferences();
        prefs.devices[device].items[0][field] = value;
        assert.equal(parseDisplayPreferences(prefs) !== null, allowed.includes(value), String(value));
      }
    });
  }
  test(`${device}: booleans and group motion are strict`, () => {
    for (const field of ["enabled", "visible", "detailsExpanded", "groupMotion"]) {
      const allowed = field === "groupMotion" ? ["none", "stagger"] : [true, false];
      for (const value of [...allowed, null, undefined, 0, 1, "true", "false", {}, [], "fade"]) {
        const prefs = createDisplayPreferences();
        const target = ["enabled", "groupMotion"].includes(field) ? prefs.devices[device] : prefs.devices[device].items[0];
        target[field] = value;
        assert.equal(parseDisplayPreferences(prefs) !== null, allowed.includes(value), `${field}: ${String(value)}`);
      }
    }
  });
  test(`${device}: exactly thirteen unique known module IDs are required`, () => {
    for (const mutate of [
      (items) => items.pop(),
      (items) => items.push(clone(items[0])),
      (items) => { items[1].id = items[0].id; },
      (items) => { items[0].id = "private-account"; },
      (items) => { items[0].id = null; },
      (items) => { items[0] = null; },
      (items) => { delete items[0]; },
    ]) {
      const prefs = createDisplayPreferences();
      mutate(prefs.devices[device].items);
      assert.equal(parseDisplayPreferences(prefs), null);
    }
    const reordered = createDisplayPreferences();
    reordered.devices[device].items.reverse();
    assert.deepEqual(parseDisplayPreferences(reordered), reordered);
  });
}

test("sidebar accepts every optional ID once, never locked, unknown or duplicate IDs", () => {
  const prefs = createDisplayPreferences();
  prefs.sidebar.hidden = SIDEBAR_ITEMS.filter((item) => !item.locked).map((item) => item.id);
  assert.deepEqual(parseDisplayPreferences(prefs), prefs);
  for (const hidden of [["home"], ["settings"], ["unknown"], ["accounts", "accounts"], [null], [1], [{}], ["__proto__"], ["appearance;display:none"], null, {}, Array(19).fill("accounts")]) {
    prefs.sidebar.hidden = hidden;
    assert.equal(parseDisplayPreferences(prefs), null);
  }
});

const shapeTargets = [
  ["root", (prefs) => prefs],
  ["sidebar", (prefs) => prefs.sidebar],
  ["devices", (prefs) => prefs.devices],
  ...devices.flatMap((device) => [
    [device, (prefs) => prefs.devices[device]],
    [`${device} item`, (prefs) => prefs.devices[device].items[0]],
  ]),
];
for (const [label, select] of shapeTargets) {
  test(`${label}: missing, null, private and non-JSON keys fail closed`, () => {
    const template = createDisplayPreferences();
    for (const key of Object.keys(select(template))) {
      for (const replacement of ["missing", null, undefined]) {
        const prefs = createDisplayPreferences();
        const target = select(prefs);
        if (replacement === "missing") delete target[key]; else target[key] = replacement;
        assert.equal(parseDisplayPreferences(prefs), null, key);
      }
    }
    for (const key of ["balance", "transactions", "access_token", "ownerId", "email", "profile", "style", "css", "__proto__", "constructor", "toJSON"]) {
      const prefs = createDisplayPreferences();
      Object.defineProperty(select(prefs), key, { value: "synthetic-private-extra", enumerable: true });
      assert.equal(parseDisplayPreferences(prefs), null, key);
    }
    for (const mode of ["symbol", "non-enumerable", "getter", "prototype"]) {
      const prefs = createDisplayPreferences();
      const target = select(prefs);
      if (mode === "symbol") target[Symbol("secret")] = "synthetic";
      if (mode === "non-enumerable") Object.defineProperty(target, "hiddenExtra", { value: "synthetic" });
      if (mode === "getter") Object.defineProperty(target, Object.keys(target)[0], { get() { throw new Error("must not run"); } });
      if (mode === "prototype") Object.setPrototypeOf(target, { access_token: "synthetic" });
      assert.equal(parseDisplayPreferences(prefs), null, mode);
    }
  });
}

test("every module requires every exact field, not just the first item", () => {
  for (const device of devices) {
    for (let index = 0; index < HOME_MODULES.length; index += 1) {
      for (const key of moduleKeys) {
        const prefs = createDisplayPreferences();
        delete prefs.devices[device].items[index][key];
        assert.equal(parseDisplayPreferences(prefs), null, `${device}/${index}/${key}`);
      }
    }
  }
});

test("unknown versions and arbitrary hostile runtime values never throw", () => {
  for (const version of [0, 2, 3, 4, "1", true, {}, null, NaN]) {
    const prefs = createDisplayPreferences();
    prefs.version = version;
    assert.equal(parseDisplayPreferences(prefs), null);
  }
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error("synthetic secret"); } });
  const cyclic = {}; cyclic.devices = cyclic;
  for (const value of [null, undefined, [], true, 1, "{}", encodedDefaults(), 1n, Symbol(), () => {}, new Date(), cyclic, revoked.proxy, hostile]) {
    assert.equal(parseDisplayPreferences(value), null);
  }
});

test("array properties, accessors, holes and prototypes cannot smuggle extra payloads", () => {
  for (const select of [(prefs) => prefs.sidebar.hidden, ...devices.map((device) => (prefs) => prefs.devices[device].items)]) {
    for (const mode of ["extra", "symbol", "getter", "prototype"]) {
      const prefs = createDisplayPreferences();
      const array = select(prefs);
      if (array.length === 0) array.push("accounts");
      if (mode === "extra") array.token = "synthetic";
      if (mode === "symbol") array[Symbol("extra")] = "synthetic";
      if (mode === "getter") Object.defineProperty(array, "0", { get() { throw new Error("must not run"); } });
      if (mode === "prototype") Object.setPrototypeOf(array, null);
      assert.equal(parseDisplayPreferences(prefs), null);
    }
  }
});

test("storage keys separate every scope and use only stable allowlisted cloud IDs", () => {
  const scopes = [local, guest, cloudA, cloudB];
  const keys = scopes.map(displayStorageKey);
  assert.equal(new Set(keys).size, scopes.length);
  assert.ok(keys.every((key) => typeof key === "string"));
  for (const ownerId of ["a", "A_9-z", "x".repeat(128)]) assert.ok(displayStorageKey({ kind: "cloud", ownerId }));
  for (const ownerId of [null, "", "x".repeat(129), "synthetic@example.invalid", "Synthetic Owner", "../owner", "owner.id", "id\n", "名字", "Bearer synthetic.token", 123, {}, undefined]) {
    assert.equal(displayStorageKey({ kind: "cloud", ownerId }), null, String(ownerId));
  }
  assert.equal(displayStorageKey({ ...local, ownerId: "Synthetic Name" }), displayStorageKey(local));
  assert.equal(displayStorageKey({ ...guest, ownerId: "synthetic@example.invalid" }), displayStorageKey(guest));
  for (const scope of [locked, { ...locked, ownerId: "synthetic-owner" }, { kind: "unknown", ownerId: null }, { kind: "cloud" }, { ...cloudA, epoch: 1 }, null, undefined]) {
    assert.equal(displayStorageKey(scope), null);
  }
  assert.equal(displayStorageKey(cloudA), displayStorageKey(clone(cloudA)));
});

test("locked or invalid scopes do not access storage, even its getters", () => {
  const inaccessible = new Proxy({}, { get() { assert.fail("storage must not be touched"); } });
  for (const scope of [locked, { kind: "cloud", ownerId: null }, { kind: "cloud", ownerId: "invalid.id" }, null]) {
    assert.deepEqual(readDisplayPreferences(scope, inaccessible), { value: createDisplayPreferences(), raw: null, status: "locked" });
    assert.deepEqual(writeDisplayPreferences(scope, createDisplayPreferences(), null, inaccessible), { ok: false, raw: null, reason: "locked" });
  }
});

test("reads never write, initialize, migrate or fall back to global/preview keys", () => {
  const storage = new MemoryStorage([
    ["wealth-atlas.display-preferences", encodedDefaults()],
    ["wealth-atlas.display-preferences.v1", encodedDefaults()],
    ["wealth-atlas.preview-only.home-diy.v4.demo-a", encodedDefaults()],
    [displayStorageKey(local), encodedDefaults()],
  ]);
  for (const scope of [guest, cloudA, cloudB]) {
    const result = readDisplayPreferences(scope, storage);
    assert.equal(result.status, "default");
    assert.equal(result.raw, null);
  }
  assert.deepEqual(storage.reads, [guest, cloudA, cloudB].map(displayStorageKey));
  assert.deepEqual(storage.writes, []);
  const first = readDisplayPreferences(guest, storage);
  first.value.sidebar.hidden.push("accounts");
  assert.deepEqual(readDisplayPreferences(guest, storage).value, createDisplayPreferences());
});

test("local, guest and two cloud accounts stay isolated without cross-scope reads or writes", () => {
  const storage = new MemoryStorage();
  const scopes = [local, guest, cloudA, cloudB];
  const saved = scopes.map((scope, index) => {
    const prefs = createDisplayPreferences();
    prefs.devices.desktop.enabled = true;
    prefs.devices.desktop.gap = 12 + index;
    prefs.sidebar.hidden = [SIDEBAR_ITEMS[index + 1].id];
    const result = writeDisplayPreferences(scope, prefs, null, storage);
    assert.equal(result.ok, true);
    return { prefs, raw: result.raw };
  });
  scopes.forEach((scope, index) => assert.deepEqual(readDisplayPreferences(scope, storage), { value: saved[index].prefs, raw: saved[index].raw, status: "stored" }));
  assert.equal(storage.values.size, 4);
  assert.deepEqual(storage.writes.map(([key]) => key), scopes.map(displayStorageKey));
  assert.deepEqual(storage.reads, [...scopes.flatMap((scope) => [displayStorageKey(scope), displayStorageKey(scope)]), ...scopes.map(displayStorageKey)]);
});

test("corrupt, oversized and unknown schemas stay unchanged, even on an explicit save", () => {
  const withExtra = createDisplayPreferences();
  withExtra.access_token = "synthetic-private-extra";
  for (const raw of ["", "{", "null", "[]", "{\"version\":2}", JSON.stringify({ ...createDisplayPreferences(), version: 4 }), JSON.stringify(withExtra), " ".repeat(32_769), `{\"version\":1,\"__proto__\":{},\"sidebar\":{},\"devices\":{}}`]) {
    const key = displayStorageKey(local);
    const storage = new MemoryStorage([[key, raw]]);
    const result = readDisplayPreferences(local, storage);
    assert.deepEqual(result, { status: "invalid", raw, value: createDisplayPreferences() });
    assert.deepEqual(writeDisplayPreferences(local, createDisplayPreferences(), raw, storage), { ok: false, raw, reason: "invalid" });
    assert.equal(storage.values.get(key), raw);
    assert.deepEqual(storage.writes, []);
  }
});

test("invalid new preferences and CAS tokens do not even read storage", () => {
  const storage = new MemoryStorage();
  const invalid = createDisplayPreferences();
  invalid.sidebar.css = "display:none";
  for (const value of [invalid, null, {}, { ...createDisplayPreferences(), version: 2 }]) {
    assert.deepEqual(writeDisplayPreferences(local, value, null, storage), { ok: false, raw: null, reason: "invalid" });
  }
  for (const expectedRaw of [undefined, {}, 1, false]) {
    assert.equal(writeDisplayPreferences(local, createDisplayPreferences(), expectedRaw, storage).reason, "invalid");
  }
  assert.deepEqual(storage.reads, []);
  assert.deepEqual(storage.writes, []);
});

test("compare-before-write refuses stale, missing and byte-different snapshots", () => {
  const raw = encodedDefaults();
  for (const [currentRaw, expectedRaw] of [[raw, null], [null, raw], [raw, `${raw}\n`], ["corrupt", null]]) {
    const key = displayStorageKey(local);
    const storage = new MemoryStorage(currentRaw === null ? [] : [[key, currentRaw]]);
    assert.deepEqual(writeDisplayPreferences(local, createDisplayPreferences(), expectedRaw, storage), { ok: false, raw: currentRaw, reason: "conflict" });
    assert.deepEqual(storage.writes, []);
    assert.equal(storage.getItem(key), currentRaw);
  }
  const storage = new MemoryStorage();
  const first = writeDisplayPreferences(local, createDisplayPreferences(), null, storage);
  const changed = createDisplayPreferences(); changed.devices.desktop.gap = 32;
  const second = writeDisplayPreferences(local, changed, first.raw, storage);
  assert.equal(second.ok, true);
  assert.equal(writeDisplayPreferences(local, createDisplayPreferences(), first.raw, storage).reason, "conflict");
  assert.equal(storage.getItem(displayStorageKey(local)), second.raw);
  assert.equal(storage.writes.length, 2);
});

test("roundtrips ordering, visibility, every motion/weight and independent device settings", () => {
  const prefs = createDisplayPreferences();
  prefs.sidebar.hidden = ["accounts", "capture", "theme-mode", "appearance"];
  devices.forEach((device, deviceIndex) => {
    const layout = prefs.devices[device];
    layout.enabled = deviceIndex !== 1;
    layout.gap = 12 + deviceIndex;
    layout.groupMotion = deviceIndex === 1 ? "none" : "stagger";
    layout.items.reverse();
    layout.items.forEach((item, index) => {
      item.visible = index % 2 === 0;
      item.detailsExpanded = index % 2 !== 0;
      item.motion = motions[index % motions.length];
      item.titleWeight = [400, 600, 700][index % 3];
      item.amountWeight = [600, 700, 400][index % 3];
      item.bodyWeight = [700, 400, 600][index % 3];
      item.width = [4, 6, 8, 12][index % 4];
    });
  });
  const before = clone(prefs);
  const storage = new MemoryStorage();
  const saved = writeDisplayPreferences(cloudA, prefs, null, storage);
  assert.deepEqual(prefs, before);
  assert.equal(saved.ok, true);
  assert.deepEqual(JSON.parse(saved.raw), prefs);
  const result = readDisplayPreferences(cloudA, storage);
  assert.deepEqual(result, { value: prefs, raw: saved.raw, status: "stored" });
  result.value.devices.desktop.items[0].visible = !result.value.devices.desktop.items[0].visible;
  assert.deepEqual(readDisplayPreferences(cloudA, storage).value, prefs);
  assert.ok(saved.raw.length < 12 * 1024);
  assert.doesNotMatch(saved.raw, /"(?:ownerId|access_token|currency|balance|style|css)":|synthetic-owner/);
});

test("unavailable storage/method getters return safe statuses without leaking errors", () => {
  const throwingGet = { getItem() { throw new Error("synthetic secret payload"); }, setItem() { assert.fail("must not write"); } };
  const accessorGet = Object.defineProperty({}, "getItem", { get() { throw new Error("synthetic secret payload"); } });
  for (const storage of [throwingGet, accessorGet, {}, null, { getItem: () => undefined }, { getItem: () => ({ private: "synthetic" }) }]) {
    assert.deepEqual(readDisplayPreferences(local, storage), { value: createDisplayPreferences(), raw: null, status: "unavailable" });
    assert.deepEqual(writeDisplayPreferences(local, createDisplayPreferences(), null, storage), { ok: false, raw: null, reason: "unavailable" });
  }
});

test("failed, ignored, transformed and unreadable writes never report success or retry", () => {
  for (const mode of ["throw", "setter-getter", "ignored", "transformed", "readback-throws", "readback-invalid"]) {
    let reads = 0;
    let writes = 0;
    const storage = {
      getItem() {
        reads += 1;
        if (reads === 1) return null;
        if (mode === "readback-throws") throw new Error("synthetic secret payload");
        if (mode === "readback-invalid") return {};
        return mode === "transformed" ? "changed-by-storage" : null;
      },
      setItem() { writes += 1; if (mode === "throw") throw new Error("synthetic secret payload"); },
    };
    if (mode === "setter-getter") Object.defineProperty(storage, "setItem", { get() { throw new Error("synthetic secret payload"); } });
    assert.deepEqual(writeDisplayPreferences(local, createDisplayPreferences(), null, storage), { ok: false, raw: null, reason: "unavailable" });
    assert.equal(writes, mode === "setter-getter" ? 0 : 1);
    assert.equal(reads, ["throw", "setter-getter"].includes(mode) ? 1 : 2);
  }
});

test("implicit browser storage is lazy, optional, guarded and bypassed while locked", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  try {
    let lookups = 0;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { lookups += 1; throw new Error("synthetic secret payload"); } });
    assert.equal(readDisplayPreferences(locked).status, "locked");
    assert.equal(writeDisplayPreferences(locked, createDisplayPreferences(), null).reason, "locked");
    assert.equal(lookups, 0);
    assert.equal(readDisplayPreferences(local).status, "unavailable");
    assert.equal(writeDisplayPreferences(local, createDisplayPreferences(), null).reason, "unavailable");
    assert.equal(lookups, 2);
    const explicit = new MemoryStorage();
    assert.equal(readDisplayPreferences(local, explicit).status, "default");
    assert.equal(writeDisplayPreferences(local, createDisplayPreferences(), null, explicit).ok, true);
    assert.equal(lookups, 2);
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: explicit });
    assert.equal(readDisplayPreferences(local).status, "stored");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: undefined });
    assert.equal(readDisplayPreferences(local).status, "unavailable");
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
