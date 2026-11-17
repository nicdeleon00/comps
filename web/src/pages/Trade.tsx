import { useEffect, useMemo, useState } from 'preact/hooks';
import { Link, navigate, usePageLocation, setQuery } from '../lib/router';
import { get } from '../lib/api';
import { money, ago } from '../lib/format';
import { accountsEnabled, currentUser } from '../lib/supabase';
import type { Card, Holding } from '../lib/types';
import {
  myProfile, saveProfile, traders as loadTraders, traderByHandle, tradersById, matches as loadMatches, listOf, listCounts, whoHas,
  addToList, removeFromList, sharedCollection, offers as loadOffers, sendOffer, respond, messages as loadMessages,
  sendMessage, values, balance, sideTotal, waitingOn, STATUS_LABEL,
  type Trader, type TradeCard, type ListCard, type Offer, type Message, type Match,
} from '../lib/trade';
import { useAccount } from '../components/Account';
import { Thumb } from '../components/Thumb';
import { openPalette } from '../components/Palette';
import { Segmented, Empty, SkRows, Sheet, Field, MoneyInput, GradeBadge, toast } from '../components/ui';
import { IconTrade, IconPlus, IconSearch, IconX, IconChevron, IconStack, IconBack } from '../components/icons';
import { Header } from './shared';

// ---------------------------------------------------------------- shared bits

/** Reloads whenever trading data changes here, or the account changes. */
function useReload(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const bump = () => setN((x) => x + 1);
    addEventListener('comps:trade', bump);
    return () => removeEventListener('comps:trade', bump);
  }, []);
  return n;
}

function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: string | null; loading: boolean } {
  const [state, setState] = useState<{ data: T | undefined; error: string | null; loading: boolean }>({ data: undefined, error: null, loading: true });
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    fn().then((data) => live && setState({ data, error: null, loading: false }))
      .catch((e) => live && setState((s) => ({ data: s.data, error: (e as Error).message, loading: false })));
    return () => { live = false; };
  }, deps);
  return state;
}

const cardOf = (c: TradeCard) => ({ id: c.card_id, name: c.name, game: 'pokemon' as const, image: c.image ?? null, set: c.set_name ?? null, number: c.number ?? null });
const fromCatalog = (c: Card): TradeCard => ({ card_id: c.id, name: c.name, set_name: c.set, number: c.number, image: c.image, variant: c.variant ?? null, condition: 'NM', quantity: 1, value: c.price ?? null });
const fromHolding = (h: Holding): TradeCard => ({
  card_id: h.cardId, name: h.name, set_name: h.setName, number: h.number, image: h.imageUrl ?? h.image, variant: h.variant, grader: h.grader,
  grade: h.grade, condition: h.condition, language: h.language ?? null, quantity: h.quantity, value: h.value, holding_id: h.id,
});
/** The same card (same printing and grade) counts once per side. */
const sameCard = (a: TradeCard, b: TradeCard) => a.card_id === b.card_id && (a.variant ?? null) === (b.variant ?? null) && (a.grader ?? null) === (b.grader ?? null) && (a.grade ?? null) === (b.grade ?? null) && (a.holding_id ?? null) === (b.holding_id ?? null);
const displayName = (t?: Trader | null) => t?.name || (t ? `@${t.handle}` : 'Someone');

function Avatar({ t, size = 40 }: { t?: Trader | null; size?: number }) {
  const letter = (t?.name || t?.handle || '?').slice(0, 1).toUpperCase();
  const hue = [...(t?.handle ?? '?')].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
  return <span class="tr-avatar" style={{ width: size, height: size, fontSize: size * 0.42, '--h': hue }}>{letter}</span>;
}

function CardTile({ c, picked, onPick, onRemove, badge }: { c: TradeCard; picked?: boolean; onPick?: () => void; onRemove?: () => void; badge?: string }) {
  const body = (
    <>
      <span class="tr-tile-art">
        <Thumb card={cardOf(c)} size="lg" banner={c.language === 'zh' ? 'Chinese' : undefined} />
        {picked && <span class="tr-check" aria-hidden="true">✓</span>}
        {badge && <span class="tr-badge">{badge}</span>}
      </span>
      <span class="tr-tile-name">{c.name}</span>
      <span class="tr-tile-meta">
        {c.value != null && <span class="num">{money(c.value)}</span>}
        {c.quantity > 1 && <span class="qty">×{c.quantity}</span>}
        {c.grader && <GradeBadge grader={c.grader} grade={c.grade} />}
      </span>
    </>
  );
  return (
    <div class={`tr-tile ${picked ? 'picked' : ''}`}>
      {onPick ? <button type="button" class="tr-tile-btn" aria-pressed={picked} onClick={onPick}>{body}</button> : <div class="tr-tile-btn static">{body}</div>}
      {onRemove && <button type="button" class="tr-remove" onClick={onRemove} aria-label={`Remove ${c.name}`}><IconX size={13} /></button>}
    </div>
  );
}

/** Fills in today's value for cards that don't have one yet. */
async function withValues(cards: TradeCard[]): Promise<TradeCard[]> {
  const missing = cards.filter((c) => c.value == null);
  if (!missing.length) return cards;
  const v = await values(missing).catch(() => missing.map(() => null));
  const found = new Map(missing.map((c, i) => [c, v[i]]));
  return cards.map((c) => (found.has(c) ? { ...c, value: found.get(c) ?? null } : c));
}

/** Open offers sent to me, for the badge on the Trade tab. */
export function useTradeWaiting(): number {
  const user = useAccount();
  const reload = useReload();
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!accountsEnabled || !user) { setN(0); return; }
    let live = true;
    const check = () => loadOffers().then((list) => live && setN(waitingOn(list, user.id).length)).catch(() => {});
    check();
    const t = setInterval(() => document.visibilityState === 'visible' && check(), 60_000);
    return () => { live = false; clearInterval(t); };
  }, [user?.id, reload]);
  return n;
}

// ---------------------------------------------------------------- the page

type Tab = 'traders' | 'list' | 'offers';

