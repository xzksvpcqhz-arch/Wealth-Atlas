import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const candidate = readFileSync(new URL("../supabase/harden-user-data-triggers.sql", import.meta.url), "utf8");
const pathCandidate = readFileSync(new URL("../supabase/pin-legacy-timestamp-search-path.sql", import.meta.url), "utf8");
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";

/** Ephemeral synthetic PostgreSQL only. No environment, hosted connection,
 * private profile, user credentials, real snapshot or production write. */
export async function runTriggerChecks(PGlite) {
  const checks = [];
  const db = await PGlite.create();
  async function check(name, run) {
    try { await run(); checks.push({ name, pass: true }); }
    catch { throw new Error(`Isolated trigger check failed: ${name}; provider details suppressed.`); }
  }
  async function as(user, query, params = []) {
    return db.transaction(async (tx) => {
      await tx.exec("set local role authenticated");
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [user]);
      return tx.query(query, params);
    });
  }
  const rows = async () => (await db.query("select id, user_id, data, updated_at::text from public.user_data order by user_id")).rows;
  const bodies = async () => (await db.query(`select proname, prosrc, prosecdef, proconfig from pg_proc
    where oid in ('public.set_user_id()'::regprocedure, 'public.touch_updated_at()'::regprocedure,
      'public.rls_auto_enable()'::regprocedure) order by proname`)).rows;
  const privileges = async () => (await db.query(`select r.rolname, c.relacl,
    has_table_privilege(r.oid, c.oid, 'SELECT') as can_select,
    has_table_privilege(r.oid, c.oid, 'INSERT') as can_insert,
    has_table_privilege(r.oid, c.oid, 'UPDATE') as can_update,
    has_table_privilege(r.oid, c.oid, 'DELETE') as can_delete,
    has_table_privilege(r.oid, c.oid, 'TRUNCATE') as can_truncate
    from pg_roles r cross join pg_class c where c.oid = 'public.user_data'::regclass
      and r.rolname in ('anon', 'authenticated', 'service_role') order by r.rolname`)).rows;
  const binding = async () => (await db.query(`select tgname, tgfoid, tgenabled from pg_trigger
    where tgrelid = 'public.user_data'::regclass and not tgisinternal order by tgname`)).rows;
  async function failsSafely(sql, code) {
    await assert.rejects(() => db.exec(sql), (error) => !code || error.code === code);
    await db.exec("rollback");
  }
  try {
    await db.exec(`
      create role anon nologin nosuperuser nobypassrls;
      create role authenticated nologin nosuperuser nobypassrls;
      create role service_role nologin;
      create role synthetic_inherited_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      grant usage on schema public, auth to anon, authenticated;
      create table public.user_data (
        id uuid primary key default gen_random_uuid(), user_id uuid not null unique,
        data jsonb not null default '{}', updated_at timestamptz not null default now()
      );
      alter table public.user_data enable row level security;
      grant select, insert, update, references, trigger, maintain on public.user_data to authenticated;
      grant all on public.user_data to service_role;
      create policy user_data_select_own on public.user_data for select using (auth.uid() = user_id);
      create policy user_data_insert_own on public.user_data for insert with check (auth.uid() = user_id);
      create policy user_data_update_own on public.user_data for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
      create policy user_data_delete_own on public.user_data for delete using (auth.uid() = user_id);
      create function public.set_user_id() returns trigger language plpgsql security definer set search_path = public
        as $$ begin new.user_id = auth.uid(); return new; end; $$;
      create function public.touch_updated_at() returns trigger language plpgsql
        as $$ begin new.updated_at = now(); return new; end; $$;
      create trigger user_data_set_user_id before insert on public.user_data for each row execute function public.set_user_id();
      create trigger user_data_touch before update on public.user_data for each row execute function public.touch_updated_at();
      create function public.rls_auto_enable() returns event_trigger language plpgsql security definer set search_path = pg_catalog as $$
      declare cmd record;
      begin
        for cmd in select * from pg_event_trigger_ddl_commands() loop
          if cmd.schema_name = 'public' and cmd.object_type = 'table' then
            execute format('alter table %s enable row level security', cmd.object_identity);
          end if;
        end loop;
      end; $$;
      create event trigger ensure_rls on ddl_command_end when tag in ('CREATE TABLE') execute function public.rls_auto_enable();
      grant execute on function public.set_user_id(), public.touch_updated_at(), public.rls_auto_enable() to anon, authenticated, service_role;
    `);
    for (const user of [A, B]) await as(user, "insert into public.user_data(data) values ($1)", [{ fixture: user === A ? "A" : "B", transactions: [] }]);

    await check("legacy now() reproduces duplicate revisions in one transaction", async () => {
      await db.transaction(async (tx) => {
        const first = await tx.query("update public.user_data set data = data where user_id = $1 returning updated_at::text", [A]);
        const second = await tx.query("update public.user_data set data = data where user_id = $1 returning updated_at::text", [A]);
        assert.equal(first.rows[0].updated_at, second.rows[0].updated_at);
      });
    });
    const originalBodies = await bodies();
    const originalPrivileges = await privileges();
    await check("narrow candidate preserves every synthetic row and table privilege", async () => {
      const before = await rows();
      await db.exec(candidate);
      assert.deepEqual(await rows(), before);
      assert.deepEqual(await bodies(), originalBodies);
      assert.deepEqual(await privileges(), originalPrivileges);
    });
    await check("API roles lose direct function execution; service role grants remain", async () => {
      const result = await db.query(`select has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_execute,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service_execute, p.proname
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
          and p.proname in ('set_user_id','touch_updated_at','rls_auto_enable','wealth_atlas_touch_revision')`);
      assert.equal(result.rows.length, 4);
      for (const row of result.rows) {
        assert.equal(row.anon_execute, false); assert.equal(row.auth_execute, false);
        if (row.proname !== "wealth_atlas_touch_revision") assert.equal(row.service_execute, true);
      }
      for (const name of ["set_user_id", "touch_updated_at", "rls_auto_enable", "wealth_atlas_touch_revision"]) {
        await assert.rejects(() => as(A, `select public.${name}()`), (error) => error.code === "42501");
      }
    });
    await check("legacy missing-owner upsert still inserts and updates through triggers", async () => {
      for (const value of ["created", "edited"]) {
        const result = await as(C, `insert into public.user_data(data) values ($1)
          on conflict (user_id) do update set data = excluded.data returning user_id, data`, [{ fixture: value }]);
        assert.equal(result.rows[0].user_id, C);
        assert.equal(result.rows[0].data.fixture, value);
      }
    });
    await check("new client owner-filtered insert and save remain supported", async () => {
      const inserted = await as(D, "insert into public.user_data(user_id, data) values ($1, $2) returning user_id", [D, { fixture: "explicit-owner" }]);
      assert.equal(inserted.rows[0].user_id, D);
      const result = await as(A, "update public.user_data set data = $1 where user_id = $2 returning data", [{ fixture: "saved" }, A]);
      assert.equal(result.rows[0].data.fixture, "saved");
      assert.equal((await as(A, "select user_id from public.user_data")).rows.length, 1);
      assert.equal((await as(A, "select id from public.user_data where user_id = $1", [B])).rows.length, 0);
    });
    await check("two authenticated saves get strictly increasing microsecond CAS tokens", async () => {
      await db.transaction(async (tx) => {
        await tx.exec("set local role authenticated");
        await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [A]);
        const first = await tx.query("update public.user_data set data = data returning updated_at::text");
        const second = await tx.query("update public.user_data set data = data returning updated_at::text");
        const greater = await tx.query("select $1::timestamptz > $2::timestamptz as advanced", [second.rows[0].updated_at, first.rows[0].updated_at]);
        assert.equal(greater.rows[0].advanced, true);
      });
    });
    await check("stale CAS token cannot overwrite an already saved edit", async () => {
      const revision = (await as(A, "select updated_at::text from public.user_data")).rows[0].updated_at;
      const first = await as(A, "update public.user_data set data = $1 where updated_at = $2 returning updated_at::text", [{ fixture: "fresh" }, revision]);
      assert.equal(first.rows.length, 1);
      assert.equal((await as(A, "update public.user_data set data = '{}' where updated_at = $1 returning id", [revision])).rows.length, 0);
    });
    await check("client supplied future timestamps cannot choose a revision", async () => {
      const result = await as(A, "update public.user_data set updated_at = '9999-01-01' returning updated_at < '9999-01-01'::timestamptz as server_owned");
      assert.equal(result.rows[0].server_owned, true);
    });
    await check("old future revisions advance even if wall clock is earlier", async () => {
      await db.exec("alter table public.user_data disable trigger user_data_touch");
      await db.query("update public.user_data set updated_at = '9999-01-01' where user_id = $1", [A]);
      await db.exec("alter table public.user_data enable trigger user_data_touch");
      const result = await as(A, "update public.user_data set data = data returning updated_at > '9999-01-01'::timestamptz as advanced");
      assert.equal(result.rows[0].advanced, true);
    });
    await check("non-finite existing revision fails without replacing any snapshot", async () => {
      await db.exec("alter table public.user_data disable trigger user_data_touch");
      await db.query("update public.user_data set updated_at = 'infinity' where user_id = $1", [A]);
      await db.exec("alter table public.user_data enable trigger user_data_touch");
      const before = await rows();
      await assert.rejects(() => as(A, "update public.user_data set data = '{}'"), (error) => error.code === "22008");
      assert.deepEqual(await rows(), before);
      await db.exec("alter table public.user_data disable trigger user_data_touch");
      await db.query("update public.user_data set updated_at = now() where user_id = $1", [A]);
      await db.exec("alter table public.user_data enable trigger user_data_touch");
    });
    await check("JSON recycle and restore work without altering another owner's data", async () => {
      const other = (await rows()).find((row) => row.user_id === B);
      for (const deleted of [true, false]) {
        const result = await as(A, "update public.user_data set data = $1 returning data", [{ transactions: [{ id: "synthetic", deleted }] }]);
        assert.equal(result.rows[0].data.transactions[0].deleted, deleted);
      }
      assert.deepEqual((await rows()).find((row) => row.user_id === B), other);
      await assert.rejects(() => as(A, "delete from public.user_data"), (error) => error.code === "42501");
      await assert.rejects(() => as(A, "truncate public.user_data"), (error) => error.code === "42501");
    });
    await check("auto-RLS event trigger remains enabled and protects new tables", async () => {
      await db.exec("create table public.synthetic_rls_probe (id integer)");
      const result = await db.query("select relrowsecurity from pg_class where oid = 'public.synthetic_rls_probe'::regclass");
      assert.equal(result.rows[0].relrowsecurity, true);
      assert.deepEqual(await bodies(), originalBodies);
    });
    await check("repeat candidate does not rewrite revisions, data or privileges", async () => {
      const before = await rows();
      await db.exec(candidate); await db.exec(candidate);
      assert.deepEqual(await rows(), before);
      assert.deepEqual(await privileges(), originalPrivileges);
    });
    await check("failed DDL transaction restores prior function grants and trigger binding", async () => {
      await db.exec(`grant execute on function public.set_user_id() to anon;
        create or replace trigger user_data_touch before update on public.user_data
        for each row execute function public.touch_updated_at()`);
      const before = await rows(); const originalBinding = await binding();
      await failsSafely(candidate.replace(/commit;\s*$/i, "select synthetic_missing_function(); commit;"));
      assert.deepEqual(await rows(), before); assert.deepEqual(await binding(), originalBinding);
      assert.equal((await db.query("select has_function_privilege('anon', 'public.set_user_id()', 'EXECUTE') as allowed")).rows[0].allowed, true);
      await db.exec(candidate);
    });
    await check("unexpected disabled trigger refuses change and leaves original rows intact", async () => {
      await db.exec("alter table public.user_data disable trigger user_data_touch");
      const before = await rows(); const originalBinding = await binding();
      await failsSafely(candidate);
      assert.deepEqual(await rows(), before); assert.deepEqual(await binding(), originalBinding);
      await db.exec("alter table public.user_data enable trigger user_data_touch");
    });
    await check("shared function dependency refuses change rather than touching other tables", async () => {
      await db.exec("create trigger synthetic_shared_touch before update on public.synthetic_rls_probe for each row execute function public.touch_updated_at()");
      const before = await rows();
      await failsSafely(candidate);
      assert.deepEqual(await rows(), before);
      await db.exec("drop trigger synthetic_shared_touch on public.synthetic_rls_probe");
    });
    await check("inherited API function privilege aborts and rolls all DDL back", async () => {
      await db.exec("grant synthetic_inherited_role to anon; grant execute on function public.set_user_id() to synthetic_inherited_role");
      const before = await rows(); const originalBinding = await binding();
      await failsSafely(candidate);
      assert.deepEqual(await rows(), before); assert.deepEqual(await binding(), originalBinding);
      await db.exec("revoke synthetic_inherited_role from anon");
    });
    await check("legacy path fix changes only search_path, not rows, code, grants or triggers", async () => {
      const beforeRows = await rows(); const beforeBodies = await bodies(); const beforeBinding = await binding();
      await db.exec(pathCandidate);
      assert.deepEqual(await rows(), beforeRows); assert.deepEqual(await binding(), beforeBinding);
      assert.deepEqual(await privileges(), originalPrivileges);
      const expectedBodies = beforeBodies.map((p) => p.proname === "touch_updated_at" ? { ...p, proconfig: ["search_path=pg_catalog"] } : p);
      assert.deepEqual(await bodies(), expectedBodies);
      const access = await db.query(`select has_function_privilege('anon', 'public.touch_updated_at()', 'EXECUTE') as anon,
        has_function_privilege('authenticated', 'public.touch_updated_at()', 'EXECUTE') as authenticated,
        has_function_privilege('service_role', 'public.touch_updated_at()', 'EXECUTE') as service_role`);
      assert.deepEqual(access.rows, [{ anon: false, authenticated: false, service_role: true }]);
    });
    await check("retained legacy trigger still works with a shadowing session search path", async () => {
      await db.exec(`create schema synthetic_shadow;
        create function synthetic_shadow.now() returns timestamptz language sql as $$ select '1900-01-01'::timestamptz $$;
        create table public.synthetic_legacy_probe(id integer primary key, updated_at timestamptz);
        insert into public.synthetic_legacy_probe(id) values (1);
        create trigger synthetic_legacy_touch before update on public.synthetic_legacy_probe
          for each row execute function public.touch_updated_at()`);
      await db.transaction(async (tx) => {
        await tx.exec("set local search_path = synthetic_shadow, public, pg_catalog");
        const result = await tx.query(`update public.synthetic_legacy_probe set id = id
          returning updated_at > '2000-01-01'::timestamptz as uses_builtin`);
        assert.equal(result.rows[0].uses_builtin, true);
      });
    });
    await check("current CAS trigger still advances after legacy path pinning", async () => {
      const revision = (await as(A, "select updated_at::text from public.user_data")).rows[0].updated_at;
      const result = await as(A, "update public.user_data set data = data where updated_at = $1 returning updated_at > $1::timestamptz as advanced", [revision]);
      assert.equal(result.rows[0].advanced, true);
      assert.equal((await as(A, "update public.user_data set data = '{}' where updated_at = $1 returning id", [revision])).rows.length, 0);
    });
    await check("repeated legacy path fix leaves every synthetic row untouched", async () => {
      const before = await rows(); const beforeBodies = await bodies();
      await db.exec(pathCandidate); await db.exec(pathCandidate);
      assert.deepEqual(await rows(), before); assert.deepEqual(await bodies(), beforeBodies);
    });
    await check("failed path-fix transaction rolls back the function setting", async () => {
      await db.exec("alter function public.touch_updated_at() reset search_path");
      const before = await rows(); const beforeBodies = await bodies();
      await failsSafely(pathCandidate.replace(/commit;\s*$/i, "select synthetic_missing_function(); commit;"));
      assert.deepEqual(await rows(), before); assert.deepEqual(await bodies(), beforeBodies);
      await db.exec(pathCandidate);
    });
    await check("unexpected legacy function body is refused without replacing code or data", async () => {
      await db.exec(`create or replace function public.touch_updated_at() returns trigger language plpgsql
        set search_path = pg_catalog as $$ begin new.updated_at = clock_timestamp(); return new; end; $$`);
      const before = await rows(); const beforeBodies = await bodies();
      await failsSafely(pathCandidate);
      assert.deepEqual(await rows(), before); assert.deepEqual(await bodies(), beforeBodies);
    });
    return { engine: "isolated PostgreSQL (PGlite)", checks, liveDatabaseModified: false, hostedAuthVerified: false };
  } finally { await db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const modulePath = process.argv[2] || "work/rls-harness/node_modules/@electric-sql/pglite/dist/index.js";
    const { PGlite } = await import(pathToFileURL(resolve(modulePath)).href);
    console.log(JSON.stringify(await runTriggerChecks(PGlite), null, 2));
  } catch (error) {
    console.error(error?.message?.startsWith("Isolated trigger check failed:") ? error.message
      : "Isolated trigger runner failed; use the documented optional local tool. No live database was used.");
    process.exitCode = 1;
  }
}
