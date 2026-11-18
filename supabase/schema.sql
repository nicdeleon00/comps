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

-- ---------------------------------------------------------------- trading
-- Person-to-person trades. Nothing here reads or changes anyone's collection (holdings): a trade
-- list is its own table, and a shared collection is read through trader_collection(), which only
-- returns card facts (never cost, notes or dates) and only when its owner switched sharing on.

-- A trading profile: the name other people see. Readable by anyone signed in.
create table if not exists public.traders (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  handle text not null unique check (handle ~ '^[a-z0-9_]{3,20}$'),
  name text check (name is null or length(name) <= 40),
  area text check (area is null or length(area) <= 40),
  bio text check (bio is null or length(bio) <= 200),
  share_collection boolean not null default false,
  created_at bigint not null default public.now_ms(),
  updated_at bigint not null default public.now_ms()
);
alter table public.traders enable row level security;
drop policy if exists "anyone signed in can read" on public.traders;
create policy "anyone signed in can read" on public.traders for select to authenticated using (true);
drop policy if exists "own profile" on public.traders;
create policy "own profile" on public.traders for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "own profile edit" on public.traders;
create policy "own profile edit" on public.traders for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "own profile delete" on public.traders;
create policy "own profile delete" on public.traders for delete to authenticated using (user_id = auth.uid());

-- Cards someone has for trade ('have') or is looking for ('want'). Picked from their collection
-- (holding_id says which copy) or straight from the card list.
create table if not exists public.trade_cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in ('have', 'want')),
  card_id text not null check (card_id ~ '^tcg:[0-9]{1,12}$'),
  name text not null check (length(name) between 1 and 120),
  set_name text check (set_name is null or length(set_name) <= 80),
  number text check (number is null or length(number) <= 20),
  image text check (image is null or length(image) <= 300),
  variant text check (variant is null or length(variant) <= 40),
  grader text check (grader is null or length(grader) <= 12),
  grade text check (grade is null or length(grade) <= 12),
  condition text not null default 'NM' check (length(condition) <= 12),
  language text check (language is null or length(language) <= 8),
  quantity integer not null default 1 check (quantity between 1 and 999),
  holding_id uuid,
  note text check (note is null or length(note) <= 140),
  created_at bigint not null default public.now_ms()
);
create index if not exists trade_cards_user on public.trade_cards (user_id, kind);
create index if not exists trade_cards_card on public.trade_cards (card_id, kind);
create unique index if not exists trade_cards_holding on public.trade_cards (user_id, kind, holding_id) where holding_id is not null;
drop trigger if exists trade_cards_limit on public.trade_cards;
create trigger trade_cards_limit before insert on public.trade_cards
  for each row execute function public.limit_per_user('20000');
alter table public.trade_cards enable row level security;
drop policy if exists "anyone signed in can read" on public.trade_cards;
create policy "anyone signed in can read" on public.trade_cards for select to authenticated using (true);
drop policy if exists "own trade cards" on public.trade_cards;
create policy "own trade cards" on public.trade_cards for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.traders t where t.user_id = auth.uid()));
drop policy if exists "own trade cards edit" on public.trade_cards;
create policy "own trade cards edit" on public.trade_cards for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "own trade cards delete" on public.trade_cards;
create policy "own trade cards delete" on public.trade_cards for delete to authenticated using (user_id = auth.uid());

-- Offers. `give` is what the sender gives, `get` what they ask for (lists of cards), `cash` is
-- dollars the sender adds (negative: dollars they ask for). A counter is a new offer the other way,
-- and marks the one it answers as 'countered'. Only the functions below write offers.
create table if not exists public.trade_offers (
  id uuid primary key default gen_random_uuid(),
  from_user uuid not null references auth.users (id) on delete cascade,
  to_user uuid not null references auth.users (id) on delete cascade,
  parent_id uuid references public.trade_offers (id) on delete set null,
  status text not null default 'open' check (status in ('open', 'accepted', 'declined', 'cancelled', 'countered')),
  give jsonb not null default '[]'::jsonb,
  get jsonb not null default '[]'::jsonb,
  cash numeric not null default 0 check (cash > -100000 and cash < 100000),
  message text check (message is null or length(message) <= 500),
  created_at bigint not null default public.now_ms(),
  updated_at bigint not null default public.now_ms(),
  check (from_user <> to_user)
);
create index if not exists trade_offers_to on public.trade_offers (to_user, updated_at desc);
create index if not exists trade_offers_from on public.trade_offers (from_user, updated_at desc);
alter table public.trade_offers enable row level security;
drop policy if exists "the two people in it" on public.trade_offers;
create policy "the two people in it" on public.trade_offers for select to authenticated
  using (from_user = auth.uid() or to_user = auth.uid());

