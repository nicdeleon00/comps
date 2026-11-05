import { useEffect, useMemo, useState } from 'preact/hooks';
import { useData, put, del, invalidate } from '../lib/api';
import { getHero, setHero, Link, goBack } from '../lib/router';
import { money, pct, multiple, signedMoney, cardApi, GRADE_LABEL, longDate, ago } from '../lib/format';
import { gradeEV } from '../lib/grading';
import type { CardDetail, Grades, VariantDetail } from '../lib/types';
import { TiltCard } from '../components/Thumb';
import { AreaChart, type Pt } from '../components/Chart';
import { Delta, Segmented, Counter, GradeBadge, Sheet, Field, MoneyInput, toast, Empty } from '../components/ui';
import { HoldingSheet } from '../components/HoldingSheet';
import { dealReason } from '../components/Rows';
import { IconExternal, IconPlus, IconStar, IconStarFill, IconPencil, IconBack } from '../components/icons';
import { ListingRow } from '../components/Marketplace';
import { useListings } from '../lib/marketplace';

const RANGES = [
  { value: '30', label: '1M' },
  { value: '90', label: '3M' },
  { value: '180', label: '6M' },
  { value: '365', label: '1Y' },
  { value: '0', label: 'All' },
];
const LADDER: (keyof Grades | 'raw')[] = ['raw', 'g7', 'g8', 'g9', 'g95', 'psa10', 'bgs10', 'cgc10', 'sgc10'];

function confidenceLabel(c: number | null | undefined, n: number) {
  if (c == null) return '';
  const word = c >= 0.8 ? 'High confidence' : c >= 0.6 ? 'Good confidence' : 'Thin data';
  return `${word} · ${n} source${n === 1 ? '' : 's'}`;
}

function Ladder({ v }: { v: VariantDetail }) {
  const rows = LADDER.map((k) => ({ k, value: k === 'raw' ? v.price : v.grades?.[k] ?? null })).filter((r) => r.value != null) as { k: string; value: number }[];
  if (rows.length < 2) return null;
  const max = Math.max(...rows.map((r) => r.value));
  return (
    <div class="ladder-chart">
      {rows.map((r, i) => (
        <div class="lrow enter" style={{ '--i': i }} title={`${GRADE_LABEL[r.k]}: ${money(r.value)}`}>
          <span class="lname">{GRADE_LABEL[r.k]}</span>
          <span class="lbar"><i style={{ width: `${Math.max(1.5, (r.value / max) * 100)}%` }} class={r.k === 'raw' ? 'raw' : ''} /></span>
          <span class="lval num">{money(r.value)}</span>
          <span class="lmul num faint">{r.k === 'raw' || !v.price ? '' : multiple(r.value / v.price)}</span>
        </div>
      ))}
    </div>
  );
}

