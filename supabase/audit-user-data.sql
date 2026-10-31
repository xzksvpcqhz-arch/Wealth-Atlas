-- READ-ONLY catalog audit. No financial rows, counts, JWTs or credentials.
-- Safe to review in SQL Editor before considering schema.sql. This is NOT a
-- certificate of isolation: also run A/B denial tests in a separate test project.
begin read only;
set local statement_timeout = '15s';

select c.relname as table_name, c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as force_rls, c.relreplident as replica_identity,
  pg_catalog.pg_get_userbyid(c.relowner) as table_owner
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'user_data';

select r.rolname as role_name, r.rolsuper as superuser, r.rolbypassrls as bypass_rls,
  r.rolcreaterole as can_create_roles,
  pg_catalog.pg_has_role(r.oid, c.relowner, 'USAGE') as inherits_table_owner,
  pg_catalog.has_table_privilege(r.oid, c.oid, 'SELECT') as can_select,
  pg_catalog.has_any_column_privilege(r.oid, c.oid, 'INSERT') as can_insert_columns,
  pg_catalog.has_any_column_privilege(r.oid, c.oid, 'UPDATE') as can_update_columns,
  pg_catalog.has_table_privilege(r.oid, c.oid, 'DELETE') as can_delete_snapshot,
  pg_catalog.has_table_privilege(r.oid, c.oid, 'TRUNCATE') as can_truncate
from pg_catalog.pg_roles r cross join pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where r.rolname in ('anon', 'authenticated')
  and n.nspname = 'public' and c.relname = 'user_data';

select policyname as policy_name, permissive, roles, cmd as command,
  qual as using_expression, with_check as check_expression
from pg_catalog.pg_policies
where schemaname = 'public' and tablename = 'user_data' order by policyname;

select a.attname as column_name, pg_catalog.format_type(a.atttypid, a.atttypmod) as column_type,
  a.attnotnull as required,
  pg_catalog.has_column_privilege('anon', c.oid, a.attnum, 'SELECT') as anon_select,
  pg_catalog.has_column_privilege('anon', c.oid, a.attnum, 'INSERT') as anon_insert,
  pg_catalog.has_column_privilege('anon', c.oid, a.attnum, 'UPDATE') as anon_update,
  pg_catalog.has_column_privilege('authenticated', c.oid, a.attnum, 'INSERT') as authenticated_insert,
  pg_catalog.has_column_privilege('authenticated', c.oid, a.attnum, 'UPDATE') as authenticated_update
from pg_catalog.pg_attribute a
join pg_catalog.pg_class c on c.oid = a.attrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'user_data' and a.attnum > 0 and not a.attisdropped
order by a.attnum;

select i.indisunique as unique_index, i.indisprimary as primary_index,
  i.indisvalid as valid_index, i.indpred is null as unfiltered,
  array(select a.attname from unnest(i.indkey) with ordinality as k(attnum, position)
    join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
    where k.position <= i.indnkeyatts order by k.position) as indexed_columns
from pg_catalog.pg_index i
join pg_catalog.pg_class c on c.oid = i.indrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'user_data';

select t.tgname as trigger_name, t.tgenabled as enabled,
  p.proname as function_name, p.prosecdef as security_definer, p.proconfig as function_settings,
  pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
  pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute
from pg_catalog.pg_trigger t
join pg_catalog.pg_class c on c.oid = t.tgrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
join pg_catalog.pg_proc p on p.oid = t.tgfoid
where n.nspname = 'public' and c.relname = 'user_data' and not t.tgisinternal
order by t.tgname;

select pubname as publication_name from pg_catalog.pg_publication_tables
where schemaname = 'public' and tablename = 'user_data';

-- Alternative paths need review too: RLS on the base table alone is insufficient
-- if a privileged function or definer view exposes it. Never output definitions
-- or execute these functions/views during this audit.
select distinct nv.nspname as view_schema, v.relname as view_name, v.reloptions as view_options,
  pg_catalog.has_table_privilege('anon', v.oid, 'SELECT') as anon_select,
  pg_catalog.has_table_privilege('authenticated', v.oid, 'SELECT') as authenticated_select
from pg_catalog.pg_depend d
join pg_catalog.pg_rewrite rw on rw.oid = d.objid
join pg_catalog.pg_class v on v.oid = rw.ev_class
join pg_catalog.pg_namespace nv on nv.oid = v.relnamespace
where d.classid = 'pg_catalog.pg_rewrite'::regclass
  and d.refclassid = 'pg_catalog.pg_class'::regclass
  and d.refobjid = to_regclass('public.user_data') and v.relkind in ('v', 'm');

select p.proname as function_name,
  pg_catalog.pg_get_function_identity_arguments(p.oid) as argument_types,
  pg_catalog.format_type(p.prorettype, null) as result_type,
  case
    when p.prorettype = 'trigger'::regtype then 'row_trigger'
    when p.prorettype = 'event_trigger'::regtype then 'event_trigger'
    else 'ordinary_function_requires_rpc_review'
  end as function_kind,
  p.proconfig as function_settings,
  pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
  pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef order by p.proname;
rollback;