-- A conversation under each offer, between the two people in it.
create table if not exists public.trade_messages (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null references public.trade_offers (id) on delete cascade,
  from_user uuid not null default auth.uid() references auth.users (id) on delete cascade,
  body text not null check (length(btrim(body)) between 1 and 1000),
  created_at bigint not null default public.now_ms()
);
create index if not exists trade_messages_offer on public.trade_messages (offer_id, created_at);
alter table public.trade_messages enable row level security;
drop policy if exists "the two people in it" on public.trade_messages;
create policy "the two people in it" on public.trade_messages for select to authenticated
  using (exists (select 1 from public.trade_offers o where o.id = offer_id and auth.uid() in (o.from_user, o.to_user)));
drop policy if exists "write in your own offers" on public.trade_messages;
create policy "write in your own offers" on public.trade_messages for insert to authenticated
  with check (from_user = auth.uid() and exists (select 1 from public.trade_offers o where o.id = offer_id and auth.uid() in (o.from_user, o.to_user)));

-- One card in an offer, cleaned: only these fields, with sane lengths.
create or replace function public.trade_item(it jsonb) returns jsonb
  language plpgsql immutable as $$
begin
  if jsonb_typeof(it) <> 'object' or coalesce(it->>'card_id', '') !~ '^tcg:[0-9]{1,12}$' or coalesce(btrim(it->>'name'), '') = '' then
    raise exception 'Each card needs a card and a name' using errcode = 'check_violation';
  end if;
  return jsonb_strip_nulls(jsonb_build_object(
    'card_id', it->>'card_id', 'name', left(it->>'name', 120), 'set_name', left(it->>'set_name', 80),
    'number', left(it->>'number', 20), 'image', left(it->>'image', 300), 'variant', left(it->>'variant', 40),
    'grader', left(it->>'grader', 12), 'grade', left(it->>'grade', 12), 'condition', left(coalesce(it->>'condition', 'NM'), 12),
    'language', left(it->>'language', 8),
    'quantity', least(greatest(coalesce((it->>'quantity')::int, 1), 1), 999),
    'value', case when (it->>'value') ~ '^[0-9]+(\.[0-9]+)?$' then round((it->>'value')::numeric, 2) end));
end $$;

-- Send an offer (or a counter to an offer you received). Returns the new offer's id.
create or replace function public.make_offer(recipient uuid, give jsonb, get jsonb, cash numeric default 0,
                                             message text default null, counter_of uuid default null) returns uuid
  language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  parent public.trade_offers;
  new_id uuid;
  clean_give jsonb := '[]'::jsonb;
  clean_get jsonb := '[]'::jsonb;
  it jsonb;
begin
  if me is null then raise exception 'Sign in first' using errcode = 'insufficient_privilege'; end if;
  if not exists (select 1 from traders where user_id = me) then raise exception 'Set up your trading profile first' using errcode = 'check_violation'; end if;
  if recipient is null or recipient = me or not exists (select 1 from traders where user_id = recipient) then
    raise exception 'That trader isn''t available' using errcode = 'check_violation';
  end if;
  if jsonb_typeof(coalesce(give, '[]')) <> 'array' or jsonb_typeof(coalesce(get, '[]')) <> 'array'
     or jsonb_array_length(coalesce(give, '[]')) > 40 or jsonb_array_length(coalesce(get, '[]')) > 40 then
    raise exception 'Up to 40 cards on each side' using errcode = 'check_violation';
  end if;
  for it in select * from jsonb_array_elements(coalesce(give, '[]')) loop clean_give := clean_give || jsonb_build_array(trade_item(it)); end loop;
  for it in select * from jsonb_array_elements(coalesce(get, '[]')) loop clean_get := clean_get || jsonb_build_array(trade_item(it)); end loop;
  cash := round(coalesce(cash, 0), 2);
  if jsonb_array_length(clean_give) = 0 and jsonb_array_length(clean_get) = 0 then
    raise exception 'Add at least one card' using errcode = 'check_violation';
  end if;
  if (select count(*) from trade_offers where from_user = me and created_at > public.now_ms() - 3600000) >= 60 then
    raise exception 'Too many offers this hour' using errcode = 'check_violation';
  end if;
  if counter_of is not null then
    select * into parent from trade_offers where id = counter_of for update;
    if parent.id is null or parent.status <> 'open' or parent.to_user <> me or parent.from_user <> recipient then
      raise exception 'That offer can''t be countered any more' using errcode = 'check_violation';
    end if;
    update trade_offers set status = 'countered', updated_at = public.now_ms() where id = counter_of;
  end if;
  insert into trade_offers (from_user, to_user, parent_id, give, get, cash, message)
    values (me, recipient, counter_of, clean_give, clean_get, cash, nullif(left(btrim(coalesce(message, '')), 500), ''))
    returning id into new_id;
  return new_id;