export function TradePage() {
  const user = useAccount();
  const reload = useReload();
  const { query } = usePageLocation();
  const tab = (query.get('tab') as Tab) || 'traders';
  const profile = useAsync(() => (user ? myProfile() : Promise.resolve(null)), [user?.id, reload]);
  const offerList = useAsync(() => (user && profile.data ? loadOffers() : Promise.resolve([] as Offer[])), [user?.id, profile.data?.user_id, reload]);
  const [editing, setEditing] = useState(false);
  const waiting = user ? waitingOn(offerList.data ?? [], user.id).length : 0;

  if (!accountsEnabled) return <div class="page"><Header title="Trade" /><Empty icon={<IconTrade size={26} />} title="Trading needs accounts">The site owner needs to switch accounts on first.</Empty></div>;
  if (!user) {
    return (
      <div class="page">
        <Header title="Trade"><span>Trade cards with other collectors.</span></Header>
        <Empty icon={<IconTrade size={26} />} title="Sign in to trade" action={<Link class="btn primary" href="/settings#account">Sign in</Link>}>
          Trading uses your account, the same one as the iPhone app. Your collection stays private unless you choose to share it.
        </Empty>
      </div>
    );
  }
  if (profile.loading && profile.data === undefined) return <div class="page"><Header title="Trade" /><SkRows n={5} /></div>;
  if (profile.error && !profile.data) {
    return <div class="page"><Header title="Trade" /><Empty icon={<IconTrade size={26} />} title="Trading isn't set up on the server yet">
      {/relation|does not exist|schema cache/i.test(profile.error) ? 'The site owner needs to run the latest supabase/schema.sql in Supabase (SQL Editor).' : profile.error}
    </Empty></div>;
  }
  if (!profile.data || editing) {
    return <div class="page"><ProfileForm existing={profile.data ?? null} onDone={() => setEditing(false)} /></div>;
  }

  const me = profile.data;
  return (
    <div class="page">
      <Header title="Trade" actions={<button class="btn" onClick={() => setEditing(true)}><Avatar t={me} size={22} />@{me.handle}</button>}>
        <span>Trade cards with other collectors. Offer cards and cash, counter, and agree on a deal.</span>
      </Header>
      <div class="toolbar">
        <Segmented value={tab} label="Trade" onChange={(v) => setQuery({ tab: v === 'traders' ? null : v })}
          options={[{ value: 'traders', label: 'Traders' }, { value: 'list', label: 'My list' }, { value: 'offers', label: 'Offers', count: waiting || undefined }]} />
      </div>
      {tab === 'traders' && <TradersTab me={me} reload={reload} />}
      {tab === 'list' && <MyListTab me={me} reload={reload} />}
      {tab === 'offers' && <OffersTab me={me} list={offerList.data} loading={offerList.loading} />}
    </div>
  );
}

// ---------------------------------------------------------------- profile

