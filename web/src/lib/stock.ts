// Nearby stock: the shape of stock.json (written by server/src/stock) and how the Stock screen
// groups and filters it. The iPhone app does the same in ios/Comps/Services/Stock.swift.
// No imports, so it can be unit-tested with Node directly.

export type StockChain = { name: string; checkedAt: number | null; ok: boolean; error: string | null; exact: boolean };
export type StockStore = {
  id: string; chain: string; number: string; name: string; address: string | null; city: string | null; state: string | null;
  zip: string | null; distance: number | null; phone: string | null; url: string | null; lat: number | null; lng: number | null;
  /** Its counts can't be trusted: 'auto' = caught showing a count that never moves, 'manual' = listed by hand. */
  suspect?: 'auto' | 'manual' | null;
};
export type StockProduct = { id: string; chain: string; sku: string; name: string; price: number | null; image: string | null; url: string | null };
/** One product at one store. log: [time, 0 = sold out, otherwise how many (1 when the chain doesn't say)]. */
export type StockEntry = { s: string; p: string; in: boolean; low: boolean; qty: number | null; since: number; log: [number, number][] };
export type StockDoc = {
  v: number; updatedAt: number; radius: number;
  chains: Record<string, StockChain>; stores: StockStore[]; products: StockProduct[]; stock: StockEntry[];
};

export type StockFilter = { chain: string | null; miles: number; inStockOnly: boolean; query: string };
export type StoreGroup = { store: StockStore; chainName: string; exact: boolean; inStock: number; items: { entry: StockEntry; product: StockProduct }[] };
export type ProductGroup = { product: StockProduct; chainName: string; exact: boolean; places: { entry: StockEntry; store: StockStore }[] };

const words = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const matches = (name: string, query: string) => { const n = words(name).join(' '); return words(query).every((w) => n.includes(w)); };
const inRange = (s: StockStore, f: StockFilter) => (!f.chain || s.chain === f.chain) && (s.distance == null || s.distance <= f.miles);

/** Stores closest first. In each: what's in stock (by name), then what sold out lately (newest first). */
export function byStore(doc: StockDoc, f: StockFilter): StoreGroup[] {
  const products = new Map(doc.products.map((p) => [p.id, p]));
  const lines = new Map<string, StoreGroup['items']>();
  for (const entry of doc.stock) {
    const product = products.get(entry.p);
    if (!product || (f.inStockOnly && !entry.in) || (f.query && !matches(product.name, f.query))) continue;
    if (!lines.has(entry.s)) lines.set(entry.s, []);
    lines.get(entry.s)!.push({ entry, product });
  }
  const out: StoreGroup[] = [];
  for (const store of doc.stores) {
    if (!inRange(store, f)) continue;
    const items = (lines.get(store.id) ?? []).sort((a, b) =>
      Number(b.entry.in) - Number(a.entry.in) || (a.entry.in ? a.product.name.localeCompare(b.product.name) : b.entry.since - a.entry.since));
    const inStock = items.filter((i) => i.entry.in).length;
    if ((f.inStockOnly || f.query) && !items.length) continue;
    out.push({ store, chainName: doc.chains[store.chain]?.name ?? store.chain, exact: Boolean(doc.chains[store.chain]?.exact), inStock, items });
  }
  return out.sort((a, b) => (a.store.distance ?? 1e9) - (b.store.distance ?? 1e9));
}

/** Products that some store in range has, the ones in the most stores first; each with its stores closest first. */
export function byProduct(doc: StockDoc, f: StockFilter): ProductGroup[] {
  const stores = new Map(doc.stores.filter((s) => inRange(s, f)).map((s) => [s.id, s]));
  const groups = new Map<string, ProductGroup>();
  for (const product of doc.products) {
    if (f.query && !matches(product.name, f.query)) continue;
    groups.set(product.id, { product, chainName: doc.chains[product.chain]?.name ?? product.chain, exact: Boolean(doc.chains[product.chain]?.exact), places: [] });
  }
  for (const entry of doc.stock) {
    const store = stores.get(entry.s);
    if (store && entry.in) groups.get(entry.p)?.places.push({ entry, store });
  }
  const out = [...groups.values()].filter((g) => g.places.length);
  for (const g of out) g.places.sort((a, b) => (a.store.distance ?? 1e9) - (b.store.distance ?? 1e9));
  return out.sort((a, b) => b.places.length - a.places.length || a.product.name.localeCompare(b.product.name));
}

/** "3 on hand" when the chain says how many; otherwise "In stock", "Low stock" or "Sold out". */
export function stockLabel(e: Pick<StockEntry, 'in' | 'low' | 'qty'>): string {
  if (!e.in) return 'Sold out';
  if (e.qty != null) return `${e.qty} on hand`;
  return e.low ? 'Low stock' : 'In stock';
}

/** The same for one line of an entry's history. */
export const logLabel = (code: number, exact: boolean) => (code === 0 ? 'Sold out' : exact ? `${code} on hand` : 'In stock');

/** Distance choices up to how far the checks reach. */
export function radiusOptions(max: number): number[] {
  const out = [10, 25, 50, 100].filter((m) => m < max);
  return [...out, max];
}

/** True when the newest check is old enough that the screen should say so (the timer runs every 30 minutes). */
export const isStale = (doc: Pick<StockDoc, 'updatedAt'>, now: number) => now - doc.updatedAt > 2 * 3600_000;
