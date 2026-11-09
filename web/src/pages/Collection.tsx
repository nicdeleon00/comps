import { useMemo, useState } from 'preact/hooks';
import { useData, token, STATIC } from '../lib/api';
import { Link, setHero } from '../lib/router';
import { money, pct, signedMoney, GAME_LABEL, cardHref, cardApi } from '../lib/format';
import type { Holding, CollectionSummary, Game } from '../lib/types';
import { Thumb } from '../components/Thumb';
import { AreaChart, type Pt } from '../components/Chart';
import { Segmented, Delta, Counter, GradeBadge, Empty, SkRows, toast } from '../components/ui';
import { HoldingSheet } from '../components/HoldingSheet';
import { openPalette } from '../components/Palette';
import { IconPlus, IconStack, IconPencil, IconHistory, IconDownload } from '../components/icons';
import { downloadBackup } from '../lib/backup';
import { Header } from './shared';
import { useAccount } from '../components/Account';
import { accountsEnabled } from '../lib/supabase';

type Res = { items: Holding[]; summary: CollectionSummary };
const GAMES: Game[] = ['pokemon', 'mtg', 'yugioh', 'sports', 'other'];

export function CollectionPage() {
  const user = useAccount();
  const [days, setDays] = useState('90');
  const { data, loading } = useData<Res>(`/api/collection?days=${days === '0' ? 3650 : days}`);
  const [filter, setFilter] = useState<'all' | 'raw' | 'graded'>('all');
  const [sort, setSort] = useState<'value' | 'gain' | 'recent' | 'name'>('value');
  const [scrub, setScrub] = useState<Pt | null>(null);
  const [sheet, setSheet] = useState<null | { cardId: string; holding?: Holding }>(null);
  const s = data?.summary;

  const items = useMemo(() => {
    let xs = data?.items ?? [];
    if (filter === 'raw') xs = xs.filter((h) => !h.grader);
    if (filter === 'graded') xs = xs.filter((h) => h.grader);
    const gain = (h: Holding) => (h.costBasis != null && h.value != null ? (h.value - h.costBasis) * h.quantity : -Infinity);
    const by = { value: (a: Holding, b: Holding) => (b.total ?? 0) - (a.total ?? 0), gain: (a: Holding, b: Holding) => gain(b) - gain(a), recent: (a: Holding, b: Holding) => b.createdAt - a.createdAt, name: (a: Holding, b: Holding) => a.name.localeCompare(b.name) }[sort];
    return [...xs].sort(by);
  }, [data, filter, sort]);

  const points: Pt[] = (s?.history ?? []).map(([d, v]) => ({ d, v }));
  const first = points[0]?.v;
  const shown = scrub?.v ?? s?.value ?? null;
  const games = s ? GAMES.filter((g) => (s.byGame[g] ?? 0) > 0) : [];
  const add = () => openPalette({ placeholder: 'Find a card to add', onPick: (c) => setSheet({ cardId: c.id }) });

  return (
    <div class="page">
      <Header title="Collection" actions={<>
        <button class="btn" disabled={!data?.items.length} title="Download your whole collection as a JSON and a CSV file"
          onClick={() => data && toast(`Saved ${downloadBackup(data.items)} cards to your Downloads`)}><IconDownload size={17} />Download backup</button>
        <Link class="btn" href="/history"><IconHistory size={17} />History</Link>
        <button class="btn primary" onClick={add}><IconPlus size={17} />Add card</button>
      </>}>
        {s && <span>{s.count} card{s.count === 1 ? '' : 's'} · {s.unique} unique{token() ? '' : ''}</span>}
        {STATIC && <span class="faint">· {user ? 'saved to your account' : 'saved in this browser'}</span>}
      </Header>

      {STATIC && accountsEnabled && !user && (
        <div class="panel signin-banner">
          <div>
            <div class="g-title">Keep your collection in your account</div>
            <div class="g-desc">Sign in to see it on every device and in the iPhone app. Cards here are added to your account.</div>
          </div>
          <Link class="btn primary" href="/settings#account">Sign in</Link>
        </div>
      )}

      {loading && !data && <SkRows n={6} />}

      {data && !data.items.length && (
        <Empty icon={<IconStack size={26} />} title="Your collection is empty" action={<button class="btn primary" onClick={add}><IconPlus size={17} />Add your first card</button>}>
          {STATIC ? (user ? 'Scan cards with the iPhone app (signed in with the same account) or add them by name — they appear everywhere.' : 'Add cards by name, or sign in to see the cards you scan with the iPhone app.') : 'Scan cards with the iPhone app (they sync here), or add them by name.'}
        </Empty>
      )}

      {s && data && data.items.length > 0 && (
        <>
          <div class="portfolio">
            <div class="price-block" style={{ marginTop: 0 }}>
              <div class="price-label">{scrub ? scrub.d : 'Total value'}</div>
              <div class="price-big"><Counter value={shown} /></div>
              <div class="price-deltas">
                {scrub ? <Delta value={first && shown ? shown / first - 1 : null} pill /> : <>
                  <span class={`delta pill ${s.change7d >= 0 ? 'up' : 'down'}`}>{signedMoney(s.change7d)}</span>
                  <Delta value={s.change7dPct} /><span class="muted">7 days</span>
                </>}
              </div>
              {s.gain != null && !scrub && (
                <div class="gain-line" title="Across cards with a purchase price">
                  <span class="muted">Paid {money(s.cost)}</span>
                  <span class={s.gain >= 0 ? 'up' : 'down'} style={{ fontWeight: 600 }}>{signedMoney(s.gain)} ({pct(s.gainPct, { digits: 0 })})</span>
                </div>
              )}
            </div>
            <div class="chart-block">
              <div class="toolbar" style={{ marginBottom: 6 }}>
                <span class="spacer" />
                <Segmented value={days} onChange={setDays} label="Range" options={[{ value: '30', label: '1M' }, { value: '90', label: '3M' }, { value: '180', label: '6M' }, { value: '365', label: '1Y' }]} />
              </div>
              {points.length > 1 ? <AreaChart points={points} height={220} onScrub={setScrub} label="Collection value over time" /> : <div class="chart-empty muted">The chart fills in as price history accumulates.</div>}
            </div>
            {games.length > 1 && (
              <div class="mix">
                <div class="seg-bar" role="img" aria-label={games.map((g) => `${GAME_LABEL[g]} ${money(s.byGame[g])}`).join(', ')}>
                  {games.map((g) => <i style={{ flexGrow: s.byGame[g], background: `var(--c-${g})` }} title={`${GAME_LABEL[g]}: ${money(s.byGame[g])}`} />)}
                </div>
                <div class="legend">
                  {games.map((g) => <span><i style={{ background: `var(--c-${g})` }} />{GAME_LABEL[g]} <b>{money(s.byGame[g])}</b></span>)}
                </div>
              </div>
            )}
          </div>

          <div class="toolbar" style={{ marginTop: 34 }}>
            <Segmented value={filter} onChange={setFilter} label="Filter" options={[{ value: 'all', label: 'All' }, { value: 'raw', label: 'Raw' }, { value: 'graded', label: 'Graded' }]} />
            <span class="spacer" />
            <select class="select" value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as any)} aria-label="Sort">
              <option value="value">Highest value</option>
              <option value="gain">Biggest gain</option>
              <option value="recent">Recently added</option>
              <option value="name">Name</option>
            </select>
          </div>

          <div class="holdings">
            {items.map((h, i) => {
              const gain = h.costBasis != null && h.value != null ? (h.value - h.costBasis) * h.quantity : null;
              const card = { id: h.cardId, name: h.name, game: h.game, image: h.imageUrl, set: h.setName, number: h.number };
              return (
                <div class="row holding-row enter" style={{ '--i': i }} key={h.id}>
                  <Link href={cardHref(h.cardId)} prefetchUrl={cardApi(h.cardId)} class="holding-link" onClick={() => setHero(h.cardId)}>
                    <Thumb card={card} banner={h.language === 'zh' ? 'Chinese' : undefined} />
                    <div class="row-main">
                      <div class="row-title"><span class="t">{h.name}</span>{h.language === 'zh' && <span class="lang-pill">Chinese</span>}{h.quantity > 1 && <span class="qty">×{h.quantity}</span>}</div>
                      <div class="row-sub">{h.setName}{h.number ? ` · #${h.number}` : ''}</div>
                    </div>
                  </Link>
                  <GradeBadge grader={h.grader} grade={h.grade} condition={h.condition} />
                  <div class="row-right h-gain">
                    {gain != null ? <><div class={`row-value ${gain >= 0 ? 'up' : 'down'}`} style={{ fontSize: 14 }}>{signedMoney(gain)}</div><div class="row-meta">paid {money(h.costBasis! * h.quantity)}</div></> : <div class="row-meta">—</div>}
                  </div>
                  <div class="row-right">
                    <div class="row-value">{money(h.total)}</div>
                    <Delta value={h.change7d} />
                  </div>
                  <button class="btn icon sm" onClick={() => setSheet({ cardId: h.cardId, holding: h })} aria-label={`Edit ${h.name}`}><IconPencil size={15} /></button>
                </div>
              );
            })}
          </div>
        </>
      )}

      {sheet && <HoldingSheet cardId={sheet.cardId} holding={sheet.holding} onClose={() => setSheet(null)} />}
    </div>
  );
}
