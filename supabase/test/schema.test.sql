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
select 'all schema tests passed' as result;
