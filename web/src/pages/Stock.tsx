import { useEffect, useMemo, useState } from 'preact/hooks';
import { money, ago } from '../lib/format';
import { byStore, byProduct, stockLabel, logLabel, radiusOptions, isStale, type StockDoc, type StockEntry, type StockFilter, type StoreGroup, type ProductGroup } from '../lib/stock';
import { Segmented, Empty, SkRows } from '../components/ui';
import { Link, navigate } from '../lib/router';
import { storeHistory, duration, WEEKDAYS, hourLabel, type StockHistoryDoc, type ProductHistory } from '../lib/stockHistory';
import { IconStore, IconRefresh, IconSearch, IconPin, IconBack, IconChevron } from '../components/icons';
import { Header } from './shared';

const REPO = (import.meta.env.VITE_REPO as string | undefined) ?? '';
/** The stock branch's one file (see .github/workflows/stock.yml); next to the site's data when there's no repo. */
const STOCK_URL = (import.meta.env.VITE_STOCK_URL as string | undefined)
  ?? (REPO ? `https://raw.githubusercontent.com/${REPO}/stock/stock.json` : `${import.meta.env.BASE_URL}data/stock.json`);

type Prefs = { view: 'store' | 'product'; chain: string | null; miles: number | null; inStockOnly: boolean };
const DEFAULTS: Prefs = { view: 'store', chain: null, miles: null, inStockOnly: true };
const readPrefs = (): Prefs => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('comps.stock.prefs') ?? '{}') }; } catch { return DEFAULTS; } };

type Loaded = { doc: StockDoc | null; state: 'loading' | 'ready' | 'none' | 'error' };

/** stock.json, refetched every five minutes while the page is open and whenever it comes back into view. */
function useStock() {
  const [res, setRes] = useState<Loaded>({ doc: null, state: 'loading' });
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true);
    try {
      const r = await fetch(STOCK_URL, { cache: 'no-cache' });
      if (r.status === 404) setRes({ doc: null, state: 'none' });
      else if (!r.ok) throw new Error(`HTTP ${r.status}`);
      else setRes({ doc: (await r.json()) as StockDoc, state: 'ready' });
    } catch {
      setRes((old) => (old.doc ? old : { doc: null, state: 'error' }));
    } finally { setBusy(false); }
  };
  useEffect(() => {
    load();
    const t = setInterval(() => document.visibilityState === 'visible' && load(), 5 * 60_000);
    const onShow = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onShow);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onShow); };
  }, []);
  return { ...res, busy, reload: load };
}

