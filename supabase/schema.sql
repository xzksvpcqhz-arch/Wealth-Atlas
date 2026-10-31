-- Wealth Atlas cloud permissions candidate (NOT automatically applied).
-- FIRST run audit-user-data.sql, review its metadata and obtain owner approval.
-- Existing users: export backups and stop legacy cloud writers before applying.
-- This transaction changes permissions/triggers only, never financial rows.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

-- 1. 数据表：每个用户一行，存完整的 WealthData 快照
create table if not exists public.user_data (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create unique index if not exists user_data_user_id_idx on public.user_data (user_id);

-- 2. 开启行级安全（RLS）
alter table public.user_data enable row level security;

-- Explicit grants are required as well as RLS. Clear old column grants too:
-- revoking table grants alone does not remove pre-existing column grants.
revoke all privileges on table public.user_data from public, anon, authenticated;
do $$
declare column_name text;
begin
  for column_name in
    select attname from pg_catalog.pg_attribute
    where attrelid = 'public.user_data'::regclass and attnum > 0 and not attisdropped
  loop
    execute format('revoke all privileges (%I) on table public.user_data from public, anon, authenticated', column_name);
  end loop;
end $$;
grant select on table public.user_data to authenticated;
grant insert (user_id, data) on table public.user_data to authenticated;
grant update (data, updated_at) on table public.user_data to authenticated;

-- Do not delete unknown policies. Restrictive boundaries keep an accidentally
-- broad permissive policy from granting access to another user's rows.
drop policy if exists "user_data_select_own" on public.user_data;
drop policy if exists "user_data_insert_own" on public.user_data;
drop policy if exists "user_data_update_own" on public.user_data;
drop policy if exists "user_data_delete_own" on public.user_data;
drop policy if exists "user_data_owner_boundary" on public.user_data;
drop policy if exists "user_data_no_snapshot_delete" on public.user_data;
create policy "user_data_select_own" on public.user_data for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "user_data_insert_own" on public.user_data for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "user_data_update_own" on public.user_data for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "user_data_owner_boundary" on public.user_data as restrictive for all to public
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id)
  with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);
-- Record deletion/restore is an UPDATE of JSON, never a DELETE of the snapshot.
create policy "user_data_no_snapshot_delete" on public.user_data as restrictive for delete to public using (false);

-- Dedicated, non-elevated functions: do not alter generic functions that another
-- table may use. Reject forged owners rather than silently rewriting their IDs.
create or replace function public.wealth_atlas_guard_owner()
returns trigger as $$
begin
  if new.user_id is null then new.user_id = auth.uid(); end if;
  if auth.uid() is null or new.user_id is distinct from auth.uid() then
    raise insufficient_privilege using message = 'Snapshot owner does not match the authenticated user';
  end if;
  if tg_op = 'UPDATE' and (new.user_id is distinct from old.user_id or new.id is distinct from old.id) then
    raise insufficient_privilege using message = 'Snapshot identity is immutable';
  end if;
  return new;
end;
$$ language plpgsql security invoker set search_path = '';
revoke all on function public.wealth_atlas_guard_owner() from public, anon, authenticated;

drop trigger if exists user_data_set_user_id on public.user_data;
create trigger user_data_set_user_id before insert or update on public.user_data
for each row execute function public.wealth_atlas_guard_owner();

-- New rows are enough: the client subscribes to INSERT/UPDATE as hints, then pulls
-- through RLS. Do not replicate old financial snapshots unnecessarily.
alter table public.user_data replica identity default;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'user_data'
  ) then
    alter publication supabase_realtime add table public.user_data;
  end if;
end $$;

-- 6. 自动维护 updated_at
create or replace function public.wealth_atlas_touch_revision()
returns trigger as $$
begin
  -- A CAS token must advance even for two writes in the same transaction, or a
  -- client's future timestamp. Do not trust a timestamp supplied by the client.
  new.updated_at = greatest(clock_timestamp(), old.updated_at + interval '1 microsecond');
  return new;
end;
$$ language plpgsql security invoker set search_path = '';
revoke all on function public.wealth_atlas_touch_revision() from public, anon, authenticated;

drop trigger if exists user_data_touch on public.user_data;
create trigger user_data_touch before update on public.user_data
for each row execute function public.wealth_atlas_touch_revision();

commit;
