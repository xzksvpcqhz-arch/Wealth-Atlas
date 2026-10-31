-- Separately approved legacy-function configuration fix. No financial DML.
-- Not run automatically by the app, installer or the broader schema candidate.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';
do $pin_path$
declare
  function_oid oid := pg_catalog.to_regprocedure('public.touch_updated_at()');
  before_function jsonb;
  before_layout jsonb;
  after_layout jsonb;
  other_settings text[];
begin
  if function_oid is null or not exists (
    select 1 from pg_catalog.pg_proc p where p.oid = function_oid
      and p.prorettype = 'trigger'::regtype and not p.prosecdef
      and pg_catalog.regexp_replace(pg_catalog.lower(p.prosrc), '[[:space:]]', '', 'g')
        = 'beginnew.updated_at=now();returnnew;end;'
      and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      and not pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) then
    raise exception 'Legacy function differs from audit; nothing applied';
  end if;
  if not exists (select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.user_data'::regclass and t.tgname = 'user_data_touch'
      and t.tgenabled = 'O' and t.tgfoid = pg_catalog.to_regprocedure('public.wealth_atlas_touch_revision()')) then
    raise exception 'Active revision trigger differs from audit; nothing applied';
  end if;
  select to_jsonb(p) - 'proconfig',
    array(select s from unnest(coalesce(p.proconfig, '{}'::text[])) s
      where s not like 'search_path=%' order by s)
    into before_function, other_settings
    from pg_catalog.pg_proc p where p.oid = function_oid;
  select jsonb_build_object(
    'table', (select to_jsonb(c) from pg_catalog.pg_class c where c.oid = 'public.user_data'::regclass),
    'policies', (select jsonb_agg(to_jsonb(p) order by p.oid) from pg_catalog.pg_policy p
      where p.polrelid = 'public.user_data'::regclass),
    'triggers', (select jsonb_agg(to_jsonb(t) order by t.oid) from pg_catalog.pg_trigger t
      where t.tgrelid = 'public.user_data'::regclass)
  ) into before_layout;

  alter function public.touch_updated_at() set search_path = pg_catalog;

  if before_function is distinct from (select to_jsonb(p) - 'proconfig'
      from pg_catalog.pg_proc p where p.oid = function_oid)
    or other_settings is distinct from (select array(select s from unnest(p.proconfig) s
      where s not like 'search_path=%' order by s) from pg_catalog.pg_proc p where p.oid = function_oid)
    or not exists (select 1 from pg_catalog.pg_proc p where p.oid = function_oid
      and 'search_path=pg_catalog' = any(p.proconfig)) then
    raise exception 'Unexpected function configuration change; nothing applied';
  end if;
  select jsonb_build_object(
    'table', (select to_jsonb(c) from pg_catalog.pg_class c where c.oid = 'public.user_data'::regclass),
    'policies', (select jsonb_agg(to_jsonb(p) order by p.oid) from pg_catalog.pg_policy p
      where p.polrelid = 'public.user_data'::regclass),
    'triggers', (select jsonb_agg(to_jsonb(t) order by t.oid) from pg_catalog.pg_trigger t
      where t.tgrelid = 'public.user_data'::regclass)
  ) into after_layout;
  if before_layout is distinct from after_layout then
    raise exception 'Unrelated metadata changed; nothing applied';
  end if;
end
$pin_path$;
commit;
