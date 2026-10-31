// Source/contract tests only. Never connects to a database or executes SQL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  HOME_MODULES, SIDEBAR_ITEMS, createDisplayPreferences, parseDisplayPreferences,
} from "../lib/display-preferences.ts";

const sql = readFileSync(new URL("../supabase/display-preferences.sql", import.meta.url), "utf8");
const source = sql.replace(/--[^\r\n]*/g, "");
const normalize = (value) => value.replace(/\s+/g, " ").trim();
const functions = [...source.matchAll(/CREATE FUNCTION public\.(\w+)\(([^)]*)\)\s+RETURNS\s+(boolean|trigger)([\s\S]*?)AS \$function\$([\s\S]*?)\$function\$;/g)]
  .map((match) => ({ name: match[1], args: normalize(match[2]), returns: match[3], attributes: normalize(match[4]), body: match[5] }));
const byName = new Map(functions.map((fn) => [fn.name, fn]));
const validBody = byName.get("user_ui_preferences_valid")?.body ?? "";
const strings = (fragment) => [...fragment.matchAll(/'((?:''|[^'])*)'/g)].map((match) => match[1].replaceAll("''", "'"));
const clone = (value) => structuredClone(value);

function textArray(name) {
  const match = validBody.match(new RegExp(`\\b${name} CONSTANT text\\[\\] := ARRAY\\[([\\s\\S]*?)\\];`));
  assert.ok(match, `SQL text[] constant ${name}`);
  return strings(match[1]);
}
function integerArray(name) {
  const match = validBody.match(new RegExp(`\\b${name} CONSTANT integer\\[\\] := ARRAY\\[([\\s\\S]*?)\\];`));
  assert.ok(match, `SQL integer[] constant ${name}`);
  assert.match(match[1], /^[\d,\s]+$/);
  return match[1].split(",").map(Number);
}
const exactKeyRules = new Map([...validBody.matchAll(/public\.user_ui_preferences_exact_keys\(([^,\n]+), ARRAY\[([\s\S]*?)\]\)/g)]
  .map((match) => [normalize(match[1]), strings(match[2])]));