const when = (t: number) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const miles = (d: number | null) => (d == null ? '' : `${d < 10 ? d.toFixed(1) : Math.round(d)} mi`);
const mapUrl = (s: StoreGroup['store'], chain: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([chain, s.address, s.city, s.state, s.zip].filter(Boolean).join(' '))}`;

function Status({ e }: { e: StockEntry }) {
  return <span class={`stock-status ${!e.in ? 'out' : e.low ? 'low' : 'in'}`}>{stockLabel(e)}</span>;
}

/** When it came in or sold out, and the changes before that. */
function Since({ e, exact }: { e: StockEntry; exact: boolean }) {
  const earlier = e.log.slice(0, -1).slice(-3).reverse();
  return (
    <div class="stock-since">
      <span>{e.in ? 'In stock since' : 'Sold out'} {when(e.since)}</span>
      {earlier.map(([t, code]) => <span class="stock-log" key={t}><i class={code ? 'in' : 'out'} />{when(t)} · {logLabel(code, exact)}</span>)}
    </div>
  );
}

function Picture({ src, name }: { src: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span class="stock-pic" aria-hidden="true">
      {src && !failed ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} /> : <span>{name.slice(0, 1)}</span>}
    </span>
  );
}

function StoreCard({ g }: { g: StoreGroup }) {
  const s = g.store;
  return (
    <section class="stock-card">
      <header class="stock-head">
        <div class="stock-head-main">
          <h2><Link href={`/stock/store/${encodeURIComponent(s.id)}`} class="stock-store-link">{s.name}<IconChevron size={15} /></Link></h2>
          <div class="stock-sub">{g.chainName}{s.number ? ` · #${s.number}` : ''}{s.city ? ` · ${s.city}${s.state ? `, ${s.state}` : ''}` : ''}</div>
          {s.suspect && <div class="stock-suspect" title={s.suspect === 'auto' ? "This store has shown a count that didn't move for days on a product most stores are out of." : 'You listed this store as having wrong counts.'}>Counts often wrong here</div>}
        </div>
        <a class="stock-distance" href={mapUrl(s, g.chainName)} target="_blank" rel="noopener" aria-label={`Directions to ${g.chainName} ${s.name}`}>
          <IconPin size={15} />{miles(s.distance) || 'Map'}
        </a>
      </header>
      {!g.items.length && <div class="stock-none">Nothing in stock at the last check.</div>}
      {g.items.map(({ entry, product }) => (
        <div class={`stock-line ${entry.in ? '' : 'sold'}`} key={product.id}>
          <Picture src={product.image} name={product.name} />
          <div class="stock-line-main">
            <a class="stock-name" href={product.url ?? undefined} target="_blank" rel="noopener">{product.name}</a>
            <Since e={entry} exact={g.exact} />
          </div>
          <div class="stock-line-right">
            <Status e={entry} />
            {product.price != null && <span class="stock-price num">{money(product.price)}</span>}
          </div>
        </div>
      ))}
    </section>
  );
}

