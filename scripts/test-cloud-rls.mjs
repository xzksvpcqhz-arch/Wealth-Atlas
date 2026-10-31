import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
const audit = readFileSync(new URL("../supabase/audit-user-data.sql", import.meta.url), "utf8");
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

/** Real PostgreSQL RLS in an ephemeral WASM database. No network, auth session,
 * disk database, production URL, env file or private profile is used. */
export async function runCloudRlsChecks(PGlite) {
  const checks = [];
  const db = await PGlite.create();
  const check = async (name, run) => {
    try { await run(); checks.push({ name, pass: true }); }
    catch { throw new Error(`Isolated RLS check failed: ${name}; no data or provider error printed.`); }
  };
  async function as(role, user, query, params = []) {
    assert.ok(["anon", "authenticated"].includes(role));
    return db.transaction(async (tx) => {
      await tx.exec(`set local role ${role}`);
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [user ?? ""]);
      return tx.query(query, params);
    });
  }
  const rows = () => db.query("select id, user_id, data, updated_at::text from public.user_data order by user_id");
  const denied = async (run) => { await assert.rejects(run, (error) => error.code === "42501"); };
  try {
    await db.exec(`
      create role anon nologin nosuperuser nobypassrls;
      create role authenticated nologin nosuperuser nobypassrls;
      create schema auth;
      create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      grant usage on schema public, auth to anon, authenticated;
      create publication supabase_realtime;
    `);
    await db.query("insert into auth.users(id) values ($1), ($2)", [A, B]);
    await check("fresh database installs the candidate without financial migrations", async () => {
      await db.exec(schema);
      assert.equal((await rows()).rows.length, 0);
    });
    await check("anonymous SELECT/INSERT/UPDATE/DELETE/TRUNCATE denied", async () => {
      for (const query of ["select data from public.user_data", "insert into public.user_data(data) values ('{}')",
        "update public.user_data set data = '{}'", "delete from public.user_data", "truncate public.user_data"]) {
        await denied(() => as("anon", null, query));
      }
    });
    await check("authenticated role without a verified subject cannot insert", async () => {
      await denied(() => as("authenticated", null, "insert into public.user_data(data) values ('{}')"));
    });
    await check("two synthetic users can insert and read their own snapshot", async () => {
      for (const owner of [A, B]) {
        const inserted = await as("authenticated", owner,
          "insert into public.user_data(user_id, data) values ($1, $2) returning user_id, data",
          [owner, { fixture: owner === A ? "A" : "B", transactions: [] }]);
        assert.equal(inserted.rows[0].user_id, owner);
        assert.equal((await as("authenticated", owner, "select user_id from public.user_data")).rows[0].user_id, owner);
      }
    });
    await check("unfiltered and forged-owner reads cannot see the other user", async () => {
      for (const [self, other] of [[A, B], [B, A]]) {
        const visible = await as("authenticated", self, "select user_id from public.user_data");
        assert.deepEqual(visible.rows.map((row) => row.user_id), [self]);
        assert.equal((await as("authenticated", self, "select data from public.user_data where user_id = $1", [other])).rows.length, 0);
      }
    });
    await check("forged-owner inserts are rejected, not silently reassigned", async () => {
      await denied(() => as("authenticated", A, "insert into public.user_data(user_id, data) values ($1, '{}')", [B]));
    });
    await check("cross-user updates affect zero rows and preserve both snapshots", async () => {
      const before = (await rows()).rows;
      for (const [self, other] of [[A, B], [B, A]]) {
        const result = await as("authenticated", self,
          "update public.user_data set data = '{}' where user_id = $1 returning user_id", [other]);
        assert.equal(result.rows.length, 0);
      }
      assert.deepEqual((await rows()).rows, before);
    });
    await check("snapshot identity and user_id cannot be edited", async () => {
      await denied(() => as("authenticated", A, "update public.user_data set user_id = $1", [B]));
      await denied(() => as("authenticated", A, "update public.user_data set id = gen_random_uuid()"));
    });
    await check("snapshot DELETE and TRUNCATE denied while JSON delete/restore works", async () => {
      await denied(() => as("authenticated", A, "delete from public.user_data"));
      await denied(() => as("authenticated", A, "truncate public.user_data"));
      const other = (await as("authenticated", B, "select data from public.user_data")).rows;
      for (const deleted of [true, false]) {
        const result = await as("authenticated", A,
          "update public.user_data set data = $1 returning data", [{ fixture: "A", transactions: [{ id: "synthetic", deleted }] }]);
        assert.equal(result.rows[0].data.transactions[0].deleted, deleted);
      }
      assert.deepEqual((await as("authenticated", B, "select data from public.user_data")).rows, other);
    });
    await check("CAS timestamp advances; stale revision cannot overwrite a saved edit", async () => {
      const original = (await as("authenticated", A, "select updated_at::text from public.user_data")).rows[0].updated_at;
      const first = await as("authenticated", A,
        "update public.user_data set data = $1, updated_at = '9999-01-01' where updated_at = $2 returning updated_at::text",
        [{ fixture: "saved" }, original]);
      assert.equal(first.rows.length, 1);
      assert.ok(Date.parse(first.rows[0].updated_at) < Date.parse("9999-01-01"));
      const second = await as("authenticated", A,
        "update public.user_data set data = '{}' where updated_at = $1 returning updated_at", [original]);
      assert.equal(second.rows.length, 0);
      await db.transaction(async (tx) => {
        await tx.exec("set local role authenticated");
        await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [A]);
        const x = await tx.query("update public.user_data set data = data returning updated_at::text");
        const y = await tx.query("update public.user_data set data = data returning updated_at::text");
        assert.notEqual(x.rows[0].updated_at, y.rows[0].updated_at);
      });
    });
    await check("first-upload insert races cannot replace the existing snapshot", async () => {
      const before = (await rows()).rows;
      await assert.rejects(() => as("authenticated", A,
        "insert into public.user_data(user_id, data) values ($1, '{}')", [A]), (error) => error.code === "23505");
      assert.deepEqual((await rows()).rows, before);
    });
    await check("dedicated trigger functions are non-elevated, pinned and not callable by API roles", async () => {
      const result = await db.query(`select p.prosecdef, p.proconfig,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('wealth_atlas_guard_owner', 'wealth_atlas_touch_revision')`);
      assert.equal(result.rows.length, 2);
      for (const row of result.rows) {
        assert.equal(row.prosecdef, false); assert.equal(row.anon_execute, false); assert.equal(row.authenticated_execute, false);
        assert.ok(row.proconfig.some((value) => value.startsWith("search_path=")));
      }
    });
    await check("restrictive policies withstand a stray permissive policy and DELETE grant", async () => {
      await db.exec(`create policy synthetic_accidental_allow on public.user_data for all to public using (true) with check (true);
        grant delete on public.user_data to authenticated;`);
      assert.equal((await as("authenticated", A, "select user_id from public.user_data")).rows.length, 1);
      assert.equal((await as("authenticated", A, "delete from public.user_data returning user_id")).rows.length, 0);
      assert.equal((await as("authenticated", null, "select user_id from public.user_data")).rows.length, 0);
    });
    await check("legacy owner/revision triggers and table/column grants upgrade without touching rows", async () => {
      const before = (await rows()).rows;
      await db.exec(`grant all on public.user_data to anon, authenticated;
        grant select(data), update(data) on public.user_data to anon;
        grant update(user_id), insert(id) on public.user_data to authenticated;
        create function public.set_user_id() returns trigger language plpgsql security definer set search_path = public
          as $$ begin new.user_id = auth.uid(); return new; end; $$;
        create function public.touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
        drop trigger user_data_set_user_id on public.user_data;
        drop trigger user_data_touch on public.user_data;
        create trigger user_data_set_user_id before insert on public.user_data for each row execute function public.set_user_id();
        create trigger user_data_touch before update on public.user_data for each row execute function public.touch_updated_at();
        drop policy user_data_owner_boundary on public.user_data;
        drop policy user_data_no_snapshot_delete on public.user_data;
        create policy user_data_delete_own on public.user_data for delete using (auth.uid() = user_id);
        alter table public.user_data replica identity full;`);
      const oldFunction = (await db.query("select pg_get_functiondef('public.touch_updated_at()'::regprocedure) as body")).rows;
      await db.exec(schema);
      await db.exec(schema);
      assert.deepEqual((await rows()).rows, before);
      await denied(() => as("anon", null, "select data from public.user_data"));
      await denied(() => as("authenticated", A, "delete from public.user_data"));
      await denied(() => as("authenticated", A, "update public.user_data set user_id = $1", [B]));
      assert.deepEqual((await db.query("select pg_get_functiondef('public.touch_updated_at()'::regprocedure) as body")).rows, oldFunction);
    });
    await check("failed permission transaction rolls back its DDL and preserves all snapshots", async () => {
      const before = (await rows()).rows;
      await db.exec("grant select(data) on public.user_data to anon");
      const failedCandidate = schema.replace(/commit;\s*$/i, "select synthetic_missing_function(); commit;");
      await assert.rejects(() => db.exec(failedCandidate));
      await db.exec("rollback");
      assert.equal((await db.query("select has_column_privilege('anon', 'public.user_data', 'data', 'SELECT') as allowed")).rows[0].allowed, true);
      assert.deepEqual((await rows()).rows, before);
      await db.exec(schema);
      await denied(() => as("anon", null, "select data from public.user_data"));
    });
    await check("catalog audit is read-only and emits no snapshot data", async () => {
      const before = (await rows()).rows;
      const results = await db.exec(audit);
      assert.ok(results.some((result) => result.rows?.some((row) => row.rls_enabled === true)));
      assert.ok(!results.some((result) => result.rows?.some((row) => "data" in row || "user_id" in row)));
      assert.deepEqual((await rows()).rows, before);
    });
    return { engine: "isolated PostgreSQL (PGlite)", checks, liveDatabaseModified: false, liveIsolationVerified: false };
  } finally { await db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // Optional local test tool, not a new app dependency. No production connection.
    const modulePath = process.argv[2] || "work/rls-harness/node_modules/@electric-sql/pglite/dist/index.js";
    const { PGlite } = await import(pathToFileURL(resolve(modulePath)).href);
    console.log(JSON.stringify(await runCloudRlsChecks(PGlite), null, 2));
  } catch (error) {
    console.error(error?.message?.startsWith("Isolated RLS check failed:") ? error.message
      : "Isolated RLS runner failed; install the documented local test tool. No live database was used.");
    process.exitCode = 1;
  }
}