const numericRows = validBody.match(/FOR v_rule IN SELECT \* FROM \(VALUES([\s\S]*?)\) AS numeric_rules\(field, lower_bound, upper_bound\)/)?.[1] ?? "";
const numericBounds = new Map([...numericRows.matchAll(/\('([^']+)',\s*(\d+),\s*(\d+)\)/g)]
  .map((match) => [match[1], [Number(match[2]), Number(match[3])]]));
const contract = {
  devices: textArray("device_ids"), modules: textArray("module_ids"), sidebar: textArray("sidebar_ids"),
  locked: textArray("locked_sidebar_ids"), motions: textArray("motion_presets"), groups: textArray("group_motions"),
  widths: integerArray("width_choices"), weights: integerArray("weight_choices"),
  weightFields: textArray("weight_fields"), booleanFields: textArray("boolean_fields"),
};

test("candidate has a collision-failing transaction and only the specified new objects/statements", () => {
  assert.match(sql, /REVIEW CANDIDATE ONLY/);
  assert.doesNotMatch(source, /\bIF NOT EXISTS\b|\bOR REPLACE\b|\bDROP\b|\bTRUNCATE\b|\bCREATE (?:EXTENSION|SCHEMA|ROLE|VIEW|PROCEDURE)\b|\bALTER (?:DEFAULT|FUNCTION|ROLE|SCHEMA|DATABASE)\b/i);
  const outsideBodies = source.replace(/\$function\$[\s\S]*?\$function\$/g, "$body$");
  const statements = outsideBodies.split(";").map(normalize).filter(Boolean);
  const declaration = (name, args, returns, volatility) => `CREATE FUNCTION public.${name}(${args}) RETURNS ${returns} LANGUAGE plpgsql ${volatility} SECURITY INVOKER SET search_path = pg_catalog AS $body$`;
  assert.deepEqual(statements, [
    "BEGIN",
    declaration("user_ui_preferences_exact_keys", "p_value jsonb, p_keys text[]", "boolean", "IMMUTABLE"),
    declaration("user_ui_preferences_bounded_integer", "p_value jsonb, p_min integer, p_max integer", "boolean", "IMMUTABLE"),
    declaration("user_ui_preferences_valid", "p_preferences jsonb", "boolean", "IMMUTABLE"),
    "CREATE TABLE public.user_ui_preferences ( user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE, schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1), revision integer NOT NULL DEFAULT 1 CHECK (revision > 0), preferences jsonb NOT NULL CHECK (public.user_ui_preferences_valid(preferences) IS TRUE), updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp() )",
    declaration("user_ui_preferences_stamp", "", "trigger", "VOLATILE"),
    "CREATE TRIGGER user_ui_preferences_stamp_before_write BEFORE INSERT OR UPDATE ON public.user_ui_preferences FOR EACH ROW EXECUTE FUNCTION public.user_ui_preferences_stamp()",
    "ALTER TABLE public.user_ui_preferences ENABLE ROW LEVEL SECURITY",
    "ALTER TABLE public.user_ui_preferences FORCE ROW LEVEL SECURITY",
    "CREATE POLICY user_ui_preferences_select_own ON public.user_ui_preferences FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id)",
    "CREATE POLICY user_ui_preferences_insert_own ON public.user_ui_preferences FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id)",
    "CREATE POLICY user_ui_preferences_update_own ON public.user_ui_preferences FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id)",
    "REVOKE ALL ON TABLE public.user_ui_preferences FROM PUBLIC, anon, authenticated",
    "GRANT SELECT ON TABLE public.user_ui_preferences TO authenticated",
    "GRANT INSERT (user_id, preferences) ON TABLE public.user_ui_preferences TO authenticated",
    "GRANT UPDATE (preferences) ON TABLE public.user_ui_preferences TO authenticated",
    "REVOKE ALL ON FUNCTION public.user_ui_preferences_exact_keys(jsonb, text[]) FROM PUBLIC, anon, authenticated",
    "REVOKE ALL ON FUNCTION public.user_ui_preferences_bounded_integer(jsonb, integer, integer) FROM PUBLIC, anon, authenticated",
    "REVOKE ALL ON FUNCTION public.user_ui_preferences_valid(jsonb) FROM PUBLIC, anon, authenticated",
    "REVOKE ALL ON FUNCTION public.user_ui_preferences_stamp() FROM PUBLIC, anon, authenticated",
    "GRANT EXECUTE ON FUNCTION public.user_ui_preferences_exact_keys(jsonb, text[]) TO authenticated",
    "GRANT EXECUTE ON FUNCTION public.user_ui_preferences_bounded_integer(jsonb, integer, integer) TO authenticated",
    "GRANT EXECUTE ON FUNCTION public.user_ui_preferences_valid(jsonb) TO authenticated",
    "COMMIT",
  ]);
});

test("every helper is invoker-only with a fixed catalog path and no table access or dynamic SQL", () => {
  assert.deepEqual(functions.map((fn) => fn.name), ["user_ui_preferences_exact_keys", "user_ui_preferences_bounded_integer", "user_ui_preferences_valid", "user_ui_preferences_stamp"]);
  assert.doesNotMatch(source, /SECURITY DEFINER|SET search_path = (?:public|''|"\$user")|LEAKPROOF|\bEXECUTE\s+(?:format|')/i);
  const allowedCalls = new Set([
    "pg_catalog.jsonb_typeof", "pg_catalog.count", "pg_catalog.jsonb_object_keys", "pg_catalog.cardinality",
    "pg_catalog.trunc", "pg_catalog.jsonb_array_length", "pg_catalog.jsonb_array_elements", "pg_catalog.array_append",
    "pg_catalog.clock_timestamp", "public.user_ui_preferences_exact_keys", "public.user_ui_preferences_bounded_integer",
  ]);
  for (const fn of functions) {
    assert.equal(fn.attributes, `LANGUAGE plpgsql ${fn.returns === "trigger" ? "VOLATILE" : "IMMUTABLE"} SECURITY INVOKER SET search_path = pg_catalog`);
    const withoutLiterals = fn.body.replace(/'(?:''|[^'])*'/g, "''");
    assert.doesNotMatch(withoutLiterals, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|EXECUTE|PERFORM|CALL|set_config|current_setting|dblink)\b/i);
    for (const call of fn.body.matchAll(/\b((?:pg_catalog|public|auth)\.\w+)\s*\(/g)) assert.ok(allowedCalls.has(call[1]), call[1]);
    // IS DISTINCT FROM is a comparison, not a table read.
    const withoutComparisons = withoutLiterals.replace(/\bIS(?: NOT)? DISTINCT FROM\b/gi, "comparison");
    for (const from of withoutComparisons.matchAll(/\bFROM\s+([^\s(]+)/gi)) {
      assert.ok(["pg_catalog.jsonb_object_keys", "pg_catalog.jsonb_array_elements"].includes(from[1]), from[1]);
    }
  }
});

test("grants are authenticated SELECT plus exact writable columns, never owner/revision/time updates", () => {
  const grants = [...source.matchAll(/\bGRANT\s+([^;]+);/g)].map((match) => normalize(match[1]));
  assert.equal(grants.length, 6);
  assert.ok(grants.every((grant) => grant.endsWith(" TO authenticated")));
  assert.ok(grants.includes("INSERT (user_id, preferences) ON TABLE public.user_ui_preferences TO authenticated"));
  assert.ok(grants.includes("UPDATE (preferences) ON TABLE public.user_ui_preferences TO authenticated"));
  assert.doesNotMatch(grants.join("\n"), /DELETE|TRUNCATE|REFERENCES|TRIGGER|MAINTAIN|ALL|WITH GRANT OPTION|service_role/);
  assert.doesNotMatch(source, /GRANT EXECUTE ON FUNCTION public\.user_ui_preferences_stamp/);
  assert.match(source, /REVOKE ALL ON FUNCTION public\.user_ui_preferences_stamp\(\) FROM PUBLIC, anon, authenticated;/);
});

test("RLS is forced and each authenticated policy checks the correct old/new owner sides", () => {
  const policies = [...source.matchAll(/CREATE POLICY ([^;]+);/g)].map((match) => normalize(match[1]));
  assert.equal(policies.length, 3);
  const owner = "((SELECT auth.uid()) = user_id)";
  assert.ok(policies[0].endsWith(`FOR SELECT TO authenticated USING ${owner}`));
  assert.ok(policies[1].endsWith(`FOR INSERT TO authenticated WITH CHECK ${owner}`));
  assert.ok(policies[2].endsWith(`FOR UPDATE TO authenticated USING ${owner} WITH CHECK ${owner}`));
  assert.doesNotMatch(policies.join("\n"), /FOR ALL|FOR DELETE|TO (?:anon|PUBLIC)|auth\.jwt|user_metadata|auth\.role/);
  assert.match(source, /ALTER TABLE public\.user_ui_preferences ENABLE ROW LEVEL SECURITY;/);
  assert.match(source, /ALTER TABLE public\.user_ui_preferences FORCE ROW LEVEL SECURITY;/);
});

test("server trigger exclusively stamps metadata, rejects owner changes and fails closed at integer exhaustion", () => {
  const body = normalize(byName.get("user_ui_preferences_stamp").body);
  assert.equal(body, normalize(`BEGIN
    IF TG_OP = 'INSERT' THEN NEW.revision := 1;
    ELSIF TG_OP = 'UPDATE' THEN
      IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'UI preferences owner cannot change';
      END IF;
      IF OLD.revision >= 2147483647 THEN
        RAISE EXCEPTION USING ERRCODE = '22003', MESSAGE = 'UI preferences revision exhausted';
      END IF;
      NEW.revision := OLD.revision + 1;
    ELSE RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Unsupported UI preferences operation';
    END IF;
    NEW.schema_version := 1; NEW.updated_at := pg_catalog.clock_timestamp(); RETURN NEW; END;`));
  assert.doesNotMatch(body, /NEW\.preferences\s*:=|NEW\.user_id\s*:=|RAISE.*%/);
});

test("JSON helper definitions guard null/type before casts or set-returning functions", () => {
  assert.equal(normalize(byName.get("user_ui_preferences_exact_keys").body), normalize(`BEGIN
    IF pg_catalog.jsonb_typeof(p_value) IS DISTINCT FROM 'object' OR p_keys IS NULL THEN RETURN false; END IF;
    RETURN p_value ?& p_keys AND (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_value)) = pg_catalog.cardinality(p_keys);
    END;`));
  assert.equal(normalize(byName.get("user_ui_preferences_bounded_integer").body), normalize(`DECLARE v_number numeric;
    BEGIN IF pg_catalog.jsonb_typeof(p_value) IS DISTINCT FROM 'number' OR p_min IS NULL OR p_max IS NULL OR p_min > p_max THEN RETURN false; END IF;
    v_number := (p_value #>> '{}')::numeric;
    RETURN v_number BETWEEN p_min AND p_max AND pg_catalog.trunc(v_number) = v_number; END;`));
  assert.doesNotMatch(functions.map((fn) => fn.attributes).join("\n"), /STRICT|RETURNS NULL ON NULL INPUT/);
  assert.match(source, /preferences jsonb NOT NULL CHECK \(public\.user_ui_preferences_valid\(preferences\) IS TRUE\)/);
});

test("SQL exact keys, enums and IDs match the TypeScript display-only schema", () => {
  assert.deepEqual(contract.devices, ["desktop", "tablet", "mobile"]);
  assert.deepEqual(contract.modules, HOME_MODULES.map((item) => item.id));
  assert.equal(new Set(contract.modules).size, 13);
  assert.deepEqual(contract.sidebar, SIDEBAR_ITEMS.map((item) => item.id));
  assert.equal(new Set(contract.sidebar).size, 20);
  assert.deepEqual(contract.locked, SIDEBAR_ITEMS.filter((item) => item.locked).map((item) => item.id));
  assert.deepEqual(contract.motions, ["none", "fade", "up", "down", "left", "right", "spring", "zoom", "reveal"]);
  assert.deepEqual(contract.groups, ["none", "stagger"]);
  assert.deepEqual(contract.widths, [4, 6, 8, 12]);
  assert.deepEqual(contract.weights, [400, 600, 700]);
  assert.deepEqual(contract.weightFields, ["titleWeight", "amountWeight", "bodyWeight"]);
  assert.deepEqual(contract.booleanFields, ["visible", "detailsExpanded"]);
  assert.deepEqual([...exactKeyRules], [
    ["p_preferences", ["version", "sidebar", "devices"]],
    ["p_preferences -> 'sidebar'", ["hidden"]],
    ["p_preferences -> 'devices'", contract.devices],
    ["v_layout", ["enabled", "gap", "groupMotion", "items"]],
    ["v_item", Object.keys(createDisplayPreferences().devices.desktop.items[0])],
  ]);
  assert.deepEqual([...numericBounds], [["width", [4, 12]], ["height", [144, 400]], ["padding", [14, 32]], ["title", [13, 28]], ["amount", [20, 64]], ["body", [13, 18]], ["duration", [120, 600]]]);
});

test("SQL validation source applies every type/range/uniqueness gate to every device and item", () => {
  const body = normalize(validBody);
  for (const guard of [
    "IF NOT public.user_ui_preferences_bounded_integer(p_preferences -> 'version', 1, 1) THEN RETURN false; END IF;",
    "IF pg_catalog.jsonb_typeof(v_hidden) IS DISTINCT FROM 'array' THEN RETURN false; END IF;",
    "IF pg_catalog.jsonb_array_length(v_hidden) > pg_catalog.cardinality(sidebar_ids) - pg_catalog.cardinality(locked_sidebar_ids) THEN RETURN false; END IF;",
    "IF pg_catalog.jsonb_typeof(v_entry) IS DISTINCT FROM 'string' THEN RETURN false; END IF;",
    "IF NOT (v_id = ANY(sidebar_ids)) OR v_id = ANY(locked_sidebar_ids) OR v_id = ANY(v_seen) THEN RETURN false; END IF;",
    "FOREACH v_device IN ARRAY device_ids LOOP",
    "IF pg_catalog.jsonb_typeof(v_layout -> 'enabled') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;",
    "IF NOT public.user_ui_preferences_bounded_integer(v_layout -> 'gap', 12, 32) THEN RETURN false; END IF;",
    "IF pg_catalog.jsonb_typeof(v_layout -> 'groupMotion') IS DISTINCT FROM 'string' OR NOT (v_layout ->> 'groupMotion' = ANY(group_motions)) THEN RETURN false; END IF;",
    "IF pg_catalog.jsonb_typeof(v_layout -> 'items') IS DISTINCT FROM 'array' THEN RETURN false; END IF;",
    "IF pg_catalog.jsonb_array_length(v_layout -> 'items') <> pg_catalog.cardinality(module_ids) THEN RETURN false; END IF;",
    "FOR v_item IN SELECT value FROM pg_catalog.jsonb_array_elements(v_layout -> 'items') LOOP",
    "IF pg_catalog.jsonb_typeof(v_item -> 'id') IS DISTINCT FROM 'string' THEN RETURN false; END IF;",
    "IF NOT (v_id = ANY(module_ids)) OR v_id = ANY(v_seen) THEN RETURN false; END IF;",
    "IF NOT public.user_ui_preferences_bounded_integer(v_item -> v_rule.field, v_rule.lower_bound, v_rule.upper_bound) THEN RETURN false; END IF;",
    "IF NOT ((v_item ->> 'width')::numeric = ANY(width_choices)) THEN RETURN false; END IF;",
    "FOREACH v_field IN ARRAY weight_fields LOOP IF NOT public.user_ui_preferences_bounded_integer(v_item -> v_field, 400, 700) THEN RETURN false; END IF; IF NOT ((v_item ->> v_field)::numeric = ANY(weight_choices)) THEN RETURN false; END IF; END LOOP;",
    "FOREACH v_field IN ARRAY boolean_fields LOOP IF pg_catalog.jsonb_typeof(v_item -> v_field) IS DISTINCT FROM 'boolean' THEN RETURN false; END IF; END LOOP;",
    "IF pg_catalog.jsonb_typeof(v_item -> 'motion') IS DISTINCT FROM 'string' OR NOT (v_item ->> 'motion' = ANY(motion_presets)) THEN RETURN false; END IF;",
  ]) assert.ok(body.includes(guard), guard);
  assert.equal((body.match(/v_seen := ARRAY\[\]::text\[\];/g) ?? []).length, 2);
  assert.equal((body.match(/v_seen := pg_catalog\.array_append\(v_seen, v_id\);/g) ?? []).length, 2);
  assert.equal((body.match(/RETURN true;/g) ?? []).length, 1);
  assert.ok(body.endsWith("END LOOP; END LOOP; RETURN true; END;"));
});

// A JS model built from SQL-declared keys/enums/ranges checks synthetic samples
// against the TS parser. This is deliberately NOT proof of SQL runtime behavior.
function sqlContractAccepts(prefs) {
  const exact = (value, keyRule) => value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === exactKeyRules.get(keyRule).length
    && exactKeyRules.get(keyRule).every((key) => Object.hasOwn(value, key));
  const bounded = (value, min, max) => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
  if (!exact(prefs, "p_preferences") || !bounded(prefs.version, 1, 1)
    || !exact(prefs.sidebar, "p_preferences -> 'sidebar'") || !exact(prefs.devices, "p_preferences -> 'devices'")) return false;
  const hidden = prefs.sidebar.hidden;
  if (!Array.isArray(hidden) || hidden.length > contract.sidebar.length - contract.locked.length
    || new Set(hidden).size !== hidden.length
    || hidden.some((id) => typeof id !== "string" || !contract.sidebar.includes(id) || contract.locked.includes(id))) return false;
  return contract.devices.every((device) => {
    const layout = prefs.devices[device];
    if (!exact(layout, "v_layout") || typeof layout.enabled !== "boolean" || !bounded(layout.gap, 12, 32)
      || !contract.groups.includes(layout.groupMotion) || !Array.isArray(layout.items)
      || layout.items.length !== contract.modules.length) return false;
    const seen = new Set();
    return layout.items.every((item) => {
      if (!exact(item, "v_item") || typeof item.id !== "string" || !contract.modules.includes(item.id) || seen.has(item.id)) return false;
      seen.add(item.id);
      return [...numericBounds].every(([field, [min, max]]) => bounded(item[field], min, max))
        && contract.widths.includes(item.width)
        && contract.weightFields.every((field) => bounded(item[field], 400, 700) && contract.weights.includes(item[field]))
        && contract.booleanFields.every((field) => typeof item[field] === "boolean")
        && contract.motions.includes(item.motion);
    });
  });
}
function agreement(prefs, expected) {
  assert.equal(sqlContractAccepts(prefs), expected, "SQL source contract model");
  assert.equal(parseDisplayPreferences(prefs) !== null, expected, "TS display parser");
}

test("pure contract samples: defaults, all optional sidebar IDs, ordering, toggles and all enums", () => {
  agreement(createDisplayPreferences(), true);
  const prefs = createDisplayPreferences();
  prefs.sidebar.hidden = contract.sidebar.filter((id) => !contract.locked.includes(id)).reverse();
  contract.devices.forEach((device, deviceIndex) => {
    const layout = prefs.devices[device];
    layout.enabled = deviceIndex % 2 === 0;
    layout.groupMotion = contract.groups[deviceIndex % 2];
    layout.items.reverse();
    layout.items.forEach((item, index) => {
      item.width = contract.widths[index % contract.widths.length];
      item.motion = contract.motions[index % contract.motions.length];
      item.visible = index % 2 === 0;
      item.detailsExpanded = !item.visible;
      contract.weightFields.forEach((field, weightIndex) => { item[field] = contract.weights[(index + weightIndex) % 3]; });
    });
  });
  const before = clone(prefs);
  agreement(prefs, true);
  assert.deepEqual(prefs, before);
  for (const device of contract.devices) prefs.devices[device].items.forEach((item) => { item.visible = false; });
  agreement(prefs, true);
});

for (const device of contract.devices) {
  test(`pure contract samples: ${device} numeric bounds, integer types, enum and boolean rejection`, () => {
    for (const [field, [min, max]] of [...numericBounds, ["gap", [12, 32]]]) {
      for (const value of [min, max, min - 1, max + 1, min + 0.5, String(min), true, null, {}, []]) {
        const prefs = createDisplayPreferences();
        const target = field === "gap" ? prefs.devices[device] : prefs.devices[device].items[0];
        target[field] = value;
        agreement(prefs, value === min || value === max);
      }
    }
    for (const [field, allowed] of [["width", contract.widths], ["motion", contract.motions], ...contract.weightFields.map((field) => [field, contract.weights]), ...contract.booleanFields.map((field) => [field, [false, true]]), ["enabled", [false, true]], ["groupMotion", contract.groups]]) {
      for (const value of [...allowed, null, "null", "true", "false", 0, 1, 5, 500, "400", "slide", "scale", "fade;color:red", {}]) {
        const prefs = createDisplayPreferences();
        const target = ["enabled", "groupMotion"].includes(field) ? prefs.devices[device] : prefs.devices[device].items[0];
        target[field] = value;
        agreement(prefs, allowed.includes(value));
      }
    }
  });
  test(`pure contract samples: ${device} rejects incomplete/duplicate/unknown modules and nested nulls`, () => {
    for (const mutate of [
      (layout) => { layout.items.pop(); }, (layout) => { layout.items.push(clone(layout.items[0])); },
      (layout) => { layout.items[1].id = layout.items[0].id; }, (layout) => { layout.items[0].id = "unknown"; },
      (layout) => { layout.items[0].id = null; }, (layout) => { layout.items[0] = null; },
      (layout) => { layout.items = null; }, (layout) => { layout.items = {}; },
    ]) {
      const prefs = createDisplayPreferences(); mutate(prefs.devices[device]); agreement(prefs, false);
    }
    for (let index = 0; index < contract.modules.length; index += 1) {
      for (const field of exactKeyRules.get("v_item")) {
        const prefs = createDisplayPreferences(); delete prefs.devices[device].items[index][field]; agreement(prefs, false);
      }
    }
  });
}

test("pure contract samples: reject private/CSS/financial extras at every object level, missing keys and nested nulls", () => {
  const targets = [
    [(prefs) => prefs, "p_preferences"], [(prefs) => prefs.sidebar, "p_preferences -> 'sidebar'"],
    [(prefs) => prefs.devices, "p_preferences -> 'devices'"],
    ...contract.devices.flatMap((device) => [[(prefs) => prefs.devices[device], "v_layout"], [(prefs) => prefs.devices[device].items[0], "v_item"]]),
  ];
  for (const [select, rule] of targets) {
    for (const key of ["balance", "transactions", "user_id", "access_token", "email", "css", "style", "titleText", "toJSON", "__proto__"]) {
      const prefs = createDisplayPreferences();
      Object.defineProperty(select(prefs), key, { value: "synthetic forbidden payload", enumerable: true });
      agreement(prefs, false);
    }
    for (const key of exactKeyRules.get(rule)) {
      for (const nullInstead of [true, false]) {
        const prefs = createDisplayPreferences();
        if (nullInstead) select(prefs)[key] = null; else delete select(prefs)[key];
        agreement(prefs, false);
      }
    }
  }
  for (const root of [null, [], true, 1, "{}", {}]) agreement(root, false);
  for (const version of [0, 2, 3, 4, "1", true, null]) {
    const prefs = createDisplayPreferences(); prefs.version = version; agreement(prefs, false);
  }
});

test("pure contract samples: hidden navigation is unique, allowlisted and cannot hide home/settings", () => {
  for (const hidden of [["home"], ["settings"], ["accounts", "accounts"], ["unknown"], [null], [1], [{}], ["appearance;display:none"], Array(19).fill("capture"), null, {}]) {
    const prefs = createDisplayPreferences(); prefs.sidebar.hidden = hidden; agreement(prefs, false);
  }
});
