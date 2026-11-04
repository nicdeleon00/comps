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

-- Drop watch list: limited to 20 links per person, own rows only.
do $$ begin
  for i in 1..20 loop insert into public.watch_items (url) values ('https://www.walmart.com/ip/' || i); end loop;
  begin
    insert into public.watch_items (url) values ('https://www.walmart.com/ip/21');
    raise exception 'limit not enforced';
  exception when check_violation then null; end;
end $$;
insert into public.push_devices (name, endpoint, p256dh, auth) values ('iPhone', 'https://web.push.apple.com/abc', 'k', 'a');
do $$ begin
  begin insert into public.drop_status (watch_id, user_id, state) select id, user_id, 'in_stock' from public.watch_items limit 1;
        raise exception 'people must not write stock status';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- The monitor (service role) sees everyone's links and writes status; each person reads only theirs.
set role service_role;
do $$ begin if (select count(*) from public.watch_items) <> 20 then raise exception 'monitor should see all links'; end if; end $$;
insert into public.drop_status (watch_id, user_id, state, price) select id, user_id, 'in_stock', 49.99 from public.watch_items order by added_at limit 1;
insert into public.drop_events (user_id, watch_id, at, state, url) select user_id, id, 1, 'in_stock', url from public.watch_items limit 1;
insert into public.monitor_state (id, seen_at, vapid_public_key) values (1, 1, 'BKey') on conflict (id) do update set seen_at = excluded.seen_at;
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$ begin if (select count(*) from public.drop_status) + (select count(*) from public.drop_events) + (select count(*) from public.watch_items) <> 0 then raise exception 'B sees A''s drops'; end if; end $$;
do $$ begin if (select vapid_public_key from public.monitor_state) <> 'BKey' then raise exception 'monitor key should be readable'; end if; end $$;
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
do $$ begin if (select count(*) from public.drop_status) <> 1 then raise exception 'A should see their status'; end if; end $$;
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
