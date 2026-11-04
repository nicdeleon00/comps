import { useEffect, useState } from 'preact/hooks';
import { useData, get } from '../lib/api';
import { usePageLocation, setQuery } from '../lib/router';
import type { Deal } from '../lib/types';
import { Segmented, Empty, SkRows } from '../components/ui';
import { DealRow } from '../components/Rows';
import { IconTag } from '../components/icons';
import { Header, PokemonFilters } from './shared';

type Res = { items: Deal[]; total: number; counts: Record<string, number> };

const KINDS = [
  { value: 'all', label: 'All' },
  { value: 'listing', label: 'Live listings' },
  { value: 'dip', label: 'Dips' },
  { value: 'ask', label: 'Low asks' },
  { value: 'momentum', label: 'Momentum' },
  { value: 'xmarket', label: 'Cross-market' },
];

export function DealsPage() {
  const { query } = usePageLocation();
  const kind = query.get('kind') ?? 'all';
  const series = query.get('series') ?? 'all';
  const rarity = query.get('rarity') ?? '';
  const sort = query.get('sort') ?? 'score';
  const max = query.get('max') ?? '';
  const params = new URLSearchParams({ limit: '40', sort });
  if (kind !== 'all') params.set('kind', kind);
  if (series !== 'all') params.set('series', series);
  if (rarity) params.set('rarity', rarity);
  if (max) params.set('max', max);
  const url = `/api/deals?${params}`;
  const { data, loading } = useData<Res>(url);
  const [more, setMore] = useState<Deal[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [maxDraft, setMaxDraft] = useState(max);
  useEffect(() => setMore([]), [url]);
  useEffect(() => {
    const t = setTimeout(() => maxDraft !== max && setQuery({ max: maxDraft }), 400);
    return () => clearTimeout(t);
  }, [maxDraft]);

  const items = [...(data?.items ?? []), ...more];
  const counts = data?.counts ?? {};
  const all = Object.values(counts).reduce((a, b) => a + b, 0);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const r = await get<Res>(`${url}&offset=${items.length}`);
      setMore((m) => [...m, ...r.items]);
    } finally { setLoadingMore(false); }
  };

  return (
    <div class="page">
      <Header title="Deals">
        <span>Cards priced under what they're worth, ranked by discount, dollar upside and data confidence.</span>
      </Header>

      <div class="toolbar">
        <Segmented value={kind} scroll label="Deal type" onChange={(v) => setQuery({ kind: v })}
          options={KINDS.map((k) => ({ ...k, count: k.value === 'all' ? all || undefined : counts[k.value] }))} />
      </div>
      <div class="toolbar">
        <PokemonFilters series={series} rarity={rarity} onSeries={(v) => setQuery({ series: v })} onRarity={(v) => setQuery({ rarity: v })} />
      </div>
      <div class="toolbar">
        <span class="spacer" />
        <div class="input-wrap" style={{ width: 130 }}>
          <span class="prefix" style={{ fontSize: 13 }}>$</span>
          <input class="input sm num" inputMode="decimal" placeholder="Max price" value={maxDraft} onInput={(e) => setMaxDraft((e.target as HTMLInputElement).value.replace(/[^0-9.]/g, ''))} aria-label="Maximum price" />
        </div>
        <select class="select" value={sort} onChange={(e) => setQuery({ sort: (e.target as HTMLSelectElement).value })} aria-label="Sort">
          <option value="score">Best score</option>
          <option value="upside">Most upside ($)</option>
          <option value="discount">Deepest discount</option>
          <option value="price">Lowest price</option>
        </select>
      </div>

      {loading && !data && <SkRows n={8} />}
      {data && !items.length && (
        <Empty icon={<IconTag size={26} />} title="Nothing under value here">
          {kind === 'listing'
            ? 'Live listings need an eBay developer key (free). Add it in Settings and the scanner checks listings every few hours.'
            : 'Try another filter. Deals are recomputed after every price refresh.'}
        </Empty>
      )}
      <div class={loading && data ? 'refetching' : ''}>
        {items.map((d, i) => <DealRow d={d} i={i} key={d.id} />)}
      </div>
      {data && items.length < data.total && (
        <div style={{ textAlign: 'center', marginTop: 20 }}>
          <button class="btn" onClick={loadMore} disabled={loadingMore}>{loadingMore ? 'Loading…' : `Show more (${data.total - items.length})`}</button>
        </div>
      )}
    </div>
  );
}