function ProductCard({ g }: { g: ProductGroup }) {
  const p = g.product;
  return (
    <section class="stock-card">
      <header class="stock-head">
        <Picture src={p.image} name={p.name} />
        <div class="stock-head-main">
          <h2><a href={p.url ?? undefined} target="_blank" rel="noopener">{p.name}</a></h2>
          <div class="stock-sub">{g.chainName}{p.price != null ? ` · ${money(p.price)}` : ''} · {g.places.length} store{g.places.length === 1 ? '' : 's'}</div>
        </div>
      </header>
      {g.places.map(({ entry, store }) => (
        <div class="stock-line" key={store.id}>
          <div class="stock-line-main">
            <a class="stock-name" href={mapUrl(store, g.chainName)} target="_blank" rel="noopener">{store.name}{store.number ? <span class="muted"> · #{store.number}</span> : null}</a>
            <Since e={entry} exact={g.exact} />
          </div>
          <div class="stock-line-right">
            <Status e={entry} />
            <span class="stock-price num">{miles(store.distance)}</span>
          </div>
        </div>
      ))}
    </section>
  );
}

/** Which nearby stores have Pokémon card product, from the checks that run every 15 minutes. */
export function StockPage() {
  const { doc, state, busy, reload } = useStock();
  const [prefs, setPrefs] = useState(readPrefs);
  const [query, setQuery] = useState('');
  const set = (patch: Partial<Prefs>) => setPrefs((p) => {
    const next = { ...p, ...patch };
    try { localStorage.setItem('comps.stock.prefs', JSON.stringify(next)); } catch {}
    return next;
  });

  const chains = Object.entries(doc?.chains ?? {});
  const chain = prefs.chain && doc?.chains[prefs.chain] ? prefs.chain : null;
  const reach = doc?.radius ?? 50;
  const range = Math.min(prefs.miles ?? reach, reach);
  const filter: StockFilter = { chain, miles: range, inStockOnly: prefs.inStockOnly, query };
  const stores = useMemo(() => (doc ? byStore(doc, filter) : []), [doc, chain, range, prefs.inStockOnly, query]);
  const products = useMemo(() => (doc ? byProduct(doc, filter) : []), [doc, chain, range, query]);
  const count = prefs.view === 'store' ? stores.length : products.length;
  const failed = chains.filter(([, c]) => !c.ok);

  return (
    <div class="page">
      <Header title="Stock" actions={doc && <button class="btn" onClick={reload} disabled={busy}><IconRefresh size={16} />{busy ? 'Checking…' : 'Refresh'}</button>}>
        <span>Pokémon cards at stores near you{doc ? `, within ${reach} miles` : ''}.</span>
        {doc && <span class={isStale(doc, Date.now()) ? 'stock-stale' : ''}> Checked {ago(doc.updatedAt)}.</span>}
      </Header>

      {state === 'loading' && <SkRows n={6} />}

      {state === 'none' && (
        <Empty icon={<IconStore size={26} />} title="Stock checks aren't on yet">
          Once they are, this page lists which stores near you have Pokémon card product, checked every 15 minutes.
        </Empty>
      )}

      {state === 'error' && (
        <Empty icon={<IconStore size={26} />} title="Couldn't load the stock list" action={<button class="btn" onClick={reload}>Try again</button>}>
          Check your connection. The last answer comes back as soon as it's reachable.
        </Empty>
      )}

      {doc && <>
        {failed.map(([id, c]) => (
          <div class="stock-notice" key={id}>
            {c.name} couldn't be checked{c.checkedAt ? `; showing the answer from ${ago(c.checkedAt)}` : ''}.{c.error ? <span class="muted"> {c.error}</span> : null}
          </div>
        ))}

        <div class="toolbar">
          <Segmented value={prefs.view} label="Group by" onChange={(v) => set({ view: v as Prefs['view'] })}
            options={[{ value: 'store', label: 'By store' }, { value: 'product', label: 'By product' }]} />
          <Segmented value={String(range)} label="Distance" onChange={(v) => set({ miles: Number(v) })}
            options={radiusOptions(reach).map((m) => ({ value: String(m), label: `${m} mi` }))} />
          <span class="spacer" />
          <div class="input-wrap stock-search">
            <span class="prefix"><IconSearch size={14} /></span>
            <input class="input sm" type="search" placeholder="Find a product" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} aria-label="Find a product" />
          </div>
        </div>
        <div class="toolbar">
          {chains.length > 1 && (
            <div class="chips scroll-chips" role="group" aria-label="Store chain">
              <button class="chip" aria-pressed={!chain} onClick={() => set({ chain: null })}>All stores</button>
              {chains.map(([id, c]) => <button class="chip" key={id} aria-pressed={chain === id} onClick={() => set({ chain: id })}>{c.name}</button>)}
            </div>
          )}
          <span class="spacer" />
          {prefs.view === 'store' && (
            <label class="stock-switch">
              <span>In stock only</span>
              <span class="switch"><input type="checkbox" checked={prefs.inStockOnly} onChange={(e) => set({ inStockOnly: (e.target as HTMLInputElement).checked })} /><span /></span>
            </label>
          )}
        </div>

        {!count && (
          <Empty icon={<IconStore size={26} />} title={query ? `No "${query}" in stock nearby` : `Nothing in stock within ${range} miles`}>
            {range < reach ? 'Try a wider distance.' : 'This list updates on its own every 15 minutes.'}
          </Empty>
        )}
        <div class="stock-grid">
          {prefs.view === 'store'
            ? stores.map((g) => <StoreCard g={g} key={g.store.id} />)
            : products.map((g) => <ProductCard g={g} key={g.product.id} />)}
        </div>
      </>}
    </div>
  );
}

// ---------------------------------------------------------------- one store's history

const HISTORY_URL = STOCK_URL.replace(/stock\.json$/, 'history.json');

function useHistory() {
  const [doc, setDoc] = useState<StockHistoryDoc | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    fetch(HISTORY_URL, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).then((d) => live && setDoc(d)).catch(() => live && setDoc(null));
    return () => { live = false; };
  }, []);
  return doc;
}

