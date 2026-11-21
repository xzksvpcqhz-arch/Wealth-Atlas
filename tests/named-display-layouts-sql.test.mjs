// Static/source and synthetic contract tests. No network, credentials or live DB.
// The optional PGlite test uses memory only and executes functions against a
// synthetic temporary table, NOT hosted auth, RLS, or financial integration tests.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import * as preferences from "../lib/display-preferences.ts";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const clientModule = { exports: {} };
const clientSource = readFileSync(new URL("../lib/named-display-layouts.ts", import.meta.url), "utf8");
const clientCode = ts.transpileModule(clientSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function("require", "module", "exports", clientCode)((id) => {
  assert.equal(id, "./display-preferences", "only the display-only dependency is allowed");
  return preferences;
}, clientModule, clientModule.exports);
const client = clientModule.exports;

const sql = readFileSync(new URL("../supabase/named-display-layouts.sql", import.meta.url), "utf8");
const source = sql.replace(/--[^\r\n]*/g, "");
const compact = (text) => text.replace(/\s+/g, " ").trim();
const extractFunctions = (text) => [...text.matchAll(/CREATE FUNCTION public\.(\w+)\(([^)]*)\)\s+RETURNS\s+(boolean|trigger)([\s\S]*?)AS \$function\$([\s\S]*?)\$function\$;/g)]
  .map((m) => ({ name: m[1], args: compact(m[2]), returns: m[3], attributes: compact(m[4]), body: m[5], sql: m[0] }));
const functions = extractFunctions(source);
const valid = functions.find((fn) => fn.name === "user_ui_layout_libraries_valid");
const stamp = functions.find((fn) => fn.name === "user_ui_layout_libraries_stamp");
const decodeUnicode = (value) => value.replace(/\\(?:\+([\da-f]{6})|([\da-f]{4}))/gi,
  (_, long, short) => String.fromCodePoint(parseInt(long ?? short, 16)));
function unicodeConstant(name) {
  const match = valid.body.match(new RegExp(`\\b${name} CONSTANT text := U&'([^']*)';`));
  assert.ok(match, name);
  return decodeUnicode(match[1]);
}
const unsafePattern = new RegExp(unicodeConstant("unsafe_name_pattern"), "u");
const trimCharacters = new Set(unicodeConstant("trim_name_characters"));
const idPattern = new RegExp(valid.body.match(/!~ '([^']+)'/)?.[1]);
const payloadLimit = Number(valid.body.match(/octet_length\(p_library::text\) > (\d+)/)?.[1]);
const countLimit = Number(valid.body.match(/jsonb_array_length\(p_library -> 'schemes'\) > (\d+)/)?.[1]);

test("candidate transaction has an exact new-object/statement allowlist and fails on collisions", () => {
  assert.match(sql, /REVIEW CANDIDATE ONLY/);
  assert.match(sql, /main must compare the deployed definitions\/ACLs/);
  assert.doesNotMatch(source, /\bIF NOT EXISTS\b|\bOR REPLACE\b|\bDROP\b|\bTRUNCATE\b|\bSECURITY DEFINER\b|\bCREATE (?:EXTENSION|SCHEMA|ROLE|VIEW|PROCEDURE)\b/i);
  const statements = source.replace(/\$function\$[\s\S]*?\$function\$/g, "$body$").split(";").map(compact).filter(Boolean);
  const declaration = (name, args, returns, volatility) => `CREATE FUNCTION public.${name}(${args}) RETURNS ${returns} LANGUAGE plpgsql ${volatility} SECURITY INVOKER SET search_path = pg_catalog AS $body$`;
  assert.deepEqual(statements, [
    "BEGIN",
    declaration("user_ui_layout_libraries_valid", "p_library jsonb", "boolean", "IMMUTABLE"),
    "CREATE TABLE public.user_ui_layout_libraries ( user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE, schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1), revision integer NOT NULL DEFAULT 1 CHECK (revision > 0), library jsonb NOT NULL CHECK (public.user_ui_layout_libraries_valid(library) IS TRUE), updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp() )",
    declaration("user_ui_layout_libraries_stamp", "", "trigger", "VOLATILE"),
    "CREATE TRIGGER user_ui_layout_libraries_stamp_before_write BEFORE INSERT OR UPDATE ON public.user_ui_layout_libraries FOR EACH ROW EXECUTE FUNCTION public.user_ui_layout_libraries_stamp()",
    "ALTER TABLE public.user_ui_layout_libraries ENABLE ROW LEVEL SECURITY",
    "ALTER TABLE public.user_ui_layout_libraries FORCE ROW LEVEL SECURITY",
    "CREATE POLICY user_ui_layout_libraries_select_own ON public.user_ui_layout_libraries FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id)",
    "CREATE POLICY user_ui_layout_libraries_insert_own ON public.user_ui_layout_libraries FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id)",
    "CREATE POLICY user_ui_layout_libraries_update_own ON public.user_ui_layout_libraries FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id)",
    "REVOKE ALL ON TABLE public.user_ui_layout_libraries FROM PUBLIC, anon, authenticated",
    "GRANT SELECT ON TABLE public.user_ui_layout_libraries TO authenticated",
    "GRANT INSERT (user_id, library) ON TABLE public.user_ui_layout_libraries TO authenticated",
    "GRANT UPDATE (library) ON TABLE public.user_ui_layout_libraries TO authenticated",
    "REVOKE ALL ON FUNCTION public.user_ui_layout_libraries_valid(jsonb) FROM PUBLIC, anon, authenticated",
    "REVOKE ALL ON FUNCTION public.user_ui_layout_libraries_stamp() FROM PUBLIC, anon, authenticated",
    "GRANT EXECUTE ON FUNCTION public.user_ui_layout_libraries_valid(jsonb) TO authenticated",
    "COMMIT",
  ]);
});

