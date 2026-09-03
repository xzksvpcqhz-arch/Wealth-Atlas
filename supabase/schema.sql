-- Wealth Atlas 云端同步 · Supabase schema（阶段 1：每用户一个完整快照）
-- 直接在 Supabase 项目的 SQL Editor 里整段运行即可；可重复运行（幂等）。

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

-- 3. 策略：每个用户只能读写自己那一行（"各自账户、互不相通"）
drop policy if exists "user_data_select_own" on public.user_data;
drop policy if exists "user_data_insert_own" on public.user_data;
drop policy if exists "user_data_update_own" on public.user_data;
drop policy if exists "user_data_delete_own" on public.user_data;
create policy "user_data_select_own" on public.user_data for select using (auth.uid() = user_id);
create policy "user_data_insert_own" on public.user_data for insert with check (auth.uid() = user_id);
create policy "user_data_update_own" on public.user_data for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "user_data_delete_own" on public.user_data for delete using (auth.uid() = user_id);

-- 4. 自动填 user_id：客户端只 upsert { data }，这一行由登录身份自动补全（防伪造）
create or replace function public.set_user_id()
returns trigger as $$
begin
  new.user_id = auth.uid();
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists user_data_set_user_id on public.user_data;
create trigger user_data_set_user_id before insert on public.user_data
for each row execute function public.set_user_id();

-- 5. 实时同步（Realtime）：让 UPDATE 事件携带完整新行
alter table public.user_data replica identity full;

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
create or replace function public.touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists user_data_touch on public.user_data;
create trigger user_data_touch before update on public.user_data
for each row execute function public.touch_updated_at();
