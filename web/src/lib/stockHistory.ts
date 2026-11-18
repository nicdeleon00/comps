// Stock history: every change in how many of a product a store has, and what that says about the
// store (when it restocks, how much, how long it lasts). history.json is written by
// server/src/stock/history.js; the iPhone app works the same out in ios/Comps/Services/StockHistory.swift.
// No imports, so it can be unit-tested with Node directly.

/** series: "store id|product id" -> [[time, how many], ...] in time order, one point per change. */
export type StockHistoryDoc = { v: number; updatedAt: number; start: number; series: Record<string, [number, number][]> };

export type StockEvent = { t: number; product: string; from: number; to: number; kind: 'restock' | 'down' | 'soldout' };
export type Stint = { start: number; end: number | null; added: number };
export type ProductHistory = {
  product: string; points: [number, number][]; now: number; events: StockEvent[]; restocks: StockEvent[]; stints: Stint[];
  lastRestock: StockEvent | null; avgShelf: number | null; went: number;
};
export type StoreHistory = {
  products: ProductHistory[]; events: StockEvent[]; restocks: StockEvent[]; weekdays: number[]; hours: number[];
  usualDay: number | null; usualHours: [number, number] | null; avgAdded: number | null; avgShelf: number | null;
  sold: number; lastRestock: StockEvent | null; since: number;
};

const DAY = 86400_000;

/** What happened to one product at one store. */
export function productHistory(product: string, points: [number, number][], now: number): ProductHistory {
  const events: StockEvent[] = [];
  const stints: Stint[] = [];
  let open: Stint | null = null;
  let went = 0;
  for (let i = 1; i < points.length; i++) {
    const [t, to] = points[i];
    const from = points[i - 1][1];
    if (to > from) {
      events.push({ t, product, from, to, kind: 'restock' });
      if (from === 0) { open = { start: t, end: null, added: to }; stints.push(open); }
      else if (open) open.added += to - from;
    } else if (to < from) {
      went += from - to;
      events.push({ t, product, from, to, kind: to === 0 ? 'soldout' : 'down' });
      if (to === 0 && open) { open.end = t; open = null; }
    }
  }
  const restocks = events.filter((e) => e.kind === 'restock');
  const done = stints.filter((s) => s.end != null);
  return {
    product, points, now: points.at(-1)?.[1] ?? 0, events, restocks, stints,
    lastRestock: restocks.at(-1) ?? null,
    avgShelf: done.length ? done.reduce((n, s) => n + (s.end! - s.start), 0) / done.length : null,
    went,
  };
}

/**
 * Everything about one store within the last `days` days: its products, every change newest first,
 * and its habits (the weekday and hours it usually restocks, in this device's time zone).
 */
export function storeHistory(doc: StockHistoryDoc, storeId: string, now: number, days = 30): StoreHistory {
  const cutoff = now - days * DAY;
  const products: ProductHistory[] = [];
  for (const [key, pts] of Object.entries(doc.series)) {
    const [store, product] = key.split('|');
    if (store !== storeId) continue;
    products.push(productHistory(product, pts, now));
  }
  const events = products.flatMap((p) => p.events).filter((e) => e.t >= cutoff).sort((a, b) => b.t - a.t);
  const restocks = events.filter((e) => e.kind === 'restock');
  const weekdays = Array(7).fill(0);
  const hours = Array(24).fill(0);
  // Several products restocked in the same check are one delivery.
  const deliveries = [...new Set(restocks.map((e) => e.t))];
  for (const t of deliveries) { const d = new Date(t); weekdays[d.getDay()]++; hours[d.getHours()]++; }
  const usualDay = deliveries.length >= 2 ? weekdays.indexOf(Math.max(...weekdays)) : null;
  let usualHours: [number, number] | null = null;
  if (deliveries.length >= 2) {
    // The 3-hour window holding the most deliveries.
    let best = -1, at = 0;
    for (let h = 0; h < 24; h++) { const n = hours[h] + hours[(h + 1) % 24] + hours[(h + 2) % 24]; if (n > best) { best = n; at = h; } }
    usualHours = [at, (at + 3) % 24];
  }
  const shelf = products.flatMap((p) => p.stints.filter((s) => s.end != null && s.start >= cutoff).map((s) => s.end! - s.start));
  const lastRestock = restocks[0] ?? null;
  return {
    products: products.sort((a, b) => b.now - a.now || (b.lastRestock?.t ?? 0) - (a.lastRestock?.t ?? 0)),
    events, restocks, weekdays, hours, usualDay, usualHours,
    avgAdded: restocks.length ? restocks.reduce((n, e) => n + (e.to - e.from), 0) / restocks.length : null,
    avgShelf: shelf.length ? shelf.reduce((a, b) => a + b, 0) / shelf.length : null,
    sold: events.filter((e) => e.kind !== 'restock').reduce((n, e) => n + (e.from - e.to), 0),
    lastRestock, since: doc.start,
  };
}

/** "2d 4h", "5h 10m", "12m". */
export function duration(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? ` ${h % 24}h` : ''}`;
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
