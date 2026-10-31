-- Approval-required, narrow candidate. NOT run by the app or installer.
-- Applies to the audited legacy setup, not the broader schema.sql candidate.
-- No financial rows are read, rewritten, migrated, restored or deleted.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';
lock table public.user_data in share row exclusive mode;

do $hardening$
declare
  target_oid oid := 'public.user_data'::regclass;
  old_touch_oid oid := pg_catalog.to_regprocedure('public.touch_updated_at()');
  owner_oid oid := pg_catalog.to_regprocedure('public.set_user_id()');
  event_oid oid := pg_catalog.to_regprocedure('public.rls_auto_enable()');
  revision_oid oid := pg_catalog.to_regprocedure('public.wealth_atlas_touch_revision()');
  before_state jsonb;
  after_state jsonb;
  function_oid oid;
begin
  if not exists (select 1 from pg_catalog.pg_class where oid = target_oid
    and relkind = 'r' and relrowsecurity)
    or not exists (select 1 from pg_catalog.pg_attribute where attrelid = target_oid
      and attname = 'updated_at' and atttypid = 'timestamptz'::regtype
      and attnotnull and not attisdropped) then
    raise exception 'Unexpected table metadata; nothing applied';
  end if;
  if old_touch_oid is null or owner_oid is null or event_oid is null
    or not exists (select 1 from pg_catalog.pg_proc where oid = event_oid
      and prorettype = 'event_trigger'::regtype)
    or not exists (select 1 from pg_catalog.pg_proc where oid = owner_oid
      and prorettype = 'trigger'::regtype)
    or not exists (select 1 from pg_catalog.pg_proc where oid = old_touch_oid
      and prorettype = 'trigger'::regtype) then
    raise exception 'Expected trigger functions missing; nothing applied';
  end if;
  if not exists (select 1 from pg_catalog.pg_trigger where tgrelid = target_oid
    and tgname = 'user_data_touch' and tgtype = 19 and tgenabled = 'O'
    and tgqual is null and tgnargs = 0 and tgattr::text = ''
    and (tgfoid = old_touch_oid or tgfoid = revision_oid))
    or not exists (select 1 from pg_catalog.pg_trigger where tgrelid = target_oid
      and tgname = 'user_data_set_user_id' and tgtype = 7 and tgenabled = 'O'
      and tgfoid = owner_oid and tgqual is null and tgnargs = 0)
    or not exists (select 1 from pg_catalog.pg_event_trigger where evtname = 'ensure_rls'
      and evtfoid = event_oid and evtenabled = 'O' and evtevent = 'ddl_command_end') then
    raise exception 'Trigger layout differs from audit; nothing applied';
  end if;
  -- Never change a shared/custom function or another table's trigger implicitly.
  if exists (select 1 from pg_catalog.pg_trigger
    where tgfoid in (old_touch_oid, owner_oid, revision_oid) and not tgisinternal
      and (tgrelid <> target_oid or tgname not in ('user_data_touch', 'user_data_set_user_id')))
    or exists (select 1 from pg_catalog.pg_event_trigger
      where evtfoid = event_oid and evtname <> 'ensure_rls') then
    raise exception 'Additional trigger dependencies require review; nothing applied';
  end if;
  if revision_oid is not null and not exists (select 1 from pg_catalog.pg_proc p
    where p.oid = revision_oid and p.prorettype = 'trigger'::regtype
      and not p.prosecdef and p.prosrc like '%wealth-atlas:revision-v1%') then
    raise exception 'Dedicated function name already used; nothing applied';
  end if;

  -- Compare configuration only, never snapshot contents. No API table grants,
  -- policies, identity trigger, event-trigger code or existing function bodies
  -- may be changed by this candidate.
  select jsonb_build_object(
    'table', (select to_jsonb(c) from pg_catalog.pg_class c where c.oid = target_oid),
    'columns', (select jsonb_agg(to_jsonb(a) order by a.attnum)
      from pg_catalog.pg_attribute a where a.attrelid = target_oid and a.attnum > 0),
    'policies', (select jsonb_agg(to_jsonb(p) order by p.oid)
      from pg_catalog.pg_policy p where p.polrelid = target_oid),
    'functions', (select jsonb_agg(jsonb_build_array(p.oid, p.prosrc, p.prosecdef, p.proconfig) order by p.oid)
      from pg_catalog.pg_proc p where p.oid in (old_touch_oid, owner_oid, event_oid)),
    'owner_trigger', (select to_jsonb(t) from pg_catalog.pg_trigger t
      where t.tgrelid = target_oid and t.tgname = 'user_data_set_user_id'),
    'event_trigger', (select to_jsonb(e) from pg_catalog.pg_event_trigger e where e.evtname = 'ensure_rls')
  ) into before_state;

  execute $ddl$
    create or replace function public.wealth_atlas_touch_revision()
    returns trigger language plpgsql security invoker set search_path = '' as $function$
    begin
      -- wealth-atlas:revision-v1. Server revision only, never financial dates.
      if tg_table_schema <> 'public' or tg_table_name <> 'user_data' or tg_op <> 'UPDATE' then
        raise exception 'Revision function called outside its intended trigger';
      end if;
      if not pg_catalog.isfinite(old.updated_at) then
        raise exception using errcode = '22008', message = 'Snapshot revision is not finite; update was not applied';
      end if;
      new.updated_at = greatest(pg_catalog.clock_timestamp(), old.updated_at + interval '1 microsecond');
      return new;
    end;
    $function$
  $ddl$;
  execute 'create or replace trigger user_data_touch before update on public.user_data
    for each row execute function public.wealth_atlas_touch_revision()';

  -- Existing trigger execution continues; this removes direct API-role EXECUTE.
  -- Do not disable ensure_rls, alter its body, or change global default privileges.
  revoke execute on function public.set_user_id() from public, anon, authenticated;
  revoke execute on function public.touch_updated_at() from public, anon, authenticated;
  revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  revoke execute on function public.wealth_atlas_touch_revision() from public, anon, authenticated;
  foreach function_oid in array array[old_touch_oid, owner_oid, event_oid,
    pg_catalog.to_regprocedure('public.wealth_atlas_touch_revision()')::oid]
  loop
    if pg_catalog.has_function_privilege('anon', function_oid, 'EXECUTE')
      or pg_catalog.has_function_privilege('authenticated', function_oid, 'EXECUTE') then
      raise exception 'Inherited function grant remains; nothing applied';
    end if;
  end loop;

  select jsonb_build_object(
    'table', (select to_jsonb(c) from pg_catalog.pg_class c where c.oid = target_oid),
    'columns', (select jsonb_agg(to_jsonb(a) order by a.attnum)
      from pg_catalog.pg_attribute a where a.attrelid = target_oid and a.attnum > 0),
    'policies', (select jsonb_agg(to_jsonb(p) order by p.oid)
      from pg_catalog.pg_policy p where p.polrelid = target_oid),
    'functions', (select jsonb_agg(jsonb_build_array(p.oid, p.prosrc, p.prosecdef, p.proconfig) order by p.oid)
      from pg_catalog.pg_proc p where p.oid in (old_touch_oid, owner_oid, event_oid)),
    'owner_trigger', (select to_jsonb(t) from pg_catalog.pg_trigger t
      where t.tgrelid = target_oid and t.tgname = 'user_data_set_user_id'),
    'event_trigger', (select to_jsonb(e) from pg_catalog.pg_event_trigger e where e.evtname = 'ensure_rls')
  ) into after_state;
  if before_state is distinct from after_state then
    raise exception 'Unrelated configuration changed; nothing applied';
  end if;
end
$hardening$;
commit;