function ProfileForm({ existing, onDone }: { existing: Trader | null; onDone: () => void }) {
  const user = currentUser();
  const [handle, setHandle] = useState(existing?.handle ?? (user?.email.split('@')[0] ?? '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20));
  const [name, setName] = useState(existing?.name ?? '');
  const [area, setArea] = useState(existing?.area ?? '');
  const [bio, setBio] = useState(existing?.bio ?? '');
  const [share, setShare] = useState(existing?.share_collection ?? false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const valid = /^[a-z0-9_]{3,20}$/.test(handle);
  const submit = async (e: Event) => {
    e.preventDefault();
    if (!valid) { setErr('Usernames are 3–20 lowercase letters, numbers or _.'); return; }
    setBusy(true); setErr('');
    try { await saveProfile({ handle, name, area, bio, share_collection: share }, Boolean(existing)); toast(existing ? 'Profile saved' : 'You’re set up to trade'); onDone(); }
    catch (x) { setErr((x as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <>
      <Header title={existing ? 'Your trading profile' : 'Start trading'}>
        <span>{existing ? 'What other collectors see.' : 'Pick a username other collectors will see. You can change everything later.'}</span>
      </Header>
      <form class="panel tr-form" onSubmit={submit}>
        <Field label="Username" hint="3–20 lowercase letters, numbers or _">
          <div class="input-wrap"><span class="prefix">@</span><input class="input" value={handle} autoCapitalize="none" autoComplete="off" spellcheck={false} maxLength={20}
            onInput={(e) => setHandle((e.target as HTMLInputElement).value.toLowerCase().replace(/[^a-z0-9_]/g, ''))} /></div>
        </Field>
        <Field label="Name (optional)"><input class="input" value={name} maxLength={40} onInput={(e) => setName((e.target as HTMLInputElement).value)} /></Field>
        <Field label="Area (optional)" hint="A city is enough, so people nearby can meet up"><input class="input" value={area} maxLength={40} placeholder="Fort Worth, TX" onInput={(e) => setArea((e.target as HTMLInputElement).value)} /></Field>
        <Field label="About (optional)"><textarea class="input" rows={2} value={bio} maxLength={200} placeholder="What you collect, how you like to trade" onInput={(e) => setBio((e.target as HTMLTextAreaElement).value)} /></Field>
        <label class="tr-share">
          <span>
            <b>Share my collection</b>
            <span class="muted">Other traders can see the cards in your collection (never what you paid or your notes) and ask for any of them.</span>
          </span>
          <span class="switch"><input type="checkbox" checked={share} onChange={(e) => setShare((e.target as HTMLInputElement).checked)} /><span /></span>
        </label>
        {err && <div class="tr-err">{err}</div>}
        <div class="tr-form-actions">
          {existing && <button type="button" class="btn" onClick={onDone}>Cancel</button>}
          <button class="btn primary" disabled={busy || !valid}>{busy ? 'Saving…' : existing ? 'Save' : 'Start trading'}</button>
        </div>
      </form>
    </>
  );
}

// ---------------------------------------------------------------- traders

function TradersTab({ me, reload }: { me: Trader; reload: number }) {
  const all = useAsync(async () => {
    const [list, counts, m] = await Promise.all([loadTraders(), listCounts(), loadMatches().catch(() => [] as Match[])]);
    return { list: list.filter((t) => t.user_id !== me.user_id), counts, matches: new Map(m.map((x) => [x.user_id, x])) };
  }, [reload]);
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<{ card: Card; rows: ListCard[]; traders: Map<string, Trader> } | null>(null);

  const find = () => openPalette({
    placeholder: 'Find a card: who has it for trade?',
    onPick: async (card) => {
      try {
        const rows = (await whoHas(card.id)).filter((r) => r.user_id !== me.user_id);
        const ts = await tradersById([...new Set(rows.map((r) => r.user_id))]);
        setFound({ card, rows, traders: new Map(ts.map((t) => [t.user_id, t])) });
      } catch (e) { toast((e as Error).message); }
    },
  });

  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (all.data?.list ?? []).filter((t) => words.every((w) => `${t.handle} ${t.name ?? ''} ${t.area ?? ''}`.toLowerCase().includes(w)));
  const matched = shown.filter((t) => all.data?.matches.has(t.user_id))
    .sort((a, b) => { const x = all.data!.matches.get(a.user_id)!, y = all.data!.matches.get(b.user_id)!; return (y.they_have + y.they_want) - (x.they_have + x.they_want); });
  const rest = shown.filter((t) => !all.data?.matches.has(t.user_id));

  return (
    <>
      <div class="toolbar">
        <button class="btn primary" onClick={find}><IconSearch size={16} />Find a card</button>
        <span class="spacer" />
        <div class="input-wrap tr-search">
          <span class="prefix"><IconSearch size={14} /></span>
          <input class="input sm" type="search" placeholder="Find a trader" value={search} onInput={(e) => setSearch((e.target as HTMLInputElement).value)} aria-label="Find a trader" />
        </div>
      </div>

      {found && (
        <section class="section tr-found">
          <div class="section-head">
            <h2>Who has {found.card.name}</h2>
            <button class="btn sm" onClick={() => setFound(null)}>Clear</button>
          </div>
          {!found.rows.length && <p class="muted">Nobody has it on their trade list yet. Add it to your wants and you’ll show up in their matches.</p>}
          <div class="tr-people">
            {found.rows.map((r) => {
              const t = found.traders.get(r.user_id);
              return t && (
                <Link class="tr-person" href={`/trade/u/${t.handle}`} key={r.id}>
                  <Avatar t={t} />
                  <span class="tr-person-main"><b>{displayName(t)}</b><span class="muted">@{t.handle}{t.area ? ` · ${t.area}` : ''}</span></span>
                  <span class="tr-person-note">{[r.grader ? `${r.grader} ${r.grade}` : r.condition, r.quantity > 1 ? `×${r.quantity}` : ''].filter(Boolean).join(' · ')}</span>
                  <IconChevron size={15} />
                </Link>
              );
            })}
          </div>
          {!found.rows.length && <button class="btn" onClick={async () => { await addToList('want', [fromCatalog(found.card)]); toast('Added to your wants'); }}><IconPlus size={15} />Add to my wants</button>}
        </section>
      )}

      {all.loading && !all.data && <SkRows n={5} />}
      {all.error && !all.data && <Empty title="Couldn't load traders">{all.error}</Empty>}

      {matched.length > 0 && (
        <section class="section">
          <div class="section-head"><h2>Good matches</h2><span class="muted">Have what you want, or want what you have</span></div>
          <div class="tr-people">{matched.map((t) => <PersonRow t={t} counts={all.data!.counts.get(t.user_id)} match={all.data!.matches.get(t.user_id)} key={t.user_id} />)}</div>
        </section>
      )}
      {all.data && (
        <section class="section">
          <div class="section-head"><h2>{matched.length ? 'Everyone else' : 'Traders'}</h2><span class="muted">{rest.length}</span></div>
          {!rest.length && !matched.length && (
            <Empty icon={<IconTrade size={26} />} title={search ? 'No trader by that name' : 'No other traders yet'}>
              {search ? 'Try another name.' : 'Share the site with friends; once they set up a trading profile they show up here.'}
            </Empty>
          )}
          <div class="tr-people">{rest.map((t) => <PersonRow t={t} counts={all.data!.counts.get(t.user_id)} key={t.user_id} />)}</div>
        </section>
      )}
    </>
  );
}

function PersonRow({ t, counts, match }: { t: Trader; counts?: { have: number; want: number }; match?: Match }) {
  return (
    <Link class="tr-person" href={`/trade/u/${t.handle}`}>
      <Avatar t={t} />
      <span class="tr-person-main">
        <b>{displayName(t)}</b>
        <span class="muted">@{t.handle}{t.area ? ` · ${t.area}` : ''}</span>
        {match && <span class="tr-match">{[match.they_have && `Has ${match.they_have} you want`, match.they_want && `Wants ${match.they_want} you have`].filter(Boolean).join(' · ')}</span>}
      </span>
      <span class="tr-person-note">
        {counts?.have ? `${counts.have} for trade` : t.share_collection ? 'Collection shared' : ''}
        {counts?.want ? <span class="muted"> · {counts.want} wanted</span> : null}
      </span>
      <IconChevron size={15} />
    </Link>
  );
}

// ---------------------------------------------------------------- my list

function MyListTab({ me, reload }: { me: Trader; reload: number }) {
  const [kind, setKind] = useState<'have' | 'want'>('have');
  const list = useAsync(() => listOf(me.user_id), [reload]);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const rows = (list.data ?? []).filter((c) => c.kind === kind);
  const counts = { have: (list.data ?? []).filter((c) => c.kind === 'have').length, want: (list.data ?? []).filter((c) => c.kind === 'want').length };
  const [vals, setVals] = useState<Map<string, number | null>>(new Map());
  useEffect(() => {
    const need = (list.data ?? []).filter((c) => !vals.has(c.id));
    if (!need.length) return;
    values(need).then((v) => setVals((m) => { const n = new Map(m); need.forEach((c, i) => n.set(c.id, v[i])); return n; })).catch(() => {});
  }, [list.data]);
  const total = rows.reduce((n, c) => n + (vals.get(c.id) ?? 0) * c.quantity, 0);

  const addAny = () => openPalette({
    placeholder: kind === 'have' ? 'Add a card you have for trade' : 'Add a card you want',
    onPick: async (c) => { try { await addToList(kind, [fromCatalog(c)]); toast(`Added ${c.name}`); } catch (e) { toast((e as Error).message); } },
  });
  const listEverything = async () => {
    const res = await get<{ items: Holding[] }>('/api/collection?days=30');
    const listed = new Set((list.data ?? []).filter((c) => c.kind === 'have' && c.holding_id).map((c) => c.holding_id));
    const fresh = res.items.filter((h) => !listed.has(h.id)).map(fromHolding);
    if (!fresh.length) { toast('Every card in your collection is already listed'); return; }
    if (!confirm(`List all ${fresh.length} cards from your collection for trade? You can remove any of them later.`)) return;
    setBusy(true);
    try { await addToList('have', fresh); toast(`Listed ${fresh.length} cards`); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const share = async (on: boolean) => {
    try { await saveProfile({ ...me, name: me.name ?? '', area: me.area ?? '', bio: me.bio ?? '', share_collection: on }, true); toast(on ? 'Collection shared with traders' : 'Collection hidden'); }
    catch (e) { toast((e as Error).message); }
  };

  return (
    <>
      <label class="panel tr-share tr-share-panel">
        <span>
          <b>Share my whole collection</b>
          <span class="muted">{me.share_collection ? 'Traders can see every card in your collection and ask for any of them. Never what you paid or your notes.' : 'Off: traders only see the cards on this list. Turn it on so they can browse everything you have.'}</span>
        </span>
        <span class="switch"><input type="checkbox" checked={me.share_collection} onChange={(e) => share((e.target as HTMLInputElement).checked)} /><span /></span>
      </label>

      <div class="toolbar" style={{ marginTop: 20 }}>
        <Segmented value={kind} label="List" onChange={setKind} options={[{ value: 'have', label: 'For trade', count: counts.have }, { value: 'want', label: 'Wanted', count: counts.want }]} />
        <span class="spacer" />
        {kind === 'have' && <button class="btn" onClick={() => setPicking(true)}><IconStack size={16} />From my collection</button>}
        <button class="btn primary" onClick={addAny}><IconPlus size={16} />Any card</button>
      </div>
      <p class="section-note">
        {kind === 'have'
          ? <>Pick from your collection, or add any card from the full card list without scanning. {rows.length > 0 && <b class="num">Worth {money(total)}.</b>}</>
          : 'Cards you’re looking for. Traders who have them show up under Good matches, and they see you want them.'}
      </p>

      {list.loading && !list.data && <SkRows n={4} />}
      {list.data && !rows.length && (
        <Empty icon={<IconTrade size={26} />} title={kind === 'have' ? 'Nothing listed for trade yet' : 'No wants yet'}
          action={kind === 'have' ? <div class="tr-empty-actions"><button class="btn" onClick={() => setPicking(true)}>From my collection</button><button class="btn" disabled={busy} onClick={listEverything}>List my whole collection</button></div> : <button class="btn primary" onClick={addAny}>Add a card</button>}>
          {kind === 'have' ? 'Add the cards you’d trade. Other collectors can then ask for them in an offer.' : 'Add the cards you’re hunting for.'}
        </Empty>
      )}
      <div class="tr-grid">
        {rows.map((c) => (
          <CardTile key={c.id} c={{ ...c, value: vals.get(c.id) ?? null }}
            onRemove={async () => { try { await removeFromList([c.id]); } catch (e) { toast((e as Error).message); } }} />
        ))}
      </div>
      {kind === 'have' && rows.length > 0 && (
        <div class="tr-list-foot">
          <button class="btn sm" disabled={busy} onClick={listEverything}>List my whole collection</button>
          <button class="btn sm" onClick={async () => { if (confirm(`Take all ${rows.length} cards off your trade list?`)) await removeFromList(rows.map((r) => r.id)); }}>Clear the list</button>
        </div>
      )}
      {picking && <CollectionPicker title="Add from your collection" hide={new Set((list.data ?? []).filter((c) => c.kind === 'have' && c.holding_id).map((c) => c.holding_id!))}
        onClose={() => setPicking(false)} onDone={async (cards) => { if (cards.length) { await addToList('have', cards); toast(`Added ${cards.length} card${cards.length === 1 ? '' : 's'}`); } }} />}
    </>
  );
}

/** Choose cards from your own collection (search, tap to pick). */
function CollectionPicker({ title, hide, onClose, onDone, initial = [] }: { title: string; hide?: Set<string>; initial?: TradeCard[]; onClose: () => void; onDone: (cards: TradeCard[]) => void | Promise<void> }) {
  const res = useAsync(() => get<{ items: Holding[] }>('/api/collection?days=30'), []);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set(initial.map((c) => c.holding_id!).filter(Boolean)));
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const items = (res.data?.items ?? []).filter((h) => !hide?.has(h.id)).filter((h) => words.every((w) => `${h.name} ${h.setName ?? ''} ${h.number ?? ''}`.toLowerCase().includes(w)))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  return (
    <Sheet title={title} class="tr-sheet" onClose={onClose} footer={(close) => (
      <>
        <span class="muted tr-picked">{picked.size} picked</span>
        <button class="btn" onClick={close}>Cancel</button>
        <button class="btn primary" disabled={!picked.size} onClick={async () => { await onDone((res.data?.items ?? []).filter((h) => picked.has(h.id)).map(fromHolding)); close(); }}>Add {picked.size || ''}</button>
      </>
    )}>
      <div class="sheet-body">
        <div class="input-wrap tr-search wide"><span class="prefix"><IconSearch size={14} /></span>
          <input class="input sm" type="search" placeholder="Search your cards" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} /></div>
        {res.loading && !res.data && <SkRows n={4} />}
        {res.data && !items.length && <p class="muted" style={{ marginTop: 16 }}>{res.data.items.length ? 'No cards match.' : 'Your collection is empty. Use “Any card” instead.'}</p>}
        <div class="tr-grid compact">
          {items.slice(0, 300).map((h) => <CardTile key={h.id} c={fromHolding(h)} picked={picked.has(h.id)} onPick={() => toggle(h.id)} />)}
        </div>
        {items.length > 300 && <p class="muted">Showing the 300 most valuable. Search to find others.</p>}
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- a trader's page

export function TraderPage({ handle }: { handle: string }) {
  const user = useAccount();
  const reload = useReload();
  const me = useAsync(() => (user ? myProfile() : Promise.resolve(null)), [user?.id, reload]);
  const t = useAsync(() => (user ? traderByHandle(handle) : Promise.resolve(null)), [handle, user?.id, reload]);
  const lists = useAsync(async () => {
    if (!t.data) return null;
    const [list, coll] = await Promise.all([listOf(t.data.user_id), t.data.share_collection ? sharedCollection(t.data.user_id).catch(() => []) : Promise.resolve([] as TradeCard[])]);
    const mine = me.data ? await listOf(me.data.user_id).catch(() => []) : [];
    const haves = await withValues(list.filter((c) => c.kind === 'have'));
    const wants = await withValues(list.filter((c) => c.kind === 'want'));
    const collection = await withValues(coll.map((c) => ({ ...c, holding_id: undefined, id: undefined })));
    return { haves, wants, collection, myWants: new Set(mine.filter((c) => c.kind === 'want').map((c) => c.card_id)), myHaves: new Set(mine.filter((c) => c.kind === 'have').map((c) => c.card_id)) };
  }, [t.data?.user_id, me.data?.user_id, reload]);
  const [tab, setTab] = useState<'have' | 'want' | 'collection'>('have');
  const [picked, setPicked] = useState<TradeCard[]>([]);
  const [composing, setComposing] = useState(false);

  if (!user) return <div class="page"><Empty title="Sign in to see traders" action={<Link class="btn primary" href="/settings#account">Sign in</Link>} /></div>;
  if (t.loading && t.data === undefined) return <div class="page"><SkRows n={5} /></div>;
  if (!t.data) return <div class="page"><Empty icon={<IconTrade size={26} />} title={`No trader called @${handle}`} action={<Link class="btn" href="/trade">All traders</Link>} /></div>;
  const trader = t.data;
  const isMe = me.data?.user_id === trader.user_id;
  const shown = tab === 'have' ? lists.data?.haves : tab === 'want' ? lists.data?.wants : lists.data?.collection;
  const toggle = (c: TradeCard) => setPicked((p) => (p.some((x) => sameCard(x, c)) ? p.filter((x) => !sameCard(x, c)) : [...p, { ...c, quantity: 1 }]));

  return (
    <div class="page">
      <button class="btn sm card-back" onClick={() => navigate('/trade')}><IconBack size={16} />Traders</button>
      <header class="tr-profile">
        <Avatar t={trader} size={64} />
        <div>
          <h1>{displayName(trader)}</h1>
          <div class="muted">@{trader.handle}{trader.area ? ` · ${trader.area}` : ''} · trading since {new Date(trader.created_at).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</div>
          {trader.bio && <p class="tr-bio">{trader.bio}</p>}
        </div>
      </header>

      <div class="toolbar">
        <Segmented value={tab} label="Cards" onChange={setTab} options={[
          { value: 'have', label: 'For trade', count: lists.data?.haves.length },
          { value: 'want', label: 'Wants', count: lists.data?.wants.length },
          ...(trader.share_collection ? [{ value: 'collection' as const, label: 'Collection', count: lists.data?.collection.length }] : []),
        ]} />
      </div>
      {tab !== 'want' && !isMe && <p class="section-note">Tap the cards you’d like, then make an offer. You can also ask for any card, or offer cash.</p>}
      {tab === 'want' && !isMe && <p class="section-note">Cards they’re looking for. The ones marked “On your list” are on your trade list.</p>}

      {lists.loading && !lists.data && <SkRows n={4} />}
      {lists.data && !shown?.length && <Empty icon={<IconTrade size={26} />} title={tab === 'want' ? 'No wants listed' : 'Nothing listed here'}>{!isMe && 'You can still make an offer and ask for any card.'}</Empty>}
      <div class="tr-grid">
        {(shown ?? []).map((c, i) => (
          <CardTile key={(c.id ?? '') + i} c={c}
            picked={tab !== 'want' && picked.some((x) => sameCard(x, c))}
            onPick={tab !== 'want' && !isMe ? () => toggle(c) : undefined}
            badge={tab === 'want' ? (lists.data!.myHaves.has(c.card_id) ? 'On your list' : undefined) : lists.data!.myWants.has(c.card_id) ? 'You want' : undefined} />
        ))}
      </div>

      {!isMe && me.data && (
        <div class="tr-offerbar">
          <span>{picked.length ? <><b>{picked.length}</b> card{picked.length === 1 ? '' : 's'} picked · <span class="num">{money(sideTotal(picked))}</span></> : 'Pick cards, or start an offer'}</span>
          {picked.length > 0 && <button class="btn sm" onClick={() => setPicked([])}>Clear</button>}
          <button class="btn primary" onClick={() => setComposing(true)}>Make an offer</button>
        </div>
      )}
      {composing && me.data && (
        <Composer me={me.data} other={trader} initialGet={picked} theirCards={[...(lists.data?.haves ?? []), ...(lists.data?.collection ?? [])]}
          onClose={() => setComposing(false)} onSent={() => { setPicked([]); navigate('/trade?tab=offers'); }} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- making an offer

type CashMode = 'none' | 'add' | 'ask';

function Composer({ other, initialGive = [], initialGet = [], initialCash = 0, counterOf, theirCards, onClose, onSent }: {
  me: Trader; other: Trader; initialGive?: TradeCard[]; initialGet?: TradeCard[]; initialCash?: number; counterOf?: string;
  theirCards?: TradeCard[]; onClose: () => void; onSent: () => void;
}) {
  const [give, setGive] = useState<TradeCard[]>(initialGive);
  const [getCards, setGet] = useState<TradeCard[]>(initialGet);
  const [cashMode, setCashMode] = useState<CashMode>(initialCash > 0 ? 'add' : initialCash < 0 ? 'ask' : 'none');
  const [cash, setCash] = useState(initialCash ? String(Math.abs(initialCash)) : '');
  const [message, setMessage] = useState('');
  const [picker, setPicker] = useState<null | 'mine' | 'theirs'>(null);
  const [busy, setBusy] = useState(false);
  const [their, setTheir] = useState<TradeCard[] | null>(theirCards ?? null);

  useEffect(() => { withValues(give).then((v) => v !== give && setGive(v)); }, [give.length]);
  useEffect(() => { withValues(getCards).then((v) => v !== getCards && setGet(v)); }, [getCards.length]);
  useEffect(() => {
    if (their) return;
    Promise.all([listOf(other.user_id), other.share_collection ? sharedCollection(other.user_id).catch(() => []) : Promise.resolve([])])
      .then(([l, c]) => setTheir([...l.filter((x) => x.kind === 'have'), ...c.map((x) => ({ ...x, id: undefined, holding_id: undefined }))]))
      .catch(() => setTheir([]));
  }, []);

  const cashValue = cashMode === 'none' ? 0 : (Number(cash) || 0) * (cashMode === 'add' ? 1 : -1);
  const b = balance(give, getCards, cashValue);
  const add = (side: 'give' | 'get', cards: TradeCard[]) => {
    const set = side === 'give' ? setGive : setGet;
    set((cur) => [...cur, ...cards.filter((c) => !cur.some((x) => sameCard(x, c))).map((c) => ({ ...c, quantity: Math.min(c.quantity || 1, 1) || 1 }))]);
  };
  const any = (side: 'give' | 'get') => openPalette({ placeholder: side === 'give' ? 'A card you’ll give' : `A card you want from ${displayName(other)}`, onPick: (c) => add(side, [fromCatalog(c)]) });
  const send = async () => {
    setBusy(true);
    try {
      await sendOffer(other.user_id, give, getCards, cashValue, message, counterOf);
      toast(counterOf ? 'Counteroffer sent' : `Offer sent to ${displayName(other)}`);
      onSent();
    } catch (e) { toast((e as Error).message); setBusy(false); }
  };
  const ready = (give.length > 0 || getCards.length > 0) && !busy;

  if (picker === 'mine') {
    return <CollectionPicker title="Cards you’ll give" initial={give} onClose={() => setPicker(null)} onDone={(cards) => { add('give', cards); }} />;
  }
  return (
    <Sheet title={counterOf ? `Counteroffer to ${displayName(other)}` : `Offer to ${displayName(other)}`} class="tr-sheet wide" onClose={onClose} footer={(close) => (
      <>
        <button class="btn" onClick={close}>Cancel</button>
        <button class="btn primary" disabled={!ready} onClick={send}>{busy ? 'Sending…' : counterOf ? 'Send counteroffer' : 'Send offer'}</button>
      </>
    )}>
      <div class="sheet-body tr-compose">
        <div class="tr-sides">
          <Side title="You give" cards={give} total={sideTotal(give)} onRemove={(c) => setGive((g) => g.filter((x) => x !== c))} onQty={(c, q) => setGive((g) => g.map((x) => (x === c ? { ...x, quantity: q } : x)))}
            actions={<><button class="btn sm" onClick={() => setPicker('mine')}><IconStack size={14} />My collection</button><button class="btn sm" onClick={() => any('give')}><IconPlus size={14} />Any card</button></>} />
          <Side title={`You get from ${displayName(other)}`} cards={getCards} total={sideTotal(getCards)} onRemove={(c) => setGet((g) => g.filter((x) => x !== c))} onQty={(c, q) => setGet((g) => g.map((x) => (x === c ? { ...x, quantity: q } : x)))}
            actions={<><button class="btn sm" onClick={() => any('get')}><IconPlus size={14} />Any card</button></>}
            suggestions={(their ?? []).filter((c) => !getCards.some((x) => sameCard(x, c))).slice(0, 24)} onSuggest={(c) => add('get', [c])} />
        </div>

        <div class="tr-cash">
          <Segmented value={cashMode} label="Cash" onChange={setCashMode} options={[{ value: 'none', label: 'No cash' }, { value: 'add', label: 'I add cash' }, { value: 'ask', label: 'I ask for cash' }]} />
          {cashMode !== 'none' && <MoneyInput value={cash} onValue={setCash} placeholder="0" aria-label="Cash amount" />}
        </div>

        <Balance give={b.give} get={b.get} diff={b.diff} />

        <Field label="Message (optional)">
          <textarea class="input" rows={2} maxLength={500} value={message} placeholder="Condition notes, where to meet, shipping…" onInput={(e) => setMessage((e.target as HTMLTextAreaElement).value)} />
        </Field>
        <p class="muted tr-fine">Values are today’s market prices. {displayName(other)} can accept, decline or send a counteroffer. Nothing changes in either collection.</p>
      </div>
    </Sheet>
  );
}

function Side({ title, cards, total, onRemove, onQty, actions, suggestions, onSuggest }: {
  title: string; cards: TradeCard[]; total: number; onRemove: (c: TradeCard) => void; onQty: (c: TradeCard, q: number) => void;
  actions: preact.ComponentChildren; suggestions?: TradeCard[]; onSuggest?: (c: TradeCard) => void;
}) {
  return (
    <section class="tr-side">
      <div class="tr-side-head"><h4>{title}</h4><span class="num">{money(total)}</span></div>
      {!cards.length && <div class="tr-side-empty muted">No cards yet</div>}
      {cards.map((c, i) => (
        <div class="tr-line" key={c.card_id + i}>
          <Thumb card={cardOf(c)} />
          <div class="tr-line-main">
            <div class="ellipsis"><b>{c.name}</b></div>
            <div class="muted ellipsis">{[c.set_name, c.number && `#${c.number}`, c.grader ? `${c.grader} ${c.grade}` : c.condition].filter(Boolean).join(' · ')}</div>
          </div>
          <select class="select sm tr-qty" value={c.quantity} onChange={(e) => onQty(c, Number((e.target as HTMLSelectElement).value))} aria-label="Copies">
            {Array.from({ length: Math.max(10, c.quantity) }, (_, k) => k + 1).map((n) => <option value={n}>×{n}</option>)}
          </select>
          <span class="num tr-line-val">{c.value != null ? money(c.value * c.quantity) : '—'}</span>
          <button class="btn icon sm" onClick={() => onRemove(c)} aria-label={`Remove ${c.name}`}><IconX size={14} /></button>
        </div>
      ))}
      <div class="tr-side-actions">{actions}</div>
      {suggestions && suggestions.length > 0 && (
        <div class="tr-suggest">
          <div class="muted tr-suggest-title">Their cards</div>
          <div class="tr-suggest-row">
            {suggestions.map((c, i) => (
              <button type="button" class="tr-suggest-card" key={c.card_id + i} onClick={() => onSuggest?.(c)} title={`Add ${c.name}`}>
                <Thumb card={cardOf(c)} size="md" />
                <span class="ellipsis">{c.name}</span>
                {c.value != null && <span class="num muted">{money(c.value)}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function Balance({ give, get, diff }: { give: number; get: number; diff: number }) {
  const total = give + get || 1;
  const even = Math.abs(diff) <= Math.max(1, total * 0.03);
  return (
    <div class="tr-balance">
      <div class="tr-balance-bar" aria-hidden="true">
        <i class="out" style={{ width: `${(give / total) * 100}%` }} />
        <i class="in" style={{ width: `${(get / total) * 100}%` }} />
      </div>
      <div class="tr-balance-text">
        <span>You give <b class="num">{money(give)}</b></span>
        <span class={`tr-verdict ${even ? 'even' : diff > 0 ? 'over' : 'under'}`}>{even ? 'About even' : diff > 0 ? `You give ${money(diff)} more` : `You get ${money(-diff)} more`}</span>
        <span>You get <b class="num">{money(get)}</b></span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- offers

function view(o: Offer, me: string) {
  const sent = o.from_user === me;
  return { sent, other: sent ? o.to_user : o.from_user, youGive: sent ? o.give : o.get, youGet: sent ? o.get : o.give, cashOut: sent ? o.cash : -o.cash };
}

function OffersTab({ me, list, loading }: { me: Trader; list?: Offer[]; loading: boolean }) {
  const [box, setBox] = useState<'received' | 'sent' | 'done'>('received');
  const [open, setOpen] = useState<Offer | null>(null);
  const people = useAsync(() => tradersById([...new Set((list ?? []).flatMap((o) => [o.from_user, o.to_user]))]), [(list ?? []).map((o) => o.id).join()]);
  const byId = useMemo(() => new Map((people.data ?? []).map((t) => [t.user_id, t])), [people.data]);
  const shown = (list ?? []).filter((o) => (box === 'done' ? o.status !== 'open' : o.status === 'open' && (box === 'received' ? o.to_user === me.user_id : o.from_user === me.user_id)));
  const n = (b: typeof box) => (list ?? []).filter((o) => (b === 'done' ? o.status !== 'open' : o.status === 'open' && (b === 'received' ? o.to_user === me.user_id : o.from_user === me.user_id))).length;

  useEffect(() => { if (open) setOpen((list ?? []).find((o) => o.id === open.id) ?? open); }, [list]);

  return (
    <>
      <div class="toolbar">
        <Segmented value={box} label="Offers" onChange={setBox} options={[{ value: 'received', label: 'Received', count: n('received') || undefined }, { value: 'sent', label: 'Sent', count: n('sent') || undefined }, { value: 'done', label: 'Past' }]} />
      </div>
      {loading && !list && <SkRows n={4} />}
      {list && !shown.length && (
        <Empty icon={<IconTrade size={26} />} title={box === 'received' ? 'No offers waiting' : box === 'sent' ? 'No offers out' : 'Nothing here yet'}
          action={box !== 'done' ? <Link class="btn" href="/trade">Browse traders</Link> : undefined}>
          {box === 'received' ? 'Offers other traders send you show up here.' : box === 'sent' ? 'Open a trader, pick cards and make an offer.' : 'Accepted, declined and cancelled offers.'}
        </Empty>
      )}
      <div class="tr-offers">
        {shown.map((o) => {
          const v = view(o, me.user_id);
          const t = byId.get(v.other);
          const b = balance(v.youGive, v.youGet, v.cashOut);
          return (
            <button type="button" class="tr-offer" key={o.id} onClick={() => setOpen(o)}>
              <Avatar t={t} />
              <span class="tr-offer-main">
                <span class="tr-offer-who"><b>{displayName(t)}</b><span class={`tr-status ${o.status}`}>{o.status === 'open' ? (v.sent ? 'Waiting on them' : 'Waiting on you') : STATUS_LABEL[o.status]}</span></span>
                <span class="muted">{o.parent_id ? 'Counteroffer · ' : ''}You give {v.youGive.length} card{v.youGive.length === 1 ? '' : 's'}{v.cashOut > 0 ? ` + ${money(v.cashOut)}` : ''} · get {v.youGet.length}{v.cashOut < 0 ? ` + ${money(-v.cashOut)}` : ''} · {ago(o.updated_at)}</span>
              </span>
              <span class="tr-fan" aria-hidden="true">{[...v.youGet, ...v.youGive].slice(0, 3).map((c, i) => <span style={{ '--i': i }}><Thumb card={cardOf(c)} /></span>)}</span>
              <span class="num tr-offer-val">{money(b.get)}</span>
            </button>
          );
        })}
      </div>
      {open && <OfferSheet o={open} me={me} other={byId.get(view(open, me.user_id).other) ?? null} onClose={() => setOpen(null)} />}
    </>
  );
}

function OfferSheet({ o, me, other, onClose }: { o: Offer; me: Trader; other: Trader | null; onClose: () => void }) {
  const v = view(o, me.user_id);
  const [msgs, setMsgs] = useState<Message[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [countering, setCountering] = useState(false);
  const [youGive, setYouGive] = useState(v.youGive);
  const [youGet, setYouGet] = useState(v.youGet);
  const load = () => loadMessages(o.id).then(setMsgs).catch(() => setMsgs([]));
  useEffect(() => { load(); const t = setInterval(load, 20_000); return () => clearInterval(t); }, [o.id]);
  // Today's values next to the ones saved when the offer was made.
  useEffect(() => {
    const fresh = (cards: TradeCard[]) => values(cards).then((vals) => cards.map((c, i) => ({ ...c, value: vals[i] ?? c.value ?? null }))).catch(() => cards);
    fresh(v.youGive).then(setYouGive); fresh(v.youGet).then(setYouGet);
  }, [o.id]);
  const b = balance(youGive, youGet, v.cashOut);
  const act = async (action: 'accept' | 'decline' | 'cancel') => {
    const verb = { accept: 'Accept', decline: 'Decline', cancel: 'Cancel' }[action];
    if (action !== 'accept' && !confirm(`${verb} this offer?`)) return;
    setBusy(true);
    try { await respond(o.id, action); toast(action === 'accept' ? 'Accepted. Arrange the swap in the messages.' : action === 'decline' ? 'Declined' : 'Offer cancelled'); }
    catch (e) { toast((e as Error).message); }
    finally { setBusy(false); }
  };
  const say = async (e: Event) => {
    e.preventDefault();
    if (!text.trim()) return;
    try { await sendMessage(o.id, text); setText(''); load(); } catch (x) { toast((x as Error).message); }
  };

  if (countering && other) {
    return <Composer me={me} other={other} initialGive={v.youGive} initialGet={v.youGet} initialCash={v.cashOut} counterOf={o.id}
      onClose={() => setCountering(false)} onSent={() => { setCountering(false); onClose(); }} />;
  }
  return (
    <Sheet title={`${v.sent ? 'Your offer to' : 'Offer from'} ${displayName(other)}`} class="tr-sheet wide" onClose={onClose} footer={(close) => (
      o.status !== 'open' ? <button class="btn" onClick={close}>Close</button>
        : v.sent ? <><button class="btn" disabled={busy} onClick={() => act('cancel')}>Cancel offer</button><button class="btn primary" onClick={close}>Done</button></>
        : <>
            <button class="btn" disabled={busy} onClick={() => act('decline')}>Decline</button>
            <button class="btn" disabled={busy || !other} onClick={() => setCountering(true)}>Counter</button>
            <button class="btn primary" disabled={busy} onClick={() => act('accept')}>Accept</button>
          </>
    )}>
      <div class="sheet-body tr-compose">
        <div class="tr-offer-status">
          <span class={`tr-status ${o.status}`}>{o.status === 'open' ? (v.sent ? 'Waiting on them' : 'Waiting on you') : STATUS_LABEL[o.status]}</span>
          <span class="muted">{o.parent_id ? 'Counteroffer · ' : ''}sent {ago(o.created_at)}{o.updated_at !== o.created_at ? ` · updated ${ago(o.updated_at)}` : ''}</span>
          {other && <Link class="tr-link" href={`/trade/u/${other.handle}`} onClick={onClose}>@{other.handle}</Link>}
        </div>
        <div class="tr-sides">
          <ReadSide title="You give" cards={youGive} cash={v.cashOut > 0 ? v.cashOut : 0} />
          <ReadSide title="You get" cards={youGet} cash={v.cashOut < 0 ? -v.cashOut : 0} />
        </div>
        <Balance give={b.give} get={b.get} diff={b.diff} />
        {o.status === 'accepted' && <div class="tr-accepted">Deal agreed. Use the messages to set up the swap. Nothing was moved in either collection: add or remove the cards yourselves once you’ve traded.</div>}

        <div class="tr-thread">
          <h4>Messages</h4>
          {o.message && <Bubble mine={v.sent} body={o.message} at={o.created_at} />}
          {(msgs ?? []).map((m) => <Bubble key={m.id} mine={m.from_user === me.user_id} body={m.body} at={m.created_at} />)}
          {msgs && !msgs.length && !o.message && <p class="muted">No messages yet.</p>}
          <form class="tr-say" onSubmit={say}>
            <input class="input" placeholder={`Message ${displayName(other)}`} maxLength={1000} value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} />
            <button class="btn primary" disabled={!text.trim()}>Send</button>
          </form>
        </div>
      </div>
    </Sheet>
  );
}

function ReadSide({ title, cards, cash }: { title: string; cards: TradeCard[]; cash: number }) {
  return (
    <section class="tr-side">
      <div class="tr-side-head"><h4>{title}</h4><span class="num">{money(sideTotal(cards) + cash)}</span></div>
      {!cards.length && !cash && <div class="tr-side-empty muted">Nothing</div>}
      {cards.map((c, i) => (
        <div class="tr-line" key={c.card_id + i}>
          <Thumb card={cardOf(c)} />
          <div class="tr-line-main">
            <div class="ellipsis"><b>{c.name}</b>{c.quantity > 1 && <span class="qty">×{c.quantity}</span>}</div>
            <div class="muted ellipsis">{[c.set_name, c.number && `#${c.number}`, c.grader ? `${c.grader} ${c.grade}` : c.condition].filter(Boolean).join(' · ')}</div>
          </div>
          <span class="num tr-line-val">{c.value != null ? money(c.value * c.quantity) : '—'}</span>
        </div>
      ))}
      {cash > 0 && <div class="tr-line cash"><span class="tr-cash-icon">$</span><div class="tr-line-main"><b>Cash</b></div><span class="num tr-line-val">{money(cash)}</span></div>}
    </section>
  );
}

function Bubble({ mine, body, at }: { mine: boolean; body: string; at: number }) {
  return <div class={`tr-bubble ${mine ? 'mine' : ''}`}><span>{body}</span><time>{new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></div>;
}