/** How many there were over time: a step line, with the restocks marked. */
function StepChart({ p, from, to }: { p: ProductHistory; from: number; to: number }) {
  const W = 600, Hh = 90, pad = 4;
  const pts = p.points;
  const max = Math.max(1, ...pts.map((x) => x[1]));
  const x = (t: number) => pad + ((Math.max(from, Math.min(to, t)) - from) / Math.max(1, to - from)) * (W - pad * 2);
  const y = (v: number) => Hh - pad - (v / max) * (Hh - pad * 2 - 12);
  // The level when the window starts, then each change, then flat to now.
  let level = 0;
  for (const [t, v] of pts) if (t <= from) level = v;
  let d = `M${x(from)},${y(level)}`;
  for (const [t, v] of pts) { if (t <= from) continue; d += ` H${x(t)} V${y(v)}`; level = v; }
  d += ` H${x(to)}`;
  const area = `${d} V${Hh - pad} H${x(from)} Z`;
  return (
    <svg class="stock-chart" viewBox={`0 0 ${W} ${Hh}`} preserveAspectRatio="none" role="img" aria-label={`How many over time; now ${p.now}`}>
      <path d={area} class="area" />
      <path d={d} class="line" vector-effect="non-scaling-stroke" />
      {p.restocks.filter((e) => e.t >= from).map((e) => <circle key={e.t} cx={x(e.t)} cy={y(e.to)} r="3.5" class="dot" vector-effect="non-scaling-stroke" />)}
      <text x={W - pad} y="11" text-anchor="end" class="max">{max}</text>
    </svg>
  );
}

const day = (t: number) => new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

