// Facebook Marketplace deals: listings shared by everyone running the Comps
// extension (kept in Supabase), plus what this browser's extension found.
// Values are recomputed here from today's prices, so a listing seen last week
// is judged against current market prices.

import { useEffect, useMemo, useState } from 'preact/hooks';
import { useData } from './api';
import { accountsEnabled, publicRest } from './supabase';
import type { CatalogIndex, IndexRow } from './masterset';

export interface Listing {
  id: string;
  url: string;
  title: string;
  price: number;
  location: string | null;
  status: string;
  seenAt: number;
  card: { id: string; name: string; set: string; number: string; image: string };
  grade: string | null;
  /** What Comps says it's worth; null when the title fits several cards. */
  value: number | null;
  /** When unsure: the cheapest card it could be. */
  low: number | null;
  discount: number | null;
  deal: boolean;
  confident: boolean;
  /** Found by this browser's extension. */
  mine: boolean;
}

type SharedRow = { id: string; card_id: string; variant: string | null; grade: string | null; title: string; price: number; location: string | null; confident: boolean; status: string; seen_at: number };
type LocalFind = Omit<Listing, 'mine' | 'card' | 'seenAt'> & { card: Listing['card']; seenAt: number; variant: string | null; high: number | null };
export type Scan = { running: boolean; queries: string[]; qi: number; priced: number; deals: number; note: string | null; endedAt?: number };

const FRESH_DAYS = 14;
const fbUrl = (id: string) => `https://www.facebook.com/marketplace/item/${id}/`;

/** Under value enough to bother: 15%+ and $3+ under, and not a $1 "message me" placeholder. */
export function isDeal(price: number, worth: number | null) {
  if (!worth || !price) return false;
  if (price <= 1 && worth >= 10) return false;
  return 1 - price / worth >= 0.15 && worth - price >= 3;
}

function valueOf(row: IndexRow, variant: string | null, grade: string | null) {
  const v = row[6].find((x) => x[0] === variant) ?? row[6][0];
  if (!v) return null;
  if (!grade) return v[1];
  const [grader, n] = grade.split(' ');
  if (Number(n) >= 10 && grader === 'PSA') return v[3];
  if (Number(n) >= 9 && Number(n) < 10) return v[2];
  return null;
}

// ---------------------------------------------------------------- the extension

const post = (msg: Record<string, unknown>) => window.postMessage({ source: 'comps-site', ...msg }, location.origin);

/** The browser extension, if this browser has it: installed is null while checking. */
export function useExtension() {
  const [s, setS] = useState<{ installed: boolean | null; finds: LocalFind[]; scan: Scan | null; lastScan: { at: number; priced: number; deals: number } | null; share: boolean; version?: string }>(
    { installed: null, finds: [], scan: null, lastScan: null, share: true });
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source !== window || e.data?.source !== 'comps-ext') return;
      if (e.data.type === 'mp:ready') post({ type: 'mp:get' });
      if (e.data.type === 'mp:state') setS({ installed: true, finds: e.data.finds ?? [], scan: e.data.scan ?? null, lastScan: e.data.lastScan ?? null, share: e.data.share !== false, version: e.data.version });
    };
    addEventListener('message', on);
    post({ type: 'mp:get' });
    const t = setTimeout(() => setS((x) => (x.installed === null ? { ...x, installed: false } : x)), 1500);
    return () => { removeEventListener('message', on); clearTimeout(t); };
  }, []);
  return {
    ...s,
    start: () => post({ type: 'mp:scan' }),
    stop: () => post({ type: 'mp:stop' }),
    remove: (id: string) => post({ type: 'mp:remove', id }),
  };
}

// ---------------------------------------------------------------- shared listings

/** Listings everyone has shared (optionally for one card), refreshed every minute. */
export function useSharedListings(cardId?: string) {
  const [rows, setRows] = useState<SharedRow[] | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!accountsEnabled) { setRows([]); return; }
    let live = true;
    const since = Date.now() - FRESH_DAYS * 86_400_000;
    const q = `market_listings?select=id,card_id,variant,grade,title,price,location,confident,status,seen_at&status=neq.sold&seen_at=gt.${since}`
      + (cardId ? `&card_id=eq.${encodeURIComponent(cardId)}&order=price.asc&limit=20` : '&order=seen_at.desc&limit=1500');
    const load = () => publicRest<SharedRow[]>(q).then(
      (r) => live && setRows(r),
      (e) => { if (!live) return; setRows([]); setMissing(e?.status === 404); },
    );
    load();
    const t = setInterval(() => document.visibilityState === 'visible' && load(), 60_000);
    return () => { live = false; clearInterval(t); };
  }, [cardId]);
  return { rows, missing };
}

/** Shared listings and this browser's finds as one list, valued at today's prices. */
export function useListings(cardId?: string) {
  const ext = useExtension();
  const shared = useSharedListings(cardId);
  const { data: index } = useData<CatalogIndex>('/api/index');
  const byId = useMemo(() => (index ? new Map(index.cards.map((r) => [`tcg:${r[0]}`, r])) : null), [index]);

  const items = useMemo(() => {
    if (!byId || !index) return null;
    const out = new Map<string, Listing>();
    for (const r of shared.rows ?? []) {
      const row = byId.get(r.card_id);
      if (!row) continue;
      const fb = r.id.replace(/^fb:/, '');
      const value = r.confident ? valueOf(row, r.variant, r.grade) : null;
      out.set(fb, {
        id: fb, url: fbUrl(fb), title: r.title, price: Number(r.price), location: r.location, status: r.status, seenAt: Number(r.seen_at),
        card: { id: r.card_id, name: row[1], set: index.sets[row[2]]?.[0] ?? '', number: row[3] ?? '', image: `${index.imageBase}${row[0]}_200w.jpg` },
        grade: r.grade, value, low: null, discount: value ? 1 - r.price / value : null, deal: isDeal(Number(r.price), value), confident: r.confident, mine: false,
      });
    }
    for (const f of ext.finds) {
      if (cardId && f.card.id !== cardId) continue;
      if (!f.price || f.status === 'sold' || f.seenAt < Date.now() - FRESH_DAYS * 86_400_000) continue;
      const row = byId.get(f.card.id);
      const value = f.confident && row ? valueOf(row, f.variant, f.grade) : null;
      const worth = value ?? f.low;
      out.set(f.id, {
        ...f, url: fbUrl(f.id), value, low: f.low, discount: worth ? 1 - f.price / worth : null,
        deal: isDeal(f.price, worth), mine: true, seenAt: Math.max(f.seenAt, out.get(f.id)?.seenAt ?? 0),
      });
    }
    return [...out.values()];
  }, [byId, index, shared.rows, ext.finds, cardId]);

  return { items, ext, setupMissing: shared.missing };
}
