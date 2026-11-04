-- Comps accounts — paste this whole file into Supabase → SQL Editor → Run.
-- Safe to run again (it only adds what's missing and refreshes functions/policies).
--
-- Everyone who signs up gets their own collection, card watchlist and
-- settings. Row-level security makes each row visible only to its owner.

-- ---------------------------------------------------------------- helpers
create or replace function public.now_ms() returns bigint
  language sql stable as $$ select (extract(epoch from clock_timestamp()) * 1000)::bigint $$;

-- Server-side change time, so devices can ask "what changed since…" without trusting phone clocks.
create or replace function public.touch_synced_at() returns trigger
  language plpgsql as $$ begin new.synced_at := public.now_ms(); return new; end $$;

-- Per-person caps keep the free database small.
create or replace function public.limit_per_user() returns trigger
  language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  execute format('select count(*) from %I.%I where user_id = $1', tg_table_schema, tg_table_name) into n using new.user_id;
  if n >= tg_argv[0]::int then
    raise exception 'Limit reached: % per account', tg_argv[0] using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- collection
create table if not exists public.holdings (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  card_id text not null,
  name text not null default 'Card',
  set_name text,
  number text,
  image text,
  variant text,
  grader text,
  grade text,
  condition text not null default 'NM',
  quantity integer not null default 1 check (quantity between 1 and 9999),
  cost numeric,
  acquired_at text,
  notes text,
  created_at bigint,
  updated_at bigint not null,
  deleted boolean not null default false,
  synced_at bigint not null default public.now_ms()
);
create index if not exists holdings_user_synced on public.holdings (user_id, synced_at);
drop trigger if exists holdings_synced on public.holdings;
create trigger holdings_synced before insert or update on public.holdings
  for each row execute function public.touch_synced_at();
drop trigger if exists holdings_limit on public.holdings;
create trigger holdings_limit before insert on public.holdings
  for each row execute function public.limit_per_user('20000');
alter table public.holdings enable row level security;
drop policy if exists "own holdings" on public.holdings;
create policy "own holdings" on public.holdings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Save changes from a device. A row only overwrites the stored one if it's newer
-- (the same "newest change wins" rule the app and website use).
create or replace function public.upsert_holdings(items jsonb) returns integer
  language plpgsql security invoker set search_path = public as $$
declare n integer;
begin
  insert into public.holdings as h (id, user_id, card_id, name, set_name, number, image, variant, grader, grade,
                                    condition, quantity, cost, acquired_at, notes, created_at, updated_at, deleted)
  select x.id, auth.uid(), x.card_id, coalesce(x.name, 'Card'), x.set_name, x.number, x.image, x.variant, x.grader, x.grade,
         coalesce(nullif(x.condition, ''), 'NM'), greatest(1, coalesce(x.quantity, 1)), x.cost, x.acquired_at, x.notes,
         x.created_at, x.updated_at, coalesce(x.deleted, false)
  from jsonb_to_recordset(items) as x(id uuid, card_id text, name text, set_name text, number text, image text, variant text,
                                      grader text, grade text, condition text, quantity integer, cost numeric, acquired_at text,
                                      notes text, created_at bigint, updated_at bigint, deleted boolean)
  on conflict (id) do update set
    card_id = excluded.card_id, name = excluded.name, set_name = excluded.set_name, number = excluded.number,
    image = excluded.image, variant = excluded.variant, grader = excluded.grader, grade = excluded.grade,
    condition = excluded.condition, quantity = excluded.quantity, cost = excluded.cost, acquired_at = excluded.acquired_at,
    notes = excluded.notes, created_at = coalesce(h.created_at, excluded.created_at), updated_at = excluded.updated_at,
    deleted = excluded.deleted
  where h.updated_at < excluded.updated_at or (h.updated_at = excluded.updated_at and excluded.deleted and not h.deleted);
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.upsert_holdings(jsonb) from public, anon;
grant execute on function public.upsert_holdings(jsonb) to authenticated;

-- ---------------------------------------------------------------- watchlist + settings
create table if not exists public.user_data (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  watchlist jsonb not null default '[]'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  updated_at bigint not null default public.now_ms()
);
alter table public.user_data enable row level security;
drop policy if exists "own data" on public.user_data;
create policy "own data" on public.user_data for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------- removed features
-- Drop alerts were taken out; running this file again clears what they stored.
drop table if exists public.drop_events, public.drop_status, public.push_devices, public.watch_items, public.monitor_state;

-- Lets the price-refresh job show the project is in use (free projects pause after a week idle).
create or replace function public.keepalive() returns bigint language sql stable as $$ select public.now_ms() $$;
grant execute on function public.keepalive() to anon, authenticated;