/** Everything a store has done: when it restocks, how much, how long it lasts, and every change. */
export function StockStorePage({ id }: { id: string }) {
  const { doc, state } = useStock();
  const history = useHistory();
  const [days, setDays] = useState('30');
  const now = Date.now();
  const store = doc?.stores.find((s) => s.id === id);
  const chain = store ? doc!.chains[store.chain] : null;
  const products = new Map((doc?.products ?? []).map((p) => [p.id, p]));
  const h = useMemo(() => (history ? storeHistory(history, id, now, Number(days)) : null), [history, id, days]);
  const span = Number(days) * 86400_000;
  const from = Math.max(now - span, history?.start ?? now - span);
  const nameOf = (pid: string) => products.get(pid)?.name ?? history?.names?.[pid] ?? 'A product no longer listed';
  const unit = chain?.exact ? '' : ' (in stock / out)';

  if (state === 'loading' || history === undefined) return <div class="page"><SkRows n={6} /></div>;
  if (!store) return <div class="page"><Empty icon={<IconStore size={26} />} title="This store isn't in range any more" action={<Link class="btn" href="/stock">Back to Stock</Link>} /></div>;

  return (
    <div class="page">
      <button class="btn sm card-back" onClick={() => navigate('/stock')}><IconBack size={16} />Stock</button>
      <header class="stock-store-head">
        <div>
          <h1>{store.name}</h1>
          <div class="muted">{chain?.name}{store.number ? ` · #${store.number}` : ''}{store.city ? ` · ${store.city}${store.state ? `, ${store.state}` : ''}` : ''}</div>
          {store.suspect && <div class="stock-suspect">Counts often wrong here</div>}
        </div>
        <a class="btn" href={mapUrl(store, chain?.name ?? '')} target="_blank" rel="noopener"><IconPin size={15} />{miles(store.distance) || 'Map'} · Directions</a>
      </header>

      <div class="toolbar">
        <Segmented value={days} label="Period" onChange={setDays} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
        <span class="spacer" />
        {history && <span class="muted" style={{ fontSize: 13 }}>Tracking since {day(history.start)}</span>}
      </div>

      {!h || !h.products.length ? (
        <Empty icon={<IconStore size={26} />} title="No history here yet">Changes at this store are recorded every 15 minutes. Check back after its next delivery.</Empty>
      ) : <>
        <div class="ms-stats stock-stats">
          <div class="ms-stat"><span>Restocks</span><b>{h.restocks.length}</b><small>in the last {days} days</small></div>
          <div class="ms-stat"><span>Usually restocks</span><b class="stock-stat-text">{h.usualDay != null ? WEEKDAYS[h.usualDay].slice(0, 3) : '—'}</b>
            <small>{h.usualHours ? `${hourLabel(h.usualHours[0])} – ${hourLabel(h.usualHours[1])}` : 'Needs a few more deliveries'}</small></div>
          <div class="ms-stat"><span>Each restock</span><b>{h.avgAdded != null ? `+${Math.round(h.avgAdded)}` : '—'}</b><small>{chain?.exact ? 'on average' : 'in stock / out only'}</small></div>
          <div class="ms-stat"><span>Lasts on the shelf</span><b class="stock-stat-text">{h.avgShelf != null ? duration(h.avgShelf) : '—'}</b><small>{h.avgShelf != null ? 'from restock to sold out' : 'Nothing has sold out yet'}</small></div>
        </div>

        {h.restocks.length > 0 && (
          <section class="section">
            <div class="section-head"><h2>When it restocks</h2><span class="muted">{h.lastRestock ? `Last: ${when(h.lastRestock.t)}` : ''}</span></div>
            <div class="stock-week" role="img" aria-label="Restocks by weekday">
              {h.weekdays.map((n, i) => (
                <div class="stock-week-col" key={i}>
                  <div class="stock-week-bar"><i style={{ height: `${(n / Math.max(1, ...h.weekdays)) * 100}%` }} class={i === h.usualDay ? 'top' : ''} /></div>
                  <span>{WEEKDAYS[i].slice(0, 3)}</span><b class="num">{n || ''}</b>
                </div>
              ))}
            </div>
          </section>
        )}

        <section class="section">
          <div class="section-head"><h2>Products</h2><span class="muted">How many{unit} over the last {days} days</span></div>
          <div class="stock-grid">
            {h.products.map((p) => (
              <div class="stock-card stock-product" key={p.product}>
                <div class="stock-product-head">
                  <div class="stock-product-name">{nameOf(p.product)}</div>
                  <span class={`stock-status ${p.now > 0 ? 'in' : 'out'}`}>{p.now > 0 ? (chain?.exact ? `${p.now} on hand` : 'In stock') : 'Sold out'}</span>
                </div>
                <StepChart p={p} from={from} to={now} />
                <div class="stock-product-facts">
                  <span>{p.restocks.filter((e) => e.t >= from).length} restock{p.restocks.filter((e) => e.t >= from).length === 1 ? '' : 's'}</span>
                  {p.lastRestock && <span>last {when(p.lastRestock.t)} (+{p.lastRestock.to - p.lastRestock.from})</span>}
                  {p.avgShelf != null && <span>lasts ~{duration(p.avgShelf)}</span>}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section class="section">
          <div class="section-head"><h2>Every change</h2><span class="muted">Newest first</span></div>
          {!h.events.length && <p class="muted">Nothing changed in this period.</p>}
          <div class="stock-events">
            {h.events.slice(0, 200).map((e, i) => (
              <div class={`stock-event ev-${e.kind}`} key={e.t + e.product + i}>
                <i aria-hidden="true" />
                <time>{when(e.t)}</time>
                <span class="ellipsis">{nameOf(e.product)}</span>
                <b class="num">{e.kind === 'restock' ? `+${e.to - e.from}` : `−${e.from - e.to}`}</b>
                <span class="muted num">{e.from} → {e.to}{e.kind === 'soldout' ? ' · sold out' : ''}</span>
              </div>
            ))}
          </div>
        </section>
      </>}
    </div>
  );
}
