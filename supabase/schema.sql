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

-- Chinese cards (no market price) carry their language, and a value you set yourself is used
-- instead of the market price. Added later, so they're added to an existing table here too.
alter table public.holdings add column if not exists language text;
alter table public.holdings add column if not exists custom_value numeric;

-- Save changes from a device. A row only overwrites the stored one if it's newer
-- (the same "newest change wins" rule the app and website use). Language and your own
-- value only change when the device sends them, so an older app version that doesn't
-- know about them can't erase them.
create or replace function public.upsert_holdings(items jsonb) returns integer
  language plpgsql security invoker set search_path = public as $$
declare updated integer; inserted integer;
begin
  update public.holdings h set
    card_id = x.e->>'card_id', name = coalesce(x.e->>'name', 'Card'), set_name = x.e->>'set_name', number = x.e->>'number',
    image = x.e->>'image', variant = x.e->>'variant', grader = x.e->>'grader', grade = x.e->>'grade',
    condition = coalesce(nullif(x.e->>'condition', ''), 'NM'), quantity = greatest(1, coalesce((x.e->>'quantity')::integer, 1)),
    cost = (x.e->>'cost')::numeric, acquired_at = x.e->>'acquired_at', notes = x.e->>'notes',
    created_at = coalesce(h.created_at, (x.e->>'created_at')::bigint), updated_at = (x.e->>'updated_at')::bigint,
    deleted = coalesce((x.e->>'deleted')::boolean, false),
    language = case when x.e ? 'language' then x.e->>'language' else h.language end,
    custom_value = case when x.e ? 'custom_value' then (x.e->>'custom_value')::numeric else h.custom_value end
  from jsonb_array_elements(items) as x(e)
  where h.id = (x.e->>'id')::uuid
    and (h.updated_at < (x.e->>'updated_at')::bigint
         or (h.updated_at = (x.e->>'updated_at')::bigint and coalesce((x.e->>'deleted')::boolean, false) and not h.deleted));
  get diagnostics updated = row_count;

  insert into public.holdings (id, user_id, card_id, name, set_name, number, image, variant, grader, grade,
                               condition, quantity, cost, acquired_at, notes, created_at, updated_at, deleted, language, custom_value)
  select (x.e->>'id')::uuid, auth.uid(), x.e->>'card_id', coalesce(x.e->>'name', 'Card'), x.e->>'set_name', x.e->>'number', x.e->>'image',
         x.e->>'variant', x.e->>'grader', x.e->>'grade', coalesce(nullif(x.e->>'condition', ''), 'NM'),
         greatest(1, coalesce((x.e->>'quantity')::integer, 1)), (x.e->>'cost')::numeric, x.e->>'acquired_at', x.e->>'notes',
         (x.e->>'created_at')::bigint, (x.e->>'updated_at')::bigint, coalesce((x.e->>'deleted')::boolean, false),
         x.e->>'language', (x.e->>'custom_value')::numeric
  from jsonb_array_elements(items) as x(e)
  where not exists (select 1 from public.holdings h where h.id = (x.e->>'id')::uuid)
  on conflict (id) do nothing;
  get diagnostics inserted = row_count;
  return updated + inserted;
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

-- ---------------------------------------------------------------- marketplace listings
-- Card listings that people's browsers priced on Facebook Marketplace (with the
-- Comps extension), shared so anyone can see the deals and open the listing to
-- buy. Only listing facts are kept, never who's selling or who reported it.
-- Listings nobody has seen for 30 days are removed.
create table if not exists public.market_listings (
  id text primary key check (id ~ '^fb:[0-9]{5,25}$'),
  card_id text not null check (card_id ~ '^tcg:[0-9]{1,12}$'),
  variant text check (variant is null or length(variant) <= 40),
  grade text check (grade is null or length(grade) <= 12),
  title text not null check (length(title) between 1 and 200),
  price numeric not null check (price > 0 and price < 1000000),
  location text check (location is null or length(location) <= 80),
  confident boolean not null default true,
  status text not null default 'active' check (status in ('active', 'pending', 'sold')),
  first_seen bigint not null default public.now_ms(),
  seen_at bigint not null default public.now_ms()
);
create index if not exists market_listings_seen on public.market_listings (seen_at desc);
create index if not exists market_listings_card on public.market_listings (card_id);
alter table public.market_listings enable row level security;
drop policy if exists "anyone can read" on public.market_listings;
create policy "anyone can read" on public.market_listings for select to anon, authenticated using (true);

-- Reports per hour, to keep a flood of junk out. Only report_listings touches it.
create table if not exists public.market_report_log (hour bigint primary key, n integer not null default 0);
alter table public.market_report_log enable row level security;

-- The extension sends what it saw (up to 100 listings at a time). Bad rows are skipped.
create or replace function public.report_listings(items jsonb) returns integer
  language plpgsql security definer set search_path = public as $$
declare
  saved integer := 0;
  it jsonb;
  hr bigint := public.now_ms() / 3600000;
  used integer;
begin
  if jsonb_typeof(items) <> 'array' or jsonb_array_length(items) > 100 then
    raise exception 'Send a list of up to 100 listings' using errcode = 'check_violation';
  end if;
  insert into market_report_log as l (hour, n) values (hr, jsonb_array_length(items))
    on conflict (hour) do update set n = l.n + excluded.n returning l.n into used;
  if used > 20000 then raise exception 'Too many reports this hour' using errcode = 'check_violation'; end if;
  for it in select * from jsonb_array_elements(items) loop
    begin
      insert into market_listings as m (id, card_id, variant, grade, title, price, location, confident, status)
      values (it->>'id', it->>'card_id', it->>'variant', it->>'grade', left(it->>'title', 200), (it->>'price')::numeric,
              left(it->>'location', 80), coalesce((it->>'confident')::boolean, true), coalesce(it->>'status', 'active'))
      on conflict (id) do update set card_id = excluded.card_id, variant = excluded.variant, grade = excluded.grade,
        title = excluded.title, price = excluded.price, location = coalesce(excluded.location, m.location),
        confident = excluded.confident, status = excluded.status, seen_at = public.now_ms();
      saved := saved + 1;
    exception when check_violation or not_null_violation or invalid_text_representation or numeric_value_out_of_range then
      null; -- skip a bad row, keep the rest
    end;
  end loop;
  delete from market_report_log where hour < hr - 48;
  delete from market_listings where seen_at < public.now_ms() - 30::bigint * 86400000;
  return saved;
end $$;
revoke execute on function public.report_listings(jsonb) from public;
grant execute on function public.report_listings(jsonb) to anon, authenticated;

-- ---------------------------------------------------------------- removed features
-- Drop alerts were taken out; running this file again clears what they stored.
drop table if exists public.drop_events, public.drop_status, public.push_devices, public.watch_items, public.monitor_state;

-- Lets the price-refresh job show the project is in use (free projects pause after a week idle).
create or replace function public.keepalive() returns bigint language sql stable as $$ select public.now_ms() $$;
grant execute on function public.keepalive() to anon, authenticated;