end $$;
revoke execute on function public.make_offer(uuid, jsonb, jsonb, numeric, text, uuid) from public;
grant execute on function public.make_offer(uuid, jsonb, jsonb, numeric, text, uuid) to authenticated;

-- Accept or decline an offer sent to you, or cancel one you sent. Returns the new status.
create or replace function public.respond_offer(offer uuid, action text) returns text
  language plpgsql security definer set search_path = public as $$
declare o public.trade_offers; result text;
begin
  select * into o from trade_offers where id = offer for update;
  if o.id is null or auth.uid() not in (o.from_user, o.to_user) then raise exception 'Offer not found' using errcode = 'check_violation'; end if;
  if o.status <> 'open' then raise exception 'This offer is already %', o.status using errcode = 'check_violation'; end if;
  result := case
    when action = 'accept' and auth.uid() = o.to_user then 'accepted'
    when action = 'decline' and auth.uid() = o.to_user then 'declined'
    when action = 'cancel' and auth.uid() = o.from_user then 'cancelled'
  end;
  if result is null then raise exception 'You can''t % this offer', action using errcode = 'check_violation'; end if;
  update trade_offers set status = result, updated_at = public.now_ms() where id = offer;
  return result;
end $$;
revoke execute on function public.respond_offer(uuid, text) from public;
grant execute on function public.respond_offer(uuid, text) to authenticated;

-- Someone's collection, for trading: card facts only, and only if they chose to share it.
create or replace function public.trader_collection(trader uuid) returns table (
  id uuid, card_id text, name text, set_name text, number text, image text, variant text,
  grader text, grade text, condition text, language text, quantity integer)
  language sql stable security definer set search_path = public as $$
  select h.id, h.card_id, h.name, h.set_name, h.number, h.image, h.variant, h.grader, h.grade, h.condition, h.language, h.quantity
  from holdings h join traders t on t.user_id = h.user_id
  where h.user_id = trader and t.share_collection and not h.deleted and auth.uid() is not null
  order by h.name
  limit 20000
$$;
revoke execute on function public.trader_collection(uuid) from public;
grant execute on function public.trader_collection(uuid) to authenticated;

-- Traders worth a look: who has cards you want, and who wants cards you have (on trade lists).
create or replace function public.trade_matches() returns table (user_id uuid, they_have integer, they_want integer)
  language sql stable security definer set search_path = public as $$
  with mine as (select kind, card_id from trade_cards where user_id = auth.uid()),
  theirs as (select c.user_id, c.kind, c.card_id from trade_cards c where c.user_id <> auth.uid())
  select t.user_id,
         count(distinct t.card_id) filter (where t.kind = 'have' and exists (select 1 from mine m where m.kind = 'want' and m.card_id = t.card_id))::int,
         count(distinct t.card_id) filter (where t.kind = 'want' and exists (select 1 from mine m where m.kind = 'have' and m.card_id = t.card_id))::int
  from theirs t
  group by t.user_id
  having count(*) filter (where exists (select 1 from mine m where m.card_id = t.card_id and m.kind <> t.kind)) > 0
$$;
revoke execute on function public.trade_matches() from public;
grant execute on function public.trade_matches() to authenticated;

-- ---------------------------------------------------------------- removed features
-- Drop alerts were taken out; running this file again clears what they stored.
drop table if exists public.drop_events, public.drop_status, public.push_devices, public.watch_items, public.monitor_state;

-- Lets the price-refresh job show the project is in use (free projects pause after a week idle).
create or replace function public.keepalive() returns bigint language sql stable as $$ select public.now_ms() $$;
grant execute on function public.keepalive() to anon, authenticated;