test("helpers are invoker-only with fixed catalog paths and no application-table reads or dynamic SQL", () => {
  assert.deepEqual(functions.map((fn) => fn.name), ["user_ui_layout_libraries_valid", "user_ui_layout_libraries_stamp"]);
  const allowedCalls = new Set([
    "public.user_ui_preferences_exact_keys", "public.user_ui_preferences_valid", "pg_catalog.octet_length",
    "pg_catalog.jsonb_typeof", "pg_catalog.jsonb_array_length", "pg_catalog.jsonb_array_elements",
    "pg_catalog.char_length", "pg_catalog.btrim", "pg_catalog.translate", "pg_catalog.array_append", "pg_catalog.clock_timestamp",
  ]);
  for (const fn of functions) {
    assert.equal(fn.attributes, `LANGUAGE plpgsql ${fn.returns === "trigger" ? "VOLATILE" : "IMMUTABLE"} SECURITY INVOKER SET search_path = pg_catalog`);
    const noLiterals = fn.body.replace(/'(?:''|[^'])*'/g, "''");
    assert.doesNotMatch(noLiterals, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|EXECUTE|PERFORM|CALL|set_config|current_setting|dblink)\b/i);
    for (const call of fn.body.matchAll(/\b((?:pg_catalog|public|auth)\.\w+)\s*\(/g)) assert.ok(allowedCalls.has(call[1]), call[1]);
    const noComparisons = noLiterals.replace(/\bIS(?: NOT)? DISTINCT FROM\b/gi, "comparison");
    for (const from of noComparisons.matchAll(/\bFROM\s+([^\s(]+)/gi)) assert.equal(from[1], "pg_catalog.jsonb_array_elements");
  }
  assert.doesNotMatch(source, /\b(?:user_data|privatefiles|auth\.jwt|auth\.role|raw_user_meta_data|service_role)\b/);
  assert.doesNotMatch(source, /(?:CREATE|ALTER|GRANT|REVOKE)[^;]*public\.user_ui_preferences(?:[\s(]|_exact_keys|_valid)/i);
});

test("privileges exclude anonymous access, delete/truncate, metadata writes and trigger RPC execution", () => {
  const grants = [...source.matchAll(/\bGRANT\s+([^;]+);/g)].map((m) => compact(m[1]));
  assert.deepEqual(grants, [
    "SELECT ON TABLE public.user_ui_layout_libraries TO authenticated",
    "INSERT (user_id, library) ON TABLE public.user_ui_layout_libraries TO authenticated",
    "UPDATE (library) ON TABLE public.user_ui_layout_libraries TO authenticated",
    "EXECUTE ON FUNCTION public.user_ui_layout_libraries_valid(jsonb) TO authenticated",
  ]);
  assert.doesNotMatch(grants.join("\n"), /DELETE|TRUNCATE|REFERENCES|TRIGGER|MAINTAIN|ALL|WITH GRANT OPTION|TO (?:PUBLIC|anon)/);
  assert.match(source, /REVOKE ALL ON TABLE public\.user_ui_layout_libraries FROM PUBLIC, anon, authenticated;/);
  for (const fn of functions) assert.ok(source.includes(`REVOKE ALL ON FUNCTION public.${fn.name}(${fn.args ? "jsonb" : ""}) FROM PUBLIC, anon, authenticated;`));
});

test("RLS is enabled and forced with authenticated ownership on both sides of UPDATE", () => {
  assert.match(source, /ALTER TABLE public\.user_ui_layout_libraries ENABLE ROW LEVEL SECURITY;/);
  assert.match(source, /ALTER TABLE public\.user_ui_layout_libraries FORCE ROW LEVEL SECURITY;/);
  const policies = [...source.matchAll(/CREATE POLICY ([^;]+);/g)].map((m) => compact(m[1]));
  const owner = "((SELECT auth.uid()) = user_id)";
  assert.equal(policies.length, 3);
  assert.ok(policies[0].endsWith(`FOR SELECT TO authenticated USING ${owner}`));
  assert.ok(policies[1].endsWith(`FOR INSERT TO authenticated WITH CHECK ${owner}`));
  assert.ok(policies[2].endsWith(`FOR UPDATE TO authenticated USING ${owner} WITH CHECK ${owner}`));
  assert.doesNotMatch(policies.join("\n"), /FOR ALL|FOR DELETE|TO (?:anon|PUBLIC)|true|jwt|user_metadata/);
});

test("stamping is server-owned, immutable-owner, overflow-failing and increments even on repeated writes", () => {
  assert.equal(compact(stamp.body), compact(`
    BEGIN
      IF TG_OP = 'INSERT' THEN NEW.revision := 1;
      ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
          RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'UI layout library owner cannot change';
        END IF;
        IF OLD.revision >= 2147483647 THEN
          RAISE EXCEPTION USING ERRCODE = '22003', MESSAGE = 'UI layout library revision exhausted';
        END IF;
        NEW.revision := OLD.revision + 1;
      ELSE
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Unsupported UI layout library operation';
      END IF;
      NEW.schema_version := 1;
      NEW.updated_at := pg_catalog.clock_timestamp();
      RETURN NEW;
    END;
  `));
  assert.match(source, /library jsonb NOT NULL CHECK \(public\.user_ui_layout_libraries_valid\(library\) IS TRUE\)/);
  assert.match(source, /schema_version integer NOT NULL DEFAULT 1 CHECK \(schema_version = 1\)/);
  assert.match(source, /revision integer NOT NULL DEFAULT 1 CHECK \(revision > 0\)/);
  assert.match(source, /user_id uuid PRIMARY KEY REFERENCES auth\.users\(id\) ON DELETE CASCADE/);
  assert.equal((source.match(/ON DELETE CASCADE/g) ?? []).length, 1);
});

test("strict JSON guards precede unsafe operations and delegate every nested preference snapshot", () => {
  assert.match(valid.body, /user_ui_preferences_exact_keys\(p_library, ARRAY\['version', 'schemes'\]\) IS NOT TRUE/);
  assert.match(valid.body, /p_library -> 'version' IS DISTINCT FROM '1'::jsonb/);
  assert.match(valid.body, /user_ui_preferences_exact_keys\(v_scheme, ARRAY\['id', 'name', 'preferences'\]\) IS NOT TRUE/);
  for (const key of ["id", "name"]) assert.ok(valid.body.includes(`pg_catalog.jsonb_typeof(v_scheme -> '${key}') IS DISTINCT FROM 'string'`));
  assert.ok(valid.body.indexOf("jsonb_typeof(p_library -> 'schemes')") < valid.body.indexOf("jsonb_array_length"));
  assert.ok(valid.body.indexOf("jsonb_typeof(v_scheme -> 'id')") < valid.body.indexOf("v_id :="));
  assert.match(valid.body, /public\.user_ui_preferences_valid\(v_scheme -> 'preferences'\) IS NOT TRUE/);
  assert.match(valid.body, /v_seen_ids := pg_catalog\.array_append\(v_seen_ids, v_id\)/);
  assert.match(valid.body, /v_seen_names := pg_catalog\.array_append\(v_seen_names, v_name_key\)/);
  assert.doesNotMatch(valid.attributes, /STRICT/);
  assert.equal(payloadLimit, 262144);
  assert.equal(countLimit, 10);
  assert.match(valid.body, /pg_catalog\.octet_length\(p_library::text\) > 262144/);
  assert.doesNotMatch(valid.body, /pg_column_size|lower\(|upper\(|casefold|\[:(?:cntrl|space):\]/i);
});

test("UUID validation is exactly lowercase 8-4-4-4-12 without RFC version or variant restrictions", () => {
  assert.equal(idPattern.source, "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
  assert.match(valid.body, /pg_catalog\.char_length\(v_id\) <> 36/);
  assert.match(valid.body, /v_id COLLATE pg_catalog\."C" = ANY\(v_seen_ids\)/);
  for (const id of ["00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"]) assert.ok(idPattern.test(id));
  for (const id of ["FFFFFFFF-ffff-ffff-ffff-ffffffffffff", "00000000000000000000000000000000", "g0000000-0000-0000-0000-000000000000"]) assert.ok(!idPattern.test(id));
});

test("extracted SQL character sets match all runtime Unicode properties (not PostgreSQL execution)", () => {
  const runtimeUnsafe = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
  for (let cp = 0; cp <= 0x10ffff; cp += 1) {
    const character = String.fromCodePoint(cp);
    // PostgreSQL JSONB itself disallows NUL and unpaired surrogate code points.
    const rejectedByJsonb = cp === 0 || (cp >= 0xd800 && cp <= 0xdfff);
    if (unsafePattern.test(character) !== (runtimeUnsafe.test(character) && !rejectedByJsonb)) assert.fail(`unsafe set U+${cp.toString(16)}`);
    if (!runtimeUnsafe.test(character) && trimCharacters.has(character) !== /\s/u.test(character)) assert.fail(`trim set U+${cp.toString(16)}`);
  }
});

test("canonical names are checked before and after parser-special NFKC; equality and dedupe use C", () => {
  const before = valid.body.indexOf('IF v_name COLLATE pg_catalog."C" ~ unsafe_name_pattern');
  const normalization = valid.body.indexOf("pg_catalog.btrim(normalize(v_name, NFKC), trim_name_characters)");
  const after = valid.body.indexOf('v_normalized_name COLLATE pg_catalog."C" ~ unsafe_name_pattern');
  assert.ok(before >= 0 && before < normalization && normalization < after);
  assert.match(valid.body, /v_name COLLATE pg_catalog\."C" IS DISTINCT FROM v_normalized_name COLLATE pg_catalog\."C"/);
  assert.match(valid.body, /pg_catalog\.char_length\(v_normalized_name\) NOT BETWEEN 1 AND 30/);
  assert.match(valid.body, /pg_catalog\.translate\(v_name, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'\)/);
  assert.match(valid.body, /v_name_key COLLATE pg_catalog\."C" = ANY\(v_seen_names\)/);
  assert.doesNotMatch(valid.body, /pg_catalog\.normalize\(/);
});

// This oracle interprets extracted constants using JS; it is NOT a SQL interpreter
// and cannot prove PostgreSQL's regex/NFKC implementation or its Unicode version.
function sqlNameOracle(name) {
  if (typeof name !== "string" || /[\u0000\uD800-\uDFFF]/u.test(name) || unsafePattern.test(name)) return null;
  const points = Array.from(name.normalize("NFKC"));
  while (trimCharacters.has(points[0])) points.shift();
  while (trimCharacters.has(points.at(-1))) points.pop();
  const canonical = points.join("");
  return points.length >= 1 && points.length <= 30 && !unsafePattern.test(canonical) ? canonical : null;
}
const exact = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const scheme = (name = "Focus", index = 1) => ({
  id: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`, name, preferences: preferences.createDisplayPreferences(),
});
const library = (count = 1) => ({ version: 1, schemes: Array.from({ length: count }, (_, i) => scheme(`Layout ${i + 1}`, i + 1)) });
function libraryOracle(value) {
  if (!exact(value, ["version", "schemes"]) || value.version !== 1 || !Array.isArray(value.schemes) || value.schemes.length > countLimit) return false;
  const ids = new Set(), names = new Set();
  for (const item of value.schemes) {
    if (!exact(item, ["id", "name", "preferences"]) || typeof item.id !== "string" || item.id.length !== 36 || !idPattern.test(item.id)) return false;
    const name = sqlNameOracle(item.name);
    if (name === null || name !== item.name || !preferences.parseDisplayPreferences(item.preferences)) return false;
    const key = name.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
    if (ids.has(item.id) || names.has(key)) return false;
    ids.add(item.id); names.add(key);
  }
  return true;
}

function contractSamples() {
  const samples = [];
  const add = (value, expected) => samples.push({ value, expected });
  const mutate = (fn) => { const value = library(); fn(value); add(value, false); };
  for (const count of [0, 1, 10]) add(library(count), true);
  add(library(11), false);
  for (const value of [null, [], true, 1, "{}", {}, { version: 1 }, { schemes: [] }]) add(value, false);
  for (const version of [0, 2, "1", null, true]) mutate((v) => { v.version = version; });
  for (const schemes of [null, {}, 1, "[]", [null], [[]], [1]]) mutate((v) => { v.schemes = schemes; });
  for (const name of ["Focus", "日常", "😀".repeat(30), "A".repeat(30), "é", "İ", "ı", "Ä", "A B"]) add({ version: 1, schemes: [scheme(name)] }, true);
  for (const name of ["", " ", " A", "A ", "A".repeat(31), "😀".repeat(31), "Ａ", "e\u0301", "\u00A0A", "A\u1680", "A\u202F", null, 1]) mutate((v) => { v.schemes[0].name = name; });
  for (const cp of [0, 9, 10, 0x7f, 0x85, 0xad, 0x61c, 0x200b, 0x2028, 0x2029, 0x202e, 0x2066, 0xfeff, 0xd800, 0xdc00, 0x110bd, 0x1343f, 0xe0001, 0xe007f]) mutate((v) => { v.schemes[0].name = `A${String.fromCodePoint(cp)}B`; });
  for (const id of [null, 1, "", "A0000000-0000-0000-0000-000000000000", "00000000-0000-0000-0000-000000000001\n"]) mutate((v) => { v.schemes[0].id = id; });
  for (const id of ["00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"]) { const v = library(); v.schemes[0].id = id; add(v, true); }
  for (const pair of [["Focus", "focus"], ["I", "i"], ["FOCUS", "Focus"]]) add({ version: 1, schemes: pair.map((name, i) => scheme(name, i + 1)) }, false);
  for (const pair of [["Ä", "ä"], ["İ", "i"], ["I", "ı"], ["é", "e"], ["Σ", "σ"], ["A\u1680B", "A B"]])
    add({ version: 1, schemes: pair.map((name, i) => scheme(name, i + 1)) }, true);
  { const v = library(2); v.schemes[1].id = v.schemes[0].id; add(v, false); }
  for (const target of [(v) => v, (v) => v.schemes[0]]) {
    for (const key of ["css", "style", "user_id", "balance", "transactions", "email", "access_token", "__proto__"]) mutate((v) => { Object.defineProperty(target(v), key, { value: "synthetic forbidden field", enumerable: true }); });
    for (const key of Object.keys(target(library()))) mutate((v) => { delete target(v)[key]; });
  }
  for (const snapshot of [null, {}, [], true]) mutate((v) => { v.schemes[0].preferences = snapshot; });
  const nestedTargets = [
    (p) => p, (p) => p.sidebar, (p) => p.devices,
    ...["desktop", "tablet", "mobile"].flatMap((device) => [(p) => p.devices[device], (p) => p.devices[device].items[0]]),
  ];
  for (const target of nestedTargets) {
    mutate((v) => { target(v.schemes[0].preferences).balance = "synthetic forbidden field"; });
    for (const key of Object.keys(target(preferences.createDisplayPreferences()))) {
      mutate((v) => { delete target(v.schemes[0].preferences)[key]; });
      mutate((v) => { target(v.schemes[0].preferences)[key] = null; });
    }
  }
  for (const device of ["desktop", "tablet", "mobile"]) {
    for (const gap of ["24", 11, 33, 24.5]) mutate((v) => { v.schemes[0].preferences.devices[device].gap = gap; });
    mutate((v) => { v.schemes[0].preferences.devices[device].items[1].id = "free"; });
  }
  for (const hidden of [["home"], ["settings"], ["accounts", "accounts"], ["unknown"]]) mutate((v) => { v.schemes[0].preferences.sidebar.hidden = hidden; });
  return samples;
}

test("synthetic adversarial contract samples agree with the actual client parser (not SQL execution)", () => {
  for (const { value, expected } of contractSamples()) {
    assert.equal(libraryOracle(value), expected);
    assert.equal(client.parseNamedLayoutLibrary(value) !== null, expected);
  }
});

test("synthetic trim/normalization boundaries agree with client helpers; noncanonical storage fails", () => {
  for (const c of trimCharacters) {
    for (const name of [`${c}Focus`, `Focus${c}`, `${c}Focus${c}`]) {
      assert.equal(sqlNameOracle(name), client.normalizeLayoutName(name));
      assert.equal(client.parseNamedLayoutLibrary({ version: 1, schemes: [scheme(name)] }), null);
    }
  }
  for (const cp of [9, 10, 13, 0x2028, 0x2029, 0xfeff]) {
    const name = `${String.fromCodePoint(cp)}Focus`;
    assert.equal(sqlNameOracle(name), null);
    assert.equal(client.normalizeLayoutName(name), null);
  }
  assert.equal(sqlNameOracle("😀".repeat(30)), "😀".repeat(30), "code points, not UTF16 units");
  assert.equal(sqlNameOracle("Ａ"), "A");
  assert.equal(sqlNameOracle("e\u0301"), "é");
});

test("payload guard counts stored text bytes; maximal synthetic v1 snapshots leave envelope headroom", () => {
  const value = library(10);
  for (const [index, item] of value.schemes.entries()) {
    item.name = "😀".repeat(29) + String.fromCharCode(65 + index);
    item.preferences.sidebar.hidden = preferences.SIDEBAR_ITEMS.filter((item) => !item.locked).map((item) => item.id);
    for (const layout of Object.values(item.preferences.devices)) {
      Object.assign(layout, { enabled: false, gap: 32, groupMotion: "stagger" });
      for (const module of layout.items) Object.assign(module, { width: 12, height: 400, padding: 32, title: 28, amount: 64, body: 18, duration: 600, titleWeight: 700, amountWeight: 700, bodyWeight: 700, motion: "spring", visible: false, detailsExpanded: false });
    }
  }
  // JSONB's comma/colon spacing for THESE string/integer-only synthetic values.
  // Key ordering does not change byte length. Not a general JSONB serializer.
  const jsonbText = (v) => Array.isArray(v) ? `[${v.map(jsonbText).join(", ")}]`
    : v !== null && typeof v === "object" ? `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${jsonbText(x)}`).join(", ")}}`
      : JSON.stringify(v);
  assert.ok(Buffer.byteLength(jsonbText(value), "utf8") < payloadLimit / 2);
  const envelope = { version: 1, library: value, base: { revision: 2147483647, library: structuredClone(value) } };
  assert.ok(Buffer.byteLength(JSON.stringify(envelope), "utf8") <= payloadLimit);
  assert.ok(Buffer.byteLength(JSON.stringify(value), "utf8") > JSON.stringify(value).length);
  assert.ok(libraryOracle(value));
  assert.ok(client.parseNamedLayoutLibrary(value));
  assert.equal(Buffer.byteLength("😀".repeat(65536), "utf8"), payloadLimit);
});

test("optional local PGlite: actual synthetic validator, stamp failures/recovery and stale CAS", async (t) => {
  let modulePath;
  try { modulePath = require.resolve("@electric-sql/pglite"); }
  catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; t.skip("PGlite is not installed locally; no download and no live database fallback"); return; }
  const { PGlite } = await import(pathToFileURL(modulePath).href);
  const db = new PGlite();
  try {
    const existing = extractFunctions(readFileSync(new URL("../supabase/display-preferences.sql", import.meta.url), "utf8"));
    for (const name of ["user_ui_preferences_exact_keys", "user_ui_preferences_bounded_integer", "user_ui_preferences_valid"]) {
      const fn = existing.find((entry) => entry.name === name); assert.ok(fn, name); await db.exec(fn.sql);
    }
    await db.exec(valid.sql);
    await db.exec(stamp.sql);
    for (const { value, expected } of contractSamples()) {
      // JSONB rejects these before any validator can run, rather than returning false.
      if (/\\u0000|\\u[dD][89a-fA-F][\da-fA-F]{2}/.test(JSON.stringify(value))) {
        await assert.rejects(db.query("SELECT public.user_ui_layout_libraries_valid($1::jsonb)", [JSON.stringify(value)]));
      } else {
        const result = await db.query("SELECT public.user_ui_layout_libraries_valid($1::jsonb) AS valid", [JSON.stringify(value)]);
        assert.equal(result.rows[0].valid, expected);
      }
    }
    assert.equal((await db.query("SELECT public.user_ui_layout_libraries_valid(NULL::jsonb) AS valid")).rows[0].valid, false);
    const oversized = library(); oversized.schemes[0].name = "😀".repeat(65536);
    assert.equal((await db.query("SELECT public.user_ui_layout_libraries_valid($1::jsonb) AS valid", [JSON.stringify(oversized)])).rows[0].valid, false);
    const table = source.match(/CREATE TABLE public\.user_ui_layout_libraries \([\s\S]*?\n\);/)[0]
      .replace("CREATE TABLE public.user_ui_layout_libraries", "CREATE TEMP TABLE synthetic_ui_libraries")
      .replace(" REFERENCES auth.users(id) ON DELETE CASCADE", "");
    await db.exec(table);
    await db.exec("CREATE TRIGGER synthetic_stamp BEFORE INSERT OR UPDATE ON synthetic_ui_libraries FOR EACH ROW EXECUTE FUNCTION public.user_ui_layout_libraries_stamp();");
    const owner = "00000000-0000-0000-0000-000000000001", other = "00000000-0000-0000-0000-000000000002";
    const payload = JSON.stringify(library());
    const inserted = await db.query("INSERT INTO synthetic_ui_libraries (user_id, library, revision, schema_version, updated_at) VALUES ($1, $2::jsonb, 999, 999, '2000-01-01') RETURNING revision, schema_version, updated_at", [owner, payload]);
    assert.equal(inserted.rows[0].revision, 1); assert.equal(inserted.rows[0].schema_version, 1);
    assert.notEqual(new Date(inserted.rows[0].updated_at).getUTCFullYear(), 2000);
    await assert.rejects(db.query("INSERT INTO synthetic_ui_libraries (user_id, library) VALUES ($1, $2::jsonb)", [owner, payload]), { code: "23505" });
    await assert.rejects(db.query("UPDATE synthetic_ui_libraries SET user_id = $1 WHERE user_id = $2", [other, owner]), { code: "23514" });
    await assert.rejects(db.query("UPDATE synthetic_ui_libraries SET library = '{}'::jsonb WHERE user_id = $1", [owner]), { code: "23514" });
    assert.equal((await db.query("UPDATE synthetic_ui_libraries SET library = $1::jsonb WHERE user_id = $2 AND revision = 1 RETURNING revision", [payload, owner])).rows[0].revision, 2);
    assert.equal((await db.query("UPDATE synthetic_ui_libraries SET library = $1::jsonb WHERE user_id = $2 AND revision = 1 RETURNING revision", [payload, owner])).rows.length, 0);
    assert.equal((await db.query("UPDATE synthetic_ui_libraries SET library = $1::jsonb WHERE user_id = $2 AND revision = 2 RETURNING revision", [payload, owner])).rows[0].revision, 3);
    await db.exec("ALTER TABLE synthetic_ui_libraries DISABLE TRIGGER synthetic_stamp; UPDATE synthetic_ui_libraries SET revision = 2147483647; ALTER TABLE synthetic_ui_libraries ENABLE TRIGGER synthetic_stamp;");
    await assert.rejects(db.query("UPDATE synthetic_ui_libraries SET library = $1::jsonb WHERE user_id = $2", [payload, owner]), { code: "22003" });
    assert.equal((await db.query("SELECT revision FROM synthetic_ui_libraries")).rows[0].revision, 2147483647);
    await assert.rejects(db.exec(valid.sql), { code: "42723" });
  } finally { await db.close(); }
});
