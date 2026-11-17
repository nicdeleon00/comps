import { useEffect, useMemo, useState } from 'preact/hooks';
import { money, ago } from '../lib/format';
import { byStore, byProduct, stockLabel, logLabel, radiusOptions, isStale, type StockDoc, type StockEntry, type StockFilter, type StoreGroup, type ProductGroup } from '../lib/stock';
import { Segmented, Empty, SkRows } from '../components/ui';
import { IconStore, IconRefresh, IconSearch, IconPin } from '../components/icons';
import { Header } from './shared';

const REPO = (import.meta.env.VITE_REPO as string | undefined) ?? '';
/** The stock branch's one file (see .github/workflows/stock.yml); next to the site's data when there's no repo. */
const STOCK_URL = (import.meta.env.VITE_STOCK_URL as string | undefined)
  ?? (REPO ? `https://raw.githubusercontent.com/${REPO}/stock/stock.json` : `${import.meta.env.BASE_URL}data/stock.json`);
const SETUP_URL = REPO ? `https://github.com/${REPO}#nearby-stock` : null;

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
          <h2>{s.name}</h2>
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
        <Empty icon={<IconStore size={26} />} title="Stock checks aren't switched on yet"
          action={SETUP_URL && <a class="btn primary" href={SETUP_URL} target="_blank" rel="noopener">How to switch them on</a>}>
          Once they are, this page lists which stores near you have Pokémon card product, checked every 15 minutes. It takes a ZIP code and a free store key, added once.
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
