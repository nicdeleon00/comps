import { useMemo, useState } from 'preact/hooks';
import { useData } from '../lib/api';
import { Link, setHero, useLocation, setQuery } from '../lib/router';
import { money, num, cardHref, cardApi } from '../lib/format';
import type { Card } from '../lib/types';
import { Thumb } from '../components/Thumb';
import { Empty, SkRows } from '../components/ui';
import { IconStack } from '../components/icons';
import { Header, SERIES_OPTIONS, RARITY_OPTIONS } from './shared';

type SetSummary = { id: string; name: string; code: string | null; series: string; released: string | null; cards: number; value: number; top: { id: string; name: string; image: string | null; price: number } | null };
type SetDetail = { set: Omit<SetSummary, 'value' | 'top'>; cards: (Card & { series?: string })[] };

const RARITY_TEST: Record<string, (r: string) => boolean> = {
  sir: (r) => /^Special Illustration/i.test(r),
  ir: (r) => r === 'Illustration Rare',
  hyper: (r) => /Hyper|Secret|Rainbow/i.test(r),
  ultra: (r) => /Ultra|Double Rare|ACE SPEC|Amazing|Radiant|Prism|BREAK|LV\.X/i.test(r),
  holo: (r) => /Holo|Shiny|Shining|Star/i.test(r),
};

export function SetsPage() {
  const { data, loading } = useData<{ items: SetSummary[] }>('/api/sets');
  const { query } = useLocation();
  const series = query.get('series') ?? 'all';
  const groups = useMemo(() => {
    const m = new Map<string, SetSummary[]>();
    for (const s of data?.items ?? []) {
      if (series !== 'all' && s.series !== series) continue;
      if (!m.has(s.series)) m.set(s.series, []);
      m.get(s.series)!.push(s);
    }
    return [...m];
  }, [data, series]);

  return (
    <div class="page">
      <Header title="Sets">
        {data && <span>{num(data.items.length)} English sets, newest first. Value is the sum of every card's raw market price.</span>}
      </Header>
      <div class="toolbar">
        <div class="chips scroll-chips" role="group" aria-label="Era">
          {SERIES_OPTIONS.map((o) => (
            <button type="button" class="chip" aria-pressed={o.value === series} onClick={() => setQuery({ series: o.value })}>{o.label}</button>
          ))}
        </div>
      </div>
      {loading && !data && <SkRows n={8} />}
      {data && !groups.length && <Empty icon={<IconStack size={26} />} title="No sets yet">Sets appear after the first price refresh.</Empty>}
      {groups.map(([name, sets]) => (
        <section class="section">
          <div class="section-head"><h2>{name}</h2><span class="faint" style={{ fontSize: 13 }}>{sets.length} sets</span></div>
          <div class="set-grid">
            {sets.map((s, i) => (
              <Link href={`/sets/${s.id}`} prefetchUrl={`/api/sets/${s.id}`} class="set-card enter" style={{ '--i': i }}>
                <div class="set-art">{s.top && <Thumb card={{ id: s.top.id, name: s.top.name, game: 'pokemon', image: s.top.image }} size="md" />}</div>
                <div class="set-main">
                  <div class="set-name">{s.name}</div>
                  <div class="row-sub">{[s.released?.slice(0, 4), `${s.cards} cards`, s.code].filter(Boolean).join(' · ')}</div>
                  {s.top && <div class="row-sub ellipsis">Top: {s.top.name} · {money(s.top.price)}</div>}
                </div>
                <div class="set-value num">{s.value ? money(s.value, { whole: true }) : '—'}</div>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function SetPage({ id }: { id: string }) {
  const { data, error } = useData<SetDetail>(`/api/sets/${id}`);
  const [rarity, setRarity] = useState('');
  const [sort, setSort] = useState<'price' | 'number'>('price');
  const cards = useMemo(() => {
    let xs = data?.cards ?? [];
    if (rarity && RARITY_TEST[rarity]) xs = xs.filter((c) => RARITY_TEST[rarity](c.rarity ?? ''));
    if (sort === 'number') xs = [...xs].sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
    return xs;
  }, [data, rarity, sort]);
  if (error) return <div class="page"><Empty title="Set not found" /></div>;
  const total = (data?.cards ?? []).reduce((s, c) => s + (c.price ?? 0), 0);

  return (
    <div class="page">
      <Header title={data?.set.name ?? ' '}>
        {data && <>
          <Link href={`/sets?series=${encodeURIComponent(data.set.series)}`} style={{ color: 'var(--accent)' }}>{data.set.series}</Link>
          <span class="faint">·</span><span>{data.set.released?.slice(0, 4) ?? 'Undated'}</span>
          <span class="faint">·</span><span>{data.cards.length} cards</span>
          <span class="faint">·</span><span>{money(total, { whole: true })} for one of each</span>
        </>}
      </Header>
      <div class="toolbar">
        <div class="chips scroll-chips" role="group" aria-label="Rarity">
          {RARITY_OPTIONS.map((o) => <button type="button" class="chip" aria-pressed={o.value === rarity} onClick={() => setRarity(o.value)}>{o.value ? o.label : 'All'}</button>)}
        </div>
        <span class="spacer" />
        <select class="select" value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as 'price' | 'number')} aria-label="Sort">
          <option value="price">Most valuable</option>
          <option value="number">Card number</option>
        </select>
      </div>
      {!data && <SkRows n={6} />}
      <div class="binder">
        {cards.map((c, i) => (
          <Link href={cardHref(c.id)} prefetchUrl={cardApi(c.id)} class="binder-card enter" style={{ '--i': Math.min(i, 24) }} onClick={() => setHero(c.id)}>
            <Thumb card={c} size="lg" />
            <div class="binder-meta">
              <div class="binder-name ellipsis">{c.name}</div>
              <div class="binder-row">
                <span class="faint num">{c.number}{c.total && /^\d/.test(c.number ?? '') ? `/${c.total}` : ''}</span>
                <b class="num">{money(c.price)}</b>
              </div>
              {c.grades?.psa10 && <div class="binder-row faint"><span>PSA 10</span><span class="num">{money(c.grades.psa10)}</span></div>}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
