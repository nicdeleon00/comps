-- Comps accounts — paste this whole file into Supabase → SQL Editor → Run.
-- Safe to run again (it only adds what's missing and refreshes functions/policies).
--
-- Everyone who signs up gets their own collection, card watchlist, settings,
-- drop watch list and alert devices. Row-level security makes each row
-- visible only to its owner. The drop monitor on your PC uses the
-- service_role key to read everyone's watch lists and write stock status.

-- ---------------------------------------------------------------- helpers
create or replace function public.now_ms() returns bigint
  language sql stable as $$ select (extract(epoch from clock_timestamp()) * 1000)::bigint $$;

-- Server-side change time, so devices can ask "what changed since…" without trusting phone clocks.
create or replace function public.touch_synced_at() returns trigger
  language plpgsql as $$ begin new.synced_at := public.now_ms(); return new; end $$;

-- Per-person caps keep the free database small and the PC monitor fair.
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

-- ---------------------------------------------------------------- drops
create table if not exists public.watch_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  url text not null check (url ~* '^https?://' and length(url) <= 1000),
  name text check (name is null or length(name) <= 200),
  max_price numeric check (max_price is null or max_price > 0),
  added_at bigint not null default public.now_ms(),
  unique (user_id, url)
);
drop trigger if exists watch_items_limit on public.watch_items;
create trigger watch_items_limit before insert on public.watch_items
  for each row execute function public.limit_per_user('20');
alter table public.watch_items enable row level security;
drop policy if exists "own watch items" on public.watch_items;
create policy "own watch items" on public.watch_items for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create table if not exists public.push_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text,
  endpoint text not null check (endpoint ~* '^https://'),
  p256dh text not null,
  auth text not null,
  added_at bigint not null default public.now_ms(),
  unique (user_id, endpoint)
);
drop trigger if exists push_devices_limit on public.push_devices;
create trigger push_devices_limit before insert on public.push_devices
  for each row execute function public.limit_per_user('10');
alter table public.push_devices enable row level security;
drop policy if exists "own devices" on public.push_devices;
create policy "own devices" on public.push_devices for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Written only by the PC monitor (service_role); each person reads their own.
create table if not exists public.drop_status (
  watch_id uuid primary key references public.watch_items (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  state text not null,
  price numeric,
  title text,
  store text,
  note text,
  checked_at bigint,
  changed_at bigint
);
alter table public.drop_status enable row level security;
drop policy if exists "read own status" on public.drop_status;
create policy "read own status" on public.drop_status for select to authenticated using (user_id = auth.uid());

create table if not exists public.drop_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  watch_id uuid references public.watch_items (id) on delete set null,
  at bigint not null,
  state text not null,
  price numeric,
  title text,
  url text not null,
  store text
);
create index if not exists drop_events_user_at on public.drop_events (user_id, at desc);
alter table public.drop_events enable row level security;
drop policy if exists "read own events" on public.drop_events;
create policy "read own events" on public.drop_events for select to authenticated using (user_id = auth.uid());

-- The monitor's heartbeat and the public key phones subscribe to alerts with.
create table if not exists public.monitor_state (
  id integer primary key default 1 check (id = 1),
  seen_at bigint,
  started_at bigint,
  interval_s integer,
  vapid_public_key text,
  version text,
  watching integer
);
alter table public.monitor_state enable row level security;
drop policy if exists "anyone signed in can read" on public.monitor_state;
create policy "anyone signed in can read" on public.monitor_state for select to authenticated using (true);

-- Lets the price-refresh job show the project is in use (free projects pause after a week idle).
create or replace function public.keepalive() returns bigint language sql stable as $$ select public.now_ms() $$;
grant execute on function public.keepalive() to anon, authenticated;
