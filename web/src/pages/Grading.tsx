import { useEffect, useState } from 'preact/hooks';
import { useData, get } from '../lib/api';
import { usePageLocation, setQuery, Link } from '../lib/router';
import { money } from '../lib/format';
import type { Spread, Status } from '../lib/types';
import { Empty, SkRows } from '../components/ui';
import { SpreadRow } from '../components/Rows';
import { IconSlab } from '../components/icons';
import { Header, PokemonFilters } from './shared';

type Res = { items: Spread[]; total: number };

export function GradingPage() {
  const { query } = usePageLocation();
  const series = query.get('series') ?? 'all';
  const rarity = query.get('rarity') ?? '';
  const sort = query.get('sort') ?? 'profit';
  const maxRaw = query.get('maxRaw') ?? '';
  const minVolume = query.get('minVolume') ?? '';
  const params = new URLSearchParams({ limit: '40', sort, minProfit: query.get('all') ? '' : '0' });
  if (series !== 'all') params.set('series', series);
  if (rarity) params.set('rarity', rarity);
  if (maxRaw) params.set('maxRaw', maxRaw);
  if (minVolume) params.set('minVolume', minVolume);
  const url = `/api/spreads?${params}`;
  const { data, loading } = useData<Res>(url);
  const settings = useData<Record<string, any>>('/api/settings');
  const status = useData<Status>('/api/status');
  const [more, setMore] = useState<Spread[]>([]);
  const [draft, setDraft] = useState(maxRaw);
  useEffect(() => setMore([]), [url]);
  useEffect(() => {
    const t = setTimeout(() => draft !== maxRaw && setQuery({ maxRaw: draft }), 400);
    return () => clearTimeout(t);
  }, [draft]);
  const items = [...(data?.items ?? []), ...more];
  const st = settings.data;
  const graded = status.data?.providers.graded ?? status.data?.providers.pricecharting;
  const noPc = status.data && !graded?.on && !status.data.demo;
  const learning = status.data && graded?.on && (graded.cards ?? 0) < 1500;

  return (
    <div class="page">
      <Header title="Raw to Graded">
        <span>Cards that sell for a multiple once slabbed. Expected value uses your fees and era-based gem rates; break-even is the share of 10s you need to not lose money.</span>
      </Header>

      {st && (
        <div class="assumptions">
          <span>Grading <b class="num">{money(st.gradingFee)}</b></span>
          <span>Shipping <b class="num">{money(st.gradingShipping)}</b></span>
          <span>Selling fees <b class="num">{st.sellFeePct}% + {money(st.sellFixed)}</b></span>
          <Link href="/settings#grading" class="more">Edit</Link>
        </div>
      )}

      <div class="toolbar">
        <PokemonFilters series={series} rarity={rarity} onSeries={(v) => setQuery({ series: v })} onRarity={(v) => setQuery({ rarity: v })} />
      </div>
      <div class="toolbar">
        <span class="spacer" />
        <div class="input-wrap" style={{ width: 128 }}>
          <span class="prefix" style={{ fontSize: 13 }}>$</span>
          <input class="input sm num" inputMode="decimal" placeholder="Max raw" value={draft} onInput={(e) => setDraft((e.target as HTMLInputElement).value.replace(/[^0-9.]/g, ''))} aria-label="Maximum raw price" />
        </div>
        <select class="select" value={minVolume} onChange={(e) => setQuery({ minVolume: (e.target as HTMLSelectElement).value })} aria-label="Liquidity">
          <option value="">Any liquidity</option>
          <option value="12">12+ sales / yr</option>
          <option value="52">Weekly sales</option>
          <option value="200">Very liquid</option>
        </select>
        <select class="select" value={sort} onChange={(e) => setQuery({ sort: (e.target as HTMLSelectElement).value })} aria-label="Sort">
          <option value="profit">Highest EV profit</option>
          <option value="roi">Best ROI</option>
          <option value="multiple">Biggest 10 multiple</option>
          <option value="breakEven">Easiest break-even</option>
          <option value="raw">Cheapest raw</option>
        </select>
      </div>

      {loading && !data && <SkRows n={8} />}
      {data && !items.length && (
        <Empty icon={<IconSlab size={26} />} title={noPc ? 'Graded prices need a free key' : learning ? 'Still learning graded prices' : 'No profitable spreads with these filters'}>
          {noPc ? 'Add a free PokemonPriceTracker key (Settings → Prices). Comps then learns PSA, CGC and BGS prices for about 50 cards a day, most valuable first, and remembers them.'
            : learning ? `Graded prices are known for ${graded?.cards ?? 0} cards so far — about 50 more each day, most valuable first. Spreads appear as they're learned.`
            : 'Loosen the filters, or lower your grading costs in Settings if you have a cheaper tier.'}
        </Empty>
      )}
      {items.length > 0 && (
        <div class="spread-head" aria-hidden="true">
          <span>Card</span><span>Multiple</span><span class="sp-be">Break-even</span><span>Profit</span>
        </div>
      )}
      <div class={loading && data ? 'refetching' : ''}>
        {items.map((s, i) => <SpreadRow s={s} i={i} key={s.card.id + s.variant} />)}
      </div>
      {data && items.length < data.total && (
        <div style={{ textAlign: 'center', marginTop: 20 }}>
          <button class="btn" onClick={async () => { const r = await get<Res>(`${url}&offset=${items.length}`); setMore((m) => [...m, ...r.items]); }}>Show more ({data.total - items.length})</button>
        </div>
      )}
    </div>
  );
}