function GradingCalc({ d, v }: { d: CardDetail; v: VariantDetail }) {
  const [buy, setBuy] = useState(String(v.price ?? ''));
  const [fee, setFee] = useState(String(d.costs.fee));
  const [ship, setShip] = useState(String(d.costs.shipping));
  const [p10, setP10] = useState(d.rates.p10);
  const [p9, setP9] = useState(d.rates.p9);
  const [p8, setP8] = useState(d.rates.p8);
  useEffect(() => { setBuy(String(v.price ?? '')); }, [v.variant]);
  const ev = useMemo(() => gradeEV(Number(buy) || 0, v.grades ?? {}, { ...d.costs, fee: Number(fee) || 0, shipping: Number(ship) || 0 }, { p10, p9, p8 }), [buy, fee, ship, p10, p9, p8, v]);
  if (!v.grades?.psa10) return null;
  const custom = d.rates.custom;
  const dirty = p10 !== d.rates.p10 || p9 !== d.rates.p9 || p8 !== d.rates.p8;
  const save = async () => {
    await put(`${cardApi(d.card.id)}/gem-rates`, { p10, p9, p8 });
    invalidate('/api/');
    toast('Gem rates saved for this card');
  };
  const reset = async () => {
    await del(`${cardApi(d.card.id)}/gem-rates`);
    invalidate('/api/');
    toast('Back to era defaults');
  };
  const slider = (label: string, val: number, set: (n: number) => void, max = 1) => (
    <label class="slider">
      <span class="sl-top"><span>{label}</span><b class="num">{Math.round(val * 100)}%</b></span>
      <input type="range" min={0} max={max} step={0.01} value={val} style={{ '--p': `${(val / max) * 100}%` }} onInput={(e) => set(Number((e.target as HTMLInputElement).value))} />
    </label>
  );
  return (
    <section class="section">
      <div class="section-head"><h2>Should you grade it?</h2></div>
      <p class="section-note">
        {custom ? 'Using your saved gem rates for this card.' : `Starting from ${d.rates.era} era gem rates — adjust if you know the population report.`}
      </p>
      <div class="calc panel">
        <div class="calc-inputs">
          <div class="calc-row3">
            <Field label="You pay"><MoneyInput value={buy} onValue={setBuy} /></Field>
            <Field label="Grading fee"><MoneyInput value={fee} onValue={setFee} /></Field>
            <Field label="Shipping & ins."><MoneyInput value={ship} onValue={setShip} /></Field>
          </div>
          {slider('Chance of a 10', p10, (n) => { setP10(n); if (n + p9 + p8 > 1) setP9(Math.max(0, 1 - n - p8)); })}
          {slider('Chance of a 9', p9, (n) => setP9(Math.min(n, 1 - p10)), 1)}
          {slider('Chance of an 8', p8, (n) => setP8(Math.min(n, 1 - p10 - p9)), 1)}
          <div class="calc-actions">
            {dirty && <button class="btn sm primary" onClick={save}>Save for this card</button>}
            {custom && !dirty && <button class="btn sm" onClick={reset}>Reset to era defaults</button>}
            <span class="faint" style={{ fontSize: 12 }}>Selling fees {(d.costs.sellFeePct * 100).toFixed(2)}% + {money(d.costs.sellFixed)} · <Link href="/settings#grading" style={{ color: 'var(--accent)' }}>change</Link></span>
          </div>
        </div>
        {ev && (
          <div class="calc-out">
            <div class="kpi">
              <span>Expected profit</span>
              <b class={ev.profit >= 0 ? 'up' : 'down'}><Counter value={ev.profit} format={signedMoney} /></b>
              <small>{pct(ev.roi, { digits: 0 })} return on {money(ev.cost)}</small>
            </div>
            <div class="kpi-grid">
              <div><span>Break-even</span><b>{ev.breakEven == null ? 'Never' : ev.breakEven <= 0.005 ? 'Any grade' : `${Math.round(ev.breakEven * 100)}% 10s`}</b></div>
              <div><span>If it's a 10</span><b class={ev.if10 >= 0 ? 'up' : 'down'}>{signedMoney(ev.if10)}</b></div>
            </div>
            <table class="outcomes">
              <thead><tr><th>Grade</th><th>Chance</th><th>Sells for</th><th>You net</th></tr></thead>
              <tbody>
                {ev.outcomes.map((o) => (
                  <tr><td>{o.grade}</td><td class="num">{Math.round(o.p * 100)}%</td><td class="num">{money(o.value)}</td><td class={`num ${o.net - ev.cost >= 0 ? 'up' : 'down'}`}>{money(o.net)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

/** Copies of this card for sale on Facebook Marketplace (found by people running the Comps extension). */
function MarketplaceListings({ cardId }: { cardId: string }) {
  const { items } = useListings(cardId);
  const live = (items ?? []).filter((l) => l.status === 'active' || l.status === 'pending').sort((a, b) => a.price - b.price);
  if (!live.length) return null;
  return (
    <section class="section">
      <div class="section-head"><h2>For sale on Facebook Marketplace</h2><span class="faint" style={{ fontSize: 13 }}>{live.length} listing{live.length === 1 ? '' : 's'}</span></div>
      <div class="mp-list compact">{live.map((l) => <ListingRow l={l} compact />)}</div>
    </section>
  );
}

function WatchSheet({ d, variant, onClose }: { d: CardDetail; variant: string; onClose: () => void }) {
  const cur = d.watch.find((w) => w.variant === variant);
  const [target, setTarget] = useState(cur?.target != null ? String(cur.target) : '');
  return (
    <Sheet title={cur ? 'Watching' : 'Watch this card'} onClose={onClose}
      footer={(close) => (
        <>
          {cur && <button class="btn" style={{ color: 'var(--down)', marginRight: 'auto' }} onClick={async () => { await del(`/api/watchlist/${encodeURIComponent(d.card.id)}?variant=${variant}`); invalidate('/api/'); toast('Stopped watching'); close(); }}>Stop watching</button>}
          <button class="btn" onClick={close}>Cancel</button>
          <button class="btn primary" onClick={async () => { await put('/api/watchlist', { cardId: d.card.id, variant, target: target || null }); invalidate('/api/'); toast('Added to watchlist'); close(); }}>Save</button>
        </>
      )}>
      <div class="sheet-body">
        <p class="muted" style={{ marginTop: 0, fontSize: 14 }}>Watched cards are scanned for live listings first. Set a target and the watchlist flags it when the market gets there.</p>
        <Field label="Target price (optional)"><MoneyInput value={target} onValue={setTarget} placeholder={d.variants[0]?.price ? String(Math.round(d.variants[0].price * 0.85)) : ''} /></Field>
      </div>
    </Sheet>
  );
}

export function CardPage({ id, panel = false }: { id: string; panel?: boolean }) {
  const { data: d, error } = useData<CardDetail>(cardApi(id));
  const [variant, setVariant] = useState<string | null>(null);
  const [series, setSeries] = useState<'raw' | 'g9' | 'psa10'>('raw');
  const [range, setRange] = useState('90');
  const [scrub, setScrub] = useState<Pt | null>(null);
  const [sheet, setSheet] = useState<null | 'add' | 'watch' | { edit: string }>(null);
  const hero = getHero() === id;
  useEffect(() => () => setHero(null), []);

  const v = d ? d.variants.find((x) => x.variant === variant) ?? d.variants[0] : null;
  const points: Pt[] = useMemo(() => {
    if (!d || !v) return [];
    const idx = series === 'raw' ? 1 : series === 'g9' ? 2 : 3;
    const all = (d.history[v.variant] ?? []).filter((r) => r[idx] != null).map((r) => ({ d: r[0], v: r[idx] as number }));
    const n = Number(range);
    if (!n) return all;
    const cutoff = new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    return all.filter((p) => p.d >= cutoff);
  }, [d, v?.variant, series, range]);

  if (error) return <div class="page"><Empty title="Card not found">It may have dropped out of the catalog.</Empty></div>;

  const c = d?.card ?? null;
  const current = v ? (series === 'raw' ? v.price : series === 'g9' ? v.grades?.g9 : v.grades?.psa10) ?? null : null;
  const first = points[0]?.v;
  const shown = scrub?.v ?? current;
  const rangeChange = first && shown ? shown / first - 1 : null;
  const watched = d && v ? d.watch.some((w) => w.variant === v.variant) : false;
  const seriesOpts = [{ value: 'raw' as const, label: 'Raw' }];
  if (v?.grades?.g9) seriesOpts.push({ value: 'g9' as any, label: 'PSA 9' });
  if (v?.grades?.psa10) seriesOpts.push({ value: 'psa10' as any, label: 'PSA 10' });

  return (
    <div class={`page card-page ${panel ? 'in-panel' : ''}`}>
      {!panel && <button class="btn sm card-back" onClick={() => goBack('/')}><IconBack size={16} />Back</button>}
      <div class="card-layout">
        <aside class="card-aside">
          {c ? <TiltCard card={c} hero={hero} /> : <div class="sk" style={{ width: '100%', aspectRatio: '63/88', borderRadius: 14 }} />}
          {d && (
            <div class="aside-actions">
              <button class="btn primary" onClick={() => setSheet('add')}><IconPlus size={17} />Add to collection</button>
              <button class={`btn icon ${watched ? 'watching' : ''}`} onClick={() => setSheet('watch')} aria-label={watched ? 'Watching' : 'Watch'} title={watched ? 'Watching' : 'Watch'}>
                {watched ? <IconStarFill size={18} /> : <IconStar size={18} />}
              </button>
            </div>
          )}
          {d && (
            <nav class="ext-links">
              {d.links.ebay && <a href={d.links.ebay} target="_blank" rel="noopener noreferrer">eBay listings<IconExternal size={14} /></a>}
              {d.links.ebaySold && <a href={d.links.ebaySold} target="_blank" rel="noopener noreferrer">eBay sold<IconExternal size={14} /></a>}
              {d.links.ebayGraded && <a href={d.links.ebayGraded} target="_blank" rel="noopener noreferrer">Graded on eBay<IconExternal size={14} /></a>}
              {d.links.tcgplayer && <a href={d.links.tcgplayer} target="_blank" rel="noopener noreferrer">TCGplayer<IconExternal size={14} /></a>}
              {d.links.cardmarket && <a href={d.links.cardmarket} target="_blank" rel="noopener noreferrer">Cardmarket<IconExternal size={14} /></a>}
              {d.links.scryfall && <a href={d.links.scryfall} target="_blank" rel="noopener noreferrer">Scryfall<IconExternal size={14} /></a>}
              {d.links.pricecharting && <a href={d.links.pricecharting} target="_blank" rel="noopener noreferrer">PriceCharting<IconExternal size={14} /></a>}
            </nav>
          )}
        </aside>

        <div class="card-main">
          {c ? (
            <div class="title-block fade">
              <div class="eyebrow">{c.series ?? d?.set?.series ?? 'Pokémon'}{c.year ? ` · ${c.year}` : ''}{c.rarity ? ` · ${c.rarity}` : ''}</div>
              <h1>{c.name}</h1>
              <div class="muted">
                {d?.set ? <Link href={`/sets/${d.set.id}`} style={{ color: 'var(--accent)' }}>{c.set}</Link> : c.set}
                {c.number ? ` · ${c.total ? `${c.number}/${c.total}` : `#${c.number}`}` : ''}
              </div>
            </div>
          ) : (
            <div><div class="sk" style={{ width: 120, height: 12, marginBottom: 12 }} /><div class="sk" style={{ width: '60%', height: 32, marginBottom: 10 }} /><div class="sk" style={{ width: '40%', height: 14 }} /></div>
          )}

          {d && d.variants.length > 1 && (
            <div style={{ marginTop: 18 }}>
              <Segmented value={v!.variant} scroll label="Printing" onChange={(x) => { setVariant(x); setSeries('raw'); }}
                options={d.variants.map((x) => ({ value: x.variant, label: x.label || 'Standard' }))} />
            </div>
          )}

          {v && (
            <div class="price-block">
              <div class="price-label">{scrub ? longDate(scrub.d) : series === 'raw' ? 'Market value, raw' : series === 'g9' ? 'PSA 9 value' : 'PSA 10 value'}</div>
              <div class="price-big"><Counter value={shown} /></div>
              <div class="price-deltas">
                {scrub ? <Delta value={rangeChange} pill /> : <>
                  <Delta value={series === 'raw' ? v.change7d : rangeChange} pill /><span class="muted">{series === 'raw' ? '7 days' : 'in range'}</span>
                  {series === 'raw' && v.change30d != null && <><Delta value={v.change30d} /><span class="muted">30 days</span></>}
                </>}
              </div>
              {series === 'raw' && <div class="faint" style={{ fontSize: 12.5, marginTop: 6 }}>{confidenceLabel(v.confidence, v.sources.length)}{v.priceLow ? ` · lowest ask ${money(v.priceLow)}` : ''}</div>}
            </div>
          )}

          {v && (
            <div class="chart-block">
              <div class="toolbar" style={{ marginBottom: 6 }}>
                {seriesOpts.length > 1 && <Segmented value={series} options={seriesOpts} onChange={(x) => setSeries(x as any)} label="Series" />}
                <span class="spacer" />
                <Segmented value={range} options={RANGES} onChange={setRange} label="Range" />
              </div>
              {points.length > 1
                ? <AreaChart points={points} onScrub={setScrub} label={`${c?.name} ${series} price history`} />
                : <div class="chart-empty muted">History builds up from the first refresh. Check back in a few days.</div>}
            </div>
          )}

          {d && d.signals.length > 0 && (
            <section class="section">
              <div class="section-head"><h2>Why it's flagged</h2></div>
              {d.signals.map((s) => (
                <div class="signal-row">
                  <span class="badge accent">{s.kindLabel}</span>
                  <div class="row-main"><div style={{ fontSize: 14 }}>{dealReason(s)}</div>
                    <div class="row-meta" style={{ textAlign: 'left' }}>{money(s.price)} vs {money(s.value)} · score {s.score}{s.data?.grading ? ` · grade it: ${signedMoney(s.data.grading.profit)} EV` : ''}</div></div>
                  {s.data?.url && <a class="btn sm" href={s.data.url} target="_blank" rel="noopener noreferrer">View<IconExternal size={13} /></a>}
                </div>
              ))}
            </section>
          )}

          {v && v.grades && (
            <section class="section">
              <div class="section-head"><h2>Price by grade</h2>{v.volume != null && <span class="faint" style={{ fontSize: 13 }}>{v.volume} sales / yr</span>}</div>
              <Ladder v={v} />
            </section>
          )}

          {d && v && v.grades?.psa10 && <GradingCalc d={d} v={v} key={v.variant} />}

          {d && d.listings.length > 0 && (
            <section class="section">
              <div class="section-head"><h2>Live listings</h2><span class="faint" style={{ fontSize: 13 }}>eBay · checked {ago(d.listings[0].fetchedAt)}</span></div>
              {d.listings.map((l) => {
                const fair = l.grader ? null : v?.price;
                return (
                  <a class="row listing-row" href={l.url} target="_blank" rel="noopener noreferrer">
                    <div class="row-main">
                      <div class="row-title"><span class="t" style={{ fontWeight: 500 }}>{l.title}</span></div>
                      <div class="row-sub">{l.seller}{l.feedback != null ? ` · ${l.feedback}%` : ''}{l.shipping ? ` · ${money(l.shipping)} ship` : ' · free ship'}</div>
                    </div>
                    <GradeBadge grader={l.grader} grade={l.grade} />
                    <div class="row-right"><div class="row-value">{money(l.total)}</div>{fair ? <div class="row-meta">{pct(l.total / fair - 1, { digits: 0 })} vs market</div> : null}</div>
                  </a>
                );
              })}
            </section>
          )}

          {d && <MarketplaceListings cardId={d.card.id} />}

          {d && d.holdings.length > 0 && (
            <section class="section">
              <div class="section-head"><h2>In your collection</h2></div>
              {d.holdings.map((h) => (
                <button type="button" class="row holding-mini" onClick={() => setSheet({ edit: h.id })}>
                  <GradeBadge grader={h.grader} grade={h.grade} condition={h.condition} />
                  <div class="row-main" style={{ textAlign: 'left' }}><div style={{ fontSize: 14 }}>{h.quantity} × {money(h.value)}</div>
                    <div class="row-sub">{h.costBasis != null ? `Paid ${money(h.costBasis)} each` : 'No cost basis'}{h.acquiredAt ? ` · ${longDate(h.acquiredAt)}` : ''}</div></div>
                  <div class="row-right"><div class="row-value">{money(h.total)}</div>{h.costBasis != null && h.value != null && <div class={`row-meta ${h.value >= h.costBasis ? 'up' : 'down'}`}>{signedMoney((h.value - h.costBasis) * h.quantity)}</div>}</div>
                  <IconPencil size={16} class="faint" />
                </button>
              ))}
            </section>
          )}

          {v && v.sources.length > 0 && (
            <section class="section">
              <div class="section-head"><h2>Sources</h2>{d && <span class="faint" style={{ fontSize: 13 }}>EUR at {d.fx.toFixed(3)}</span>}</div>
              <div class="sources">
                {v.sources.map((s) => (
                  <div class="source">
                    <div class="src-name">{s.label}{s.linked && <span class="faint"> · matched {Math.round((s.linkConfidence ?? 0) * 100)}%</span>}</div>
                    <div class="src-metrics">
                      {Object.entries(s.metrics).filter(([k, x]) => x != null && k !== 'asOf').map(([k, x]) => (
                        <span><i>{k.replace(/([A-Z])/g, ' $1').replace(/^g(\d)/, 'grade $1').toLowerCase()}</i>{k === 'volume' ? x : s.currency === 'EUR' ? `€${Number(x).toFixed(2)}` : money(x as number)}</span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>

      {sheet === 'add' && d && <HoldingSheet cardId={d.card.id} onClose={() => setSheet(null)} />}
      {sheet === 'watch' && d && v && <WatchSheet d={d} variant={v.variant} onClose={() => setSheet(null)} />}
      {sheet && typeof sheet === 'object' && d && <HoldingSheet cardId={d.card.id} holding={d.holdings.find((h) => h.id === sheet.edit)} onClose={() => setSheet(null)} />}
    </div>
  );
}
