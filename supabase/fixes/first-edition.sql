-- One-off fix: set which cards are 1st Edition, for two accounts.
-- Paste into Supabase → SQL Editor. Put the two emails in (each appears in both steps), then Run.
--
-- Step 1 only looks: every card the change will touch, per account.
-- Step 2 makes the change:
--   • her Ekans (Fossil 46/62) becomes 1st Edition;
--   • every other 1st Edition card on either account becomes the regular printing
--     (1st Edition → Normal, 1st Edition Holo → Unlimited Holo).
-- Cards that only come in 1st Edition (the Machamp deck promo, the Aerodactyl prerelease) stay as they are.
-- Each changed card gets a new "last changed" time, so the phones and the website pick it up on their next sync.

-- Step 1: preview (changes nothing).
select u.email, h.name, h.set_name, h.number, h.variant as printing_now, h.quantity
from public.holdings h
join auth.users u on u.id = h.user_id
where not h.deleted
  and lower(u.email) in (lower('YOUR_EMAIL'), lower('HER_EMAIL'))
  and (h.variant like '1stEdition%' or h.card_id = 'tcg:44448')
order by u.email, h.set_name, h.number;

-- Step 2: the change.
do $$
declare
  you uuid := (select id from auth.users where lower(email) = lower('YOUR_EMAIL'));
  her uuid := (select id from auth.users where lower(email) = lower('HER_EMAIL'));
  only_first text[] := array['tcg:42425', 'tcg:107004', 'tcg:154998'];
  ekans int; normal int; holo int;
begin
  if you is null then raise exception 'No account with YOUR_EMAIL: check the email'; end if;
  if her is null then raise exception 'No account with HER_EMAIL: check the email'; end if;

  update public.holdings set variant = '1stEditionNormal', updated_at = public.now_ms()
   where user_id = her and card_id = 'tcg:44448' and not deleted and variant is distinct from '1stEditionNormal';
  get diagnostics ekans = row_count;

  update public.holdings set variant = 'normal', updated_at = public.now_ms()
   where user_id in (you, her) and not deleted and variant = '1stEditionNormal'
     and not (user_id = her and card_id = 'tcg:44448')
     and card_id <> all (only_first);
  get diagnostics normal = row_count;

  update public.holdings set variant = 'unlimitedHolofoil', updated_at = public.now_ms()
   where user_id in (you, her) and not deleted and variant = '1stEditionHolofoil'
     and card_id <> all (only_first);
  get diagnostics holo = row_count;

  raise notice 'Done. Her Ekans set to 1st Edition: %. 1st Edition → Normal: %. 1st Edition Holo → Unlimited Holo: %.', ekans, normal, holo;
end $$;
