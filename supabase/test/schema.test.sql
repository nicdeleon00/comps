-- Behaviour tests for schema.sql. Each block raises an error on failure.
\set ON_ERROR_STOP on
create function pg_temp.as_user(uid text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', uid, false);
  execute 'set role authenticated';
end $$;

-- Person A saves two cards; person B can't see them.
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select public.upsert_holdings('[
  {"id":"11111111-1111-1111-1111-111111111111","card_id":"tcg:1","name":"Charizard","quantity":2,"updated_at":1000},
  {"id":"22222222-2222-2222-2222-222222222222","card_id":"tcg:2","name":"Pikachu","updated_at":1000}
]'::jsonb);
do $$ begin if (select count(*) from public.holdings) <> 2 then raise exception 'A should see 2 cards'; end if; end $$;
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$ begin if (select count(*) from public.holdings) <> 0 then raise exception 'B must not see A''s cards'; end if; end $$;
-- B can't overwrite A's card through the save function either.
do $$ begin
  begin
    perform public.upsert_holdings('[{"id":"11111111-1111-1111-1111-111111111111","card_id":"tcg:9","name":"Hacked","updated_at":9999}]'::jsonb);
  exception when others then null; end;
end $$;
reset role;
do $$ begin if (select name from public.holdings where id = '11111111-1111-1111-1111-111111111111') <> 'Charizard' then raise exception 'B changed A''s card'; end if; end $$;

-- Newest change wins; an older edit from another device is ignored; deletions travel.
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select public.upsert_holdings('[{"id":"11111111-1111-1111-1111-111111111111","card_id":"tcg:1","name":"Charizard","quantity":5,"updated_at":2000}]'::jsonb);
select public.upsert_holdings('[{"id":"11111111-1111-1111-1111-111111111111","card_id":"tcg:1","name":"Charizard","quantity":1,"updated_at":1500}]'::jsonb);
do $$ begin if (select quantity from public.holdings where id = '11111111-1111-1111-1111-111111111111') <> 5 then raise exception 'older edit should lose'; end if; end $$;
select public.upsert_holdings('[{"id":"22222222-2222-2222-2222-222222222222","card_id":"tcg:2","name":"Pikachu","updated_at":2000,"deleted":true}]'::jsonb);
do $$ begin if not (select deleted from public.holdings where id = '22222222-2222-2222-2222-222222222222') then raise exception 'deletion should apply'; end if; end $$;
-- Chinese cards: language and your own value are saved, and an older app (which doesn't send
-- them) can't erase them; a newer save can clear them.
select public.upsert_holdings('[{"id":"33333333-3333-3333-3333-333333333333","card_id":"tcg:3","name":"Pikachu","updated_at":3000,"language":"zh","custom_value":12.5}]'::jsonb);
do $$ begin if (select language from public.holdings where id = '33333333-3333-3333-3333-333333333333') is distinct from 'zh' then raise exception 'language not saved'; end if; end $$;
select public.upsert_holdings('[{"id":"33333333-3333-3333-3333-333333333333","card_id":"tcg:3","name":"Pikachu","quantity":2,"updated_at":3100}]'::jsonb);
do $$ begin
  if (select quantity from public.holdings where id = '33333333-3333-3333-3333-333333333333') <> 2 then raise exception 'older app edit should apply'; end if;
  if (select language from public.holdings where id = '33333333-3333-3333-3333-333333333333') is distinct from 'zh' then raise exception 'older app erased language'; end if;
  if (select custom_value from public.holdings where id = '33333333-3333-3333-3333-333333333333') is distinct from 12.5 then raise exception 'older app erased value'; end if;
end $$;
select public.upsert_holdings('[{"id":"33333333-3333-3333-3333-333333333333","card_id":"tcg:3","name":"Pikachu","updated_at":3200,"language":null,"custom_value":null}]'::jsonb);
do $$ begin if (select language from public.holdings where id = '33333333-3333-3333-3333-333333333333') is not null then raise exception 'language should clear'; end if; end $$;
-- Server change times move forward so devices can ask for "what changed since…".
do $$ begin if (select min(synced_at) from public.holdings) <= 0 then raise exception 'synced_at not set'; end if; end $$;

-- Watchlist + settings row.
insert into public.user_data (watchlist, settings) values ('[{"cardId":"tcg:1"}]', '{"gradingFee":20}');
do $$ begin if (select settings->>'gradingFee' from public.user_data) <> '20' then raise exception 'user_data'; end if; end $$;

-- Drop alerts were removed: their tables are gone.
reset role;
do $$ begin
  if to_regclass('public.watch_items') is not null or to_regclass('public.monitor_state') is not null then raise exception 'drop tables should be removed'; end if;
end $$;

-- The per-person cap still applies (shown on a small temporary table).
create table public.cap_test (user_id uuid, n int);
create trigger cap_test_limit before insert on public.cap_test for each row execute function public.limit_per_user('2');
insert into public.cap_test values ('00000000-0000-0000-0000-00000000000a', 1), ('00000000-0000-0000-0000-00000000000a', 2);
do $$ begin
  begin insert into public.cap_test values ('00000000-0000-0000-0000-00000000000a', 3); raise exception 'limit not enforced';
  exception when check_violation then null; end;
end $$;
drop table public.cap_test;

-- Marketplace listings: anyone can report and read them; junk rows are skipped; nobody writes the table directly.
set role anon;
select public.report_listings('[
  {"id":"fb:1234567890","card_id":"tcg:517045","variant":"holofoil","title":"Charizard ex SIR 151","price":180,"location":"Austin, TX"},
  {"id":"https://evil.example","card_id":"tcg:1","title":"bad link","price":5},
  {"id":"fb:22222222","card_id":"tcg:1","title":"no price"},
  {"id":"fb:33333333","card_id":"tcg:1","title":"silly price","price":"abc"}
]'::jsonb);
do $$ begin if (select count(*) from public.market_listings) <> 1 then raise exception 'only the good listing should be saved'; end if; end $$;
select public.report_listings('[{"id":"fb:1234567890","card_id":"tcg:517045","title":"Charizard ex SIR 151","price":150,"status":"pending"}]'::jsonb);
do $$ begin
  if (select price from public.market_listings where id = 'fb:1234567890') <> 150 then raise exception 'price update'; end if;
  if (select location from public.market_listings where id = 'fb:1234567890') <> 'Austin, TX' then raise exception 'location kept'; end if;
  if (select status from public.market_listings where id = 'fb:1234567890') <> 'pending' then raise exception 'status update'; end if;
end $$;
do $$ begin
  begin insert into public.market_listings (id, card_id, title, price) values ('fb:99999999', 'tcg:1', 'direct', 1); raise exception 'direct writes must fail';
  exception when insufficient_privilege then null; end;
end $$;
do $$ begin if (select count(*) from public.market_report_log) <> 0 then raise exception 'report log must be private'; end if; end $$;
reset role;

-- Signed-out visitors see nothing.
set role anon;
do $$ begin
  begin perform count(*) from public.holdings; exception when insufficient_privilege then return; end;
  if (select count(*) from public.holdings) <> 0 then raise exception 'anon sees holdings'; end if;
end $$;
select public.keepalive() > 0 as keepalive_ok;
reset role;

-- ---------------------------------------------------------------- trading
-- Without a profile you can't list cards or make offers.
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
do $$ begin
  begin
    insert into public.trade_cards (kind, card_id, name) values ('have', 'tcg:1', 'Charizard');
    raise exception 'listed a card without a profile';
  exception when insufficient_privilege or check_violation then null; end;
end $$;
insert into public.traders (handle, name, area) values ('ash_k', 'Ash', 'Springfield');
insert into public.trade_cards (kind, card_id, name, holding_id) values ('have', 'tcg:1', 'Charizard', '11111111-1111-1111-1111-111111111111');
insert into public.trade_cards (kind, card_id, name) values ('want', 'tcg:50', 'Umbreon VMAX');
-- The same copy from the collection can't be listed twice.
do $$ begin
  begin
    insert into public.trade_cards (kind, card_id, name, holding_id) values ('have', 'tcg:1', 'Charizard', '11111111-1111-1111-1111-111111111111');
    raise exception 'listed the same copy twice';
  exception when unique_violation then null; end;
end $$;
-- Handles: lowercase letters, numbers and _ only, and unique.
do $$ begin
  begin update public.traders set handle = 'Bad Name!' where user_id = auth.uid(); raise exception 'bad handle saved'; exception when check_violation then null; end;
end $$;
reset role;

select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$ begin
  begin insert into public.traders (handle) values ('ash_k'); raise exception 'duplicate handle'; exception when unique_violation then null; end;
end $$;
insert into public.traders (handle, name) values ('misty', 'Misty');
insert into public.trade_cards (kind, card_id, name) values ('have', 'tcg:50', 'Umbreon VMAX'), ('want', 'tcg:1', 'Charizard');
-- B sees A's profile and trade list, but can't change them.
do $$ begin
  if (select count(*) from public.traders) <> 2 then raise exception 'profiles not visible'; end if;
  if (select count(*) from public.trade_cards where user_id = '00000000-0000-0000-0000-00000000000a') <> 2 then raise exception 'trade list not visible'; end if;
end $$;
update public.trade_cards set name = 'Hacked' where user_id = '00000000-0000-0000-0000-00000000000a';
delete from public.trade_cards where user_id = '00000000-0000-0000-0000-00000000000a';
update public.traders set name = 'Hacked' where user_id = '00000000-0000-0000-0000-00000000000a';
reset role;
do $$ begin
  if (select count(*) from public.trade_cards where user_id = '00000000-0000-0000-0000-00000000000a' and name <> 'Hacked') <> 2 then raise exception 'B changed A''s trade list'; end if;
  if (select name from public.traders where handle = 'ash_k') <> 'Ash' then raise exception 'B changed A''s profile'; end if;
end $$;

-- A's collection is private until A shares it, and sharing shows card facts only.
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$ begin if (select count(*) from public.trader_collection('00000000-0000-0000-0000-00000000000a')) <> 0 then raise exception 'collection visible without sharing'; end if; end $$;
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
update public.traders set share_collection = true where user_id = auth.uid();
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$ begin
  if (select count(*) from public.trader_collection('00000000-0000-0000-0000-00000000000a')) <> 2 then raise exception 'shared collection should show A''s 2 live cards'; end if;
  if exists (select 1 from public.trader_collection('00000000-0000-0000-0000-00000000000a') where name = 'Pikachu' and card_id = 'tcg:2') then raise exception 'deleted card shown'; end if;
  if (select count(*) from public.holdings) <> 0 then raise exception 'sharing opened up the holdings table'; end if;
end $$;
-- Matches: B has what A wants, and wants what A has.
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
do $$ declare m record; begin
  select * into m from public.trade_matches();
  if m.user_id <> '00000000-0000-0000-0000-00000000000b' or m.they_have <> 1 or m.they_want <> 1 then raise exception 'match wrong: %', row_to_json(m); end if;
end $$;

-- A offers Charizard + $10 for B's Umbreon. Cards are cleaned (extra fields dropped).
do $$ declare new_id uuid; o record; begin
  new_id := public.make_offer('00000000-0000-0000-0000-00000000000b',
    '[{"card_id":"tcg:1","name":"Charizard","quantity":1,"value":120.5,"secret":"x"}]'::jsonb,
    '[{"card_id":"tcg:50","name":"Umbreon VMAX","value":"130"}]'::jsonb, 10, '  Hi! ');
  select * into o from public.trade_offers where trade_offers.id = new_id;
  if o.status <> 'open' or o.cash <> 10 or o.message <> 'Hi!' then raise exception 'offer saved wrong'; end if;
  if o.give->0 ? 'secret' or (o.give->0->>'value')::numeric <> 120.5 or (o.get->0->>'value')::numeric <> 130 then raise exception 'cards not cleaned: %', o.give; end if;
  perform set_config('test.offer1', new_id::text, false);
end $$;
-- Bad offers are refused: to yourself, empty, a broken card.
do $$ begin
  begin perform public.make_offer('00000000-0000-0000-0000-00000000000a', '[{"card_id":"tcg:1","name":"x"}]'::jsonb, '[]'::jsonb); raise exception 'offer to self'; exception when check_violation then null; end;
  begin perform public.make_offer('00000000-0000-0000-0000-00000000000b', '[]'::jsonb, '[]'::jsonb, 5); raise exception 'empty offer'; exception when check_violation then null; end;
  begin perform public.make_offer('00000000-0000-0000-0000-00000000000b', '[{"card_id":"nope","name":"x"}]'::jsonb, '[]'::jsonb); raise exception 'bad card'; exception when check_violation then null; end;
  begin perform public.make_offer('00000000-0000-0000-0000-00000000000c', '[{"card_id":"tcg:1","name":"x"}]'::jsonb, '[]'::jsonb); raise exception 'offer to someone without a profile'; exception when check_violation then null; end;
end $$;
-- A can't accept their own offer, and can't write offers directly.
do $$ begin
  begin perform public.respond_offer(current_setting('test.offer1')::uuid, 'accept'); raise exception 'sender accepted'; exception when check_violation then null; end;
  begin insert into public.trade_offers (from_user, to_user) values (auth.uid(), '00000000-0000-0000-0000-00000000000b'); raise exception 'direct insert'; exception when insufficient_privilege then null; end;
end $$;
insert into public.trade_messages (offer_id, body) values (current_setting('test.offer1')::uuid, 'Can meet Saturday');
reset role;

-- C (no part in it) sees nothing of the offer or its messages.
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
do $$ begin
  if (select count(*) from public.trade_offers) <> 0 or (select count(*) from public.trade_messages) <> 0 then raise exception 'outsider sees the offer'; end if;
  begin perform public.respond_offer(current_setting('test.offer1')::uuid, 'decline'); raise exception 'outsider declined'; exception when check_violation then null; end;
  begin insert into public.trade_messages (offer_id, body) values (current_setting('test.offer1')::uuid, 'spam'); raise exception 'outsider wrote'; exception when insufficient_privilege then null; end;
end $$;
reset role;

-- B counters: asks for $25 instead. The first offer becomes 'countered'; A then accepts the counter.
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$ declare c uuid; begin
  if (select count(*) from public.trade_messages) <> 1 then raise exception 'B should see the message'; end if;
  c := public.make_offer('00000000-0000-0000-0000-00000000000a', '[{"card_id":"tcg:50","name":"Umbreon VMAX"}]'::jsonb,
                         '[{"card_id":"tcg:1","name":"Charizard"}]'::jsonb, -25, null, current_setting('test.offer1')::uuid);
  perform set_config('test.offer2', c::text, false);
  if (select status from public.trade_offers where id = current_setting('test.offer1')::uuid) <> 'countered' then raise exception 'first offer not countered'; end if;
  begin perform public.respond_offer(current_setting('test.offer1')::uuid, 'accept'); raise exception 'accepted a countered offer'; exception when check_violation then null; end;
end $$;
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
do $$ begin
  if public.respond_offer(current_setting('test.offer2')::uuid, 'accept') <> 'accepted' then raise exception 'accept failed'; end if;
  begin perform public.respond_offer(current_setting('test.offer2')::uuid, 'decline'); raise exception 'changed an accepted offer'; exception when check_violation then null; end;
end $$;
reset role;
-- Trading never touched the collection.
do $$ begin
  if (select count(*) from public.holdings) <> 3 or (select name from public.holdings where id = '11111111-1111-1111-1111-111111111111') <> 'Charizard' then raise exception 'trading changed holdings'; end if;
end $$;
-- Nobody signed out can see trading data.
set role anon;
do $$ begin
  begin
    if (select count(*) from public.traders) + (select count(*) from public.trade_cards) + (select count(*) from public.trade_offers) <> 0 then raise exception 'anon sees trading'; end if;
  exception when insufficient_privilege then null; end;
end $$;
reset role;

select 'all schema tests passed' as result;
