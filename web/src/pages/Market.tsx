import { useState } from 'preact/hooks';
import { useData } from '../lib/api';
import { Link, setHero } from '../lib/router';
import { money, pct, ago, num, cardHref, cardApi, cardLine } from '../lib/format';
import type { Deal, Spread, Card, Status } from '../lib/types';
import { Thumb } from '../components/Thumb';
import { Segmented, Empty, SkRows } from '../components/ui';
import { SpreadRow, CardRow, dealReason } from '../components/Rows';
import { IconChevron, IconMarket } from '../components/icons';
import { Header } from './shared';

type Market = { status: Status; deals: Deal[]; dealCounts: Record<string, number>; spreads: Spread[]; gainers: Card[]; losers: Card[];
  newest?: { set: { id: string; name: string; series: string; released: string }; cards: Card[] } | null };

function DealTile({ d, i }: { d: Deal; i: number }) {
  return (
    <Link href={cardHref(d.card.id)} prefetchUrl={cardApi(d.card.id)} class="tile enter" style={{ '--i': i }} onClick={() => setHero(d.card.id)}>
      <div class="tile-art"><Thumb card={d.card} size="lg" /></div>
      <div class="tile-body">
        <div class="tile-kind">{d.kindLabel}</div>
        <div class="tile-name ellipsis">{d.card.name}</div>
        <div class="tile-sub ellipsis">{cardLine(d.card)}</div>
        <div class="tile-price">
          <span class="num">{money(d.price)}</span>
          <span class="off-pill">−{pct(d.discount, { signed: false, digits: 0 })}</span>
        </div>
        <div class="tile-sub">worth {money(d.value)}</div>
      </div>
    </Link>
  );
}

export function lastRefresh(s?: Status) {
  const done = s?.jobs.filter((j) => j.finished_at && j.status === 'ok').map((j) => j.finished_at!) ?? [];
  return done.length ? Math.max(...done) : null;
}

export function MarketPage() {
  const { data, loading } = useData<Market>('/api/market', { refresh: 120_000 });
  const [moverTab, setMoverTab] = useState<'up' | 'down'>('up');
  const s = data?.status;
  const refreshed = lastRefresh(s);
  const empty = data && !data.deals.length && !data.spreads.length && !data.gainers.length;

  return (
    <div class="page">
      <Header title="Market" demo={s?.demo}>
        {s && <>
          {!s.demo && <><span>{s.running ? 'Refreshing prices…' : refreshed ? `Updated ${ago(refreshed)}` : 'Waiting for first refresh'}</span><span class="faint">·</span></>}
          <span>{num(s.counts.valued)} prices</span>
          <span class="faint">·</span><span>{num(s.counts.deals)} open deals</span>
        </>}
      </Header>

      {loading && !data && <SkRows n={8} />}

      {empty && (
        <Empty icon={<IconMarket size={26} />} title={s?.running ? 'Pulling prices for the first time' : 'No prices yet'}>
          {s?.running
            ? 'The first refresh downloads the whole catalog. Without a Pokémon TCG API key that takes a few minutes. This page updates on its own.'
            : 'Add API keys in Settings, then refresh. Pokémon, Magic and Yu-Gi-Oh! prices work without any keys.'}
        </Empty>
      )}

      {data && data.deals.length > 0 && (
        <section class="section">
          <div class="section-head">
            <h2>Best deals right now</h2>
            <Link class="more" href="/deals">All deals<IconChevron size={14} /></Link>
          </div>
          <div class="tiles">{data.deals.slice(0, 4).map((d, i) => <DealTile d={d} i={i} />)}</div>
          <ul class="list" style={{ marginTop: 14 }}>
            {data.deals.slice(4, 6).map((d) => (
              <li class="mini-deal">
                <Link href={cardHref(d.card.id)} prefetchUrl={cardApi(d.card.id)} class="row" onClick={() => setHero(d.card.id)}>
                  <Thumb card={d.card} />
                  <div class="row-main"><div class="row-title"><span class="t">{d.card.name}</span></div><div class="row-sub">{dealReason(d)}</div></div>
                  <div class="row-right"><div class="row-value">{money(d.price)}</div><div class="row-meta">−{pct(d.discount, { signed: false, digits: 0 })} vs {money(d.value)}</div></div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data?.newest && data.newest.cards.length > 0 && (
        <section class="section">
          <div class="section-head">
            <h2>Chase cards · {data.newest.set.name}</h2>
            <Link class="more" href={`/sets/${data.newest.set.id}`}>Whole set<IconChevron size={14} /></Link>
          </div>
          <div class="binder chase">
            {data.newest.cards.slice(0, 6).map((c, i) => (
              <Link href={cardHref(c.id)} prefetchUrl={cardApi(c.id)} class="binder-card enter" style={{ '--i': i }} onClick={() => setHero(c.id)}>
                <Thumb card={c} size="lg" />
                <div class="binder-meta">
                  <div class="binder-name ellipsis">{c.name}</div>
                  <div class="binder-row"><span class="faint num">{c.number}{c.total ? `/${c.total}` : ''}</span><b class="num">{money(c.price)}</b></div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {data && (data.spreads.length > 0 || data.gainers.length > 0) && (
        <div class="two-col section">
          <section>
            <div class="section-head">
              <h2>Raw to graded</h2>
              <Link class="more" href="/grading">All spreads<IconChevron size={14} /></Link>
            </div>
            <p class="section-note">Cards where a graded copy sells for far more than a raw one, after grading and selling fees.</p>
            {data.spreads.length ? data.spreads.slice(0, 5).map((sp, i) => <SpreadRow s={sp} i={i} />)
              : <p class="muted" style={{ fontSize: 14 }}>{(s?.providers.graded?.on)
                ? `Learning graded prices — ${s?.providers.graded?.cards ?? 0} cards so far, about 50 more a day.`
                : 'Add a free PokemonPriceTracker key in Settings to get graded prices.'}</p>}
          </section>
          <section>
            <div class="section-head">
              <h2>Movers</h2>
              <Segmented value={moverTab} onChange={setMoverTab} options={[{ value: 'up', label: 'Rising' }, { value: 'down', label: 'Falling' }]} label="Movers" />
            </div>
            <p class="section-note">Biggest seven-day price changes among cards with solid data.</p>
            {(moverTab === 'up' ? data.gainers : data.losers).slice(0, 6).map((c, i) => <CardRow c={c} i={i} key={moverTab + c.id} />)}
            {!(moverTab === 'up' ? data.gainers : data.losers).length && <p class="muted" style={{ fontSize: 14 }}>Movers appear after a few days of price history.</p>}
          </section>
        </div>
      )}
    </div>
  );
}
