// Static mode (GitHub Pages): answers the same /api/... requests the server
// would, from JSON files published by the scheduled refresh, plus this
// browser's own collection, watchlist and settings in localStorage.

import { gradeEV } from './grading';
import { markDirty, markDataChanged } from './sync';
import type { Card, Costs, Deal, Holding, Spread } from './types';

const BASE = import.meta.env.BASE_URL;
const files = new Map<string, Promise<any>>();

function file<T = any>(name: string): Promise<T> {
  let p = files.get(name);
  if (!p) {
    p = fetch(`${BASE}data/${name}`, { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw Object.assign(new Error(r.status === 404 ? 'not found' : `HTTP ${r.status}`), { status: r.status });
      return r.json();
    });
    p.catch(() => files.delete(name));
    files.set(name, p);
  }
  return p;
}

// ---------------------------------------------------------------- local store
const LS = {
  get<T>(k: string, d: T): T {
    try { const v = localStorage.getItem(`comps.${k}`); return v ? (JSON.parse(v) as T) : d; } catch { return d; }
  },
  set(k: string, v: unknown) {
    try { localStorage.setItem(`comps.${k}`, JSON.stringify(v)); } catch {}
  },
};

const DEFAULT_SETTINGS = { gradingFee: 25, gradingShipping: 5, sellFeePct: 13.25, sellFixed: 0.4 };
const localSettings = () => ({ ...DEFAULT_SETTINGS, ...LS.get<Record<string, number>>('settings', {}) });
const costs = (): Costs => {
  const s = localSettings();
  return { fee: Number(s.gradingFee) || 0, shipping: Number(s.gradingShipping) || 0, sellFeePct: (Number(s.sellFeePct) || 0) / 100, sellFixed: Number(s.sellFixed) || 0 };
};

// ---------------------------------------------------------------- catalog index
type IndexRow = [number, string, string, string | null, string | null, string | null, [string, number | null, number | null, number | null, number | null][]];
type Index = { updatedAt: number; imageBase: string; sets: Record<string, [string, string | null, string, string | null]>; cards: IndexRow[] };

let indexMap: Promise<{ idx: Index; byId: Map<string, IndexRow> }> | null = null;
/** English cards (Master Sets, deals and the market use these). */
function index() {
  if (!indexMap) indexMap = file<Index>('index.json').then((idx) => ({ idx, byId: new Map(idx.cards.map((r) => [`tcg:${r[0]}`, r])) }));
  return indexMap;
}

let japanMap: Promise<Index> | null = null;
/** Japanese cards (index-ja.json), with every set labeled "(Japanese)". Empty if the file isn't there yet. */
function japan() {
  if (!japanMap) {
    japanMap = file<Index>('index-ja.json').then((idx) => {
      for (const id of Object.keys(idx.sets)) idx.sets[id] = [`${idx.sets[id][0]} (Japanese)`, ...idx.sets[id].slice(1)] as Index['sets'][string];
      return idx;
    }).catch(() => ({ updatedAt: 0, imageBase: '', sets: {}, cards: [] }));
  }
  return japanMap;
}

let catalogMap: Promise<{ idx: Index; byId: Map<string, IndexRow>; ja: Index }> | null = null;
/** English and Japanese cards together: for search, card pages and valuing a collection. */
function catalog() {
  if (!catalogMap) {
    catalogMap = Promise.all([index(), japan()]).then(([en, ja]) => {
      const byId = new Map(en.byId);
      for (const r of ja.cards) byId.set(`tcg:${r[0]}`, r);
      return { idx: { ...en.idx, sets: { ...en.idx.sets, ...ja.sets } }, byId, ja };
    });
  }
  return catalogMap;
}

/** The printing a card defaults to: the regular one, never 1st Edition unless it's the only one. */
const regular = (r: IndexRow) => r[6].find((x) => !/^1stEdition/i.test(x[0])) ?? r[6][0];

function cardFromRow(r: IndexRow, idx: Index, variant?: string): Card {
  const set = idx.sets[r[2]];
  const v = (variant && r[6].find((x) => x[0] === variant)) || regular(r);
  return {
    id: `tcg:${r[0]}`, game: 'pokemon', name: r[1], set: set?.[0] ?? null, setCode: set?.[1] ?? null, number: r[3], total: r[4], rarity: r[5],
    year: set?.[3] ? Number(set[3].slice(0, 4)) : null, image: `${idx.imageBase}${r[0]}_200w.jpg`, imageLarge: `${idx.imageBase}${r[0]}_400w.jpg`,
    variant: v?.[0], price: v?.[1] ?? null, change7d: v?.[4] ?? null, grades: v && (v[2] || v[3]) ? { g9: v[2] ?? undefined, psa10: v[3] ?? undefined } : null,
    ...({ series: set?.[2], setId: r[2] } as object),
  };
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const stripZeros = (n: string) => n.toUpperCase().replace(/^([A-Z]*)0+(?=\d)/, '$1');

/** Japanese cards come after English ones, unless the search says "jp" or "japanese" (then only them). */
async function search(q: string, limit = 24) {
  const { idx, ja } = await catalog();
  const num = /([A-Za-z]*\d+[a-z]?)\s*\/\s*([A-Za-z]*\d+)/.exec(q);
  let words = norm(q.replace(/[A-Za-z]*\d+[a-z]?\s*\/\s*[A-Za-z]*\d+/, ' ')).split(' ').filter(Boolean);
  const onlyJapanese = words.some((w) => w === 'jp' || w === 'japanese' || w === 'jpn');
  words = words.filter((w) => w !== 'jp' && w !== 'japanese' && w !== 'jpn');
  const english = (await index()).idx.cards;
  const japaneseIds = new Set(ja.cards.map((r) => r[0]));
  const rows = onlyJapanese ? ja.cards : [...english, ...ja.cards];
  const out: { r: IndexRow; s: number }[] = [];
  for (const r of rows) {
    if (num && stripZeros(r[3] ?? '') !== stripZeros(num[1])) continue;
    const name = norm(r[1]);
    const set = norm(idx.sets[r[2]]?.[0] ?? '');
    let s = 0;
    let ok = true;
    for (const w of words) {
      if (name.split(' ').some((t) => t.startsWith(w))) s += 2;
      else if (set.includes(w)) s += 1;
      else if (/^\d+$/.test(w) && stripZeros(r[3] ?? '') === stripZeros(w)) s += 1.5;
      else { ok = false; break; }
    }
    if (!ok) continue;
    if (name === words.join(' ')) s += 3;
    // "001/165": the set size picks the set, so those cards come first.
    if (num && r[4] && stripZeros(r[4]) === stripZeros(num[2])) s += 3;
    s += Math.min(1.5, Math.log10((r[6][0]?.[1] ?? 0) + 1) / 2);
    if (!onlyJapanese && japaneseIds.has(r[0])) s -= 2.5;
    out.push({ r, s });
  }
  out.sort((a, b) => b.s - a.s);
  return out.slice(0, limit).map((x) => cardFromRow(x.r, idx));
}

// ---------------------------------------------------------------- collection
type LocalHolding = Omit<Holding, 'value' | 'basis' | 'total' | 'change7d' | 'variantResolved' | 'imageUrl'> & { deleted?: boolean };
/** Everything stored, including deletions kept for sync. */
const allHoldings = () => LS.get<LocalHolding[]>('holdings', []);
const holdings = () => allHoldings().filter((h) => !h.deleted);
const saveHoldings = (h: LocalHolding[], changed: string[]) => { LS.set('holdings', h); markDirty(changed); };
const COND: Record<string, number> = { NM: 1, LP: 0.82, MP: 0.62, HP: 0.42, DMG: 0.25 };

async function valued(): Promise<Holding[]> {
  const list = holdings();
  if (!list.length) return [];
  const { byId, idx } = await catalog();
  return list.map((h) => {
    const r = byId.get(h.cardId);
    const v = r ? (r[6].find((x) => x[0] === h.variant) ?? regular(r)) : null;
    let value: number | null = null;
    let basis = 'raw';
    if (v) {
      const g = Number(h.grade);
      if (h.grader && g >= 10 && v[3]) { value = v[3]; basis = 'psa10'; }
      else if (h.grader && g >= 9 && g < 10 && v[2]) { value = v[2]; basis = 'g9'; }
      else value = v[1] != null ? Math.round(v[1] * (h.grader ? 1 : COND[h.condition] ?? 1) * 100) / 100 : null;
    }
    const card = r ? cardFromRow(r, idx, h.variant ?? undefined) : null;
    // Your own value wins; a Chinese card has no market price.
    if (h.customValue != null) { value = h.customValue; basis = 'yours'; }
    else if (h.language === 'zh') { value = null; basis = 'none'; }
    return {
      ...h, imageUrl: card?.image ?? h.image, value, basis, total: value != null ? Math.round(value * h.quantity * 100) / 100 : null,
      change7d: v?.[4] ?? null, variantResolved: v?.[0] ?? h.variant,
    } as Holding;
  });
}

async function collection(days: number) {
  const items = await valued();
  const value = items.reduce((s, h) => s + (h.total ?? 0), 0);
  const withCost = items.filter((h) => h.costBasis != null);
  const cost = withCost.reduce((s, h) => s + (h.costBasis ?? 0) * h.quantity, 0);
  const costedValue = withCost.reduce((s, h) => s + (h.total ?? 0), 0);
  const change7 = items.reduce((s, h) => (h.total != null && h.change7d != null ? s + (h.total - h.total / (1 + h.change7d)) : s), 0);
  const byGame = { pokemon: Math.round(value * 100) / 100 };
  // Daily snapshots of this browser's collection, kept locally.
  const today = new Date().toISOString().slice(0, 10);
  const snaps = LS.get<[string, number][]>('snapshots', []).filter((s) => s[0] !== today);
  if (items.length) snaps.push([today, Math.round(value * 100) / 100]);
  LS.set('snapshots', snaps.slice(-730));
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return {
    items,
    summary: {
      value, cost: cost || null, gain: cost ? costedValue - cost : null, gainPct: cost ? (costedValue - cost) / cost : null,
      change7d: change7, change7dPct: value ? change7 / (value - change7) : null,
      count: items.reduce((s, h) => s + h.quantity, 0), unique: items.length, byGame, movers: [],
      history: snaps.filter((s) => s[0] >= since),
    },
  };
}

// ---------------------------------------------------------------- deals & spreads
const RARITY: Record<string, (r: string) => boolean> = {
  sir: (r) => /^Special Illustration/i.test(r),
  ir: (r) => r === 'Illustration Rare',
  hyper: (r) => /Hyper|Secret|Rainbow/i.test(r),
  ultra: (r) => /Ultra|Double Rare|ACE SPEC|Amazing|Radiant|Prism|BREAK|LV\.X/i.test(r),
  holo: (r) => /Holo|Shiny|Shining|Star/i.test(r),
};
function cardMatches(c: Card & { series?: string; setId?: string }, q: Record<string, string>) {
  if (q.series && c.series !== q.series) return false;
  if (q.rarity && RARITY[q.rarity] && !RARITY[q.rarity](c.rarity ?? '')) return false;
  if (q.set && c.setId !== q.set) return false;
  return true;
}
const page = <T,>(items: T[], q: Record<string, string>) => {
  const off = Number(q.offset) || 0;
  const lim = Math.min(200, Number(q.limit) || 50);
  return { items: items.slice(off, off + lim), total: items.length };
};

async function deals(q: Record<string, string>) {
  const all: Deal[] = (await file<{ items: Deal[] }>('deals.json')).items;
  let xs = all.filter((d) => cardMatches(d.card as any, q));
  if (q.max) xs = xs.filter((d) => d.price <= Number(q.max));
  if (q.min) xs = xs.filter((d) => d.price >= Number(q.min));
  const counts: Record<string, number> = {};
  for (const d of xs) counts[d.kind] = (counts[d.kind] ?? 0) + 1;
  if (q.kind) xs = xs.filter((d) => d.kind === q.kind);
  const sorters: Record<string, (a: Deal, b: Deal) => number> = {
    upside: (a, b) => b.upside - a.upside, discount: (a, b) => a.price / a.value - b.price / b.value, price: (a, b) => a.price - b.price, score: (a, b) => b.score - a.score,
  };
  xs = [...xs].sort(sorters[q.sort] ?? sorters.score);
  return { ...page(xs, q), counts };
}

async function spreads(q: Record<string, string>) {
  const c = costs();
  const all: Spread[] = (await file<{ items: Spread[] }>('spreads.json')).items.map((s) => {
    const g = gradeEV(s.raw, { ...(s.card.grades ?? {}), g9: s.g9 ?? undefined, psa10: s.psa10 }, c, s.rates);
    return g ? { ...s, cost: g.cost, ev: g.ev, profit: g.profit, roi: g.roi, breakEven: g.breakEven, outcomes: g.outcomes, if10: g.if10 } : s;
  });
  let xs = all.filter((s) => cardMatches(s.card as any, q));
  if (q.maxRaw) xs = xs.filter((s) => s.raw <= Number(q.maxRaw));
  if (q.minRaw) xs = xs.filter((s) => s.raw >= Number(q.minRaw));
  if (q.minProfit != null && q.minProfit !== '') xs = xs.filter((s) => s.profit >= Number(q.minProfit));
  if (q.minVolume) xs = xs.filter((s) => (s.volume ?? 0) >= Number(q.minVolume));
  const sorters: Record<string, (a: Spread, b: Spread) => number> = {
    roi: (a, b) => b.roi - a.roi, multiple: (a, b) => b.multiple - a.multiple, raw: (a, b) => a.raw - b.raw,
    breakEven: (a, b) => (a.breakEven ?? 9) - (b.breakEven ?? 9), profit: (a, b) => b.profit - a.profit,
  };
  xs.sort(sorters[q.sort] ?? sorters.profit);
  return page(xs, q);
}

// ---------------------------------------------------------------- card detail
const shardOf = (id: string) => Number(id.replace(/^\D+/, '')) % 128;

async function cardDetail(id: string) {
  let d: any = null;
  try { d = (await file<{ cards: Record<string, any> }>(`cards/${shardOf(id)}.json`)).cards[id] ?? null; } catch {}
  if (!d) {
    // Cheap cards have no detail file; build a minimal one from the index.
    const { byId, idx, ja } = await catalog();
    const r = byId.get(id);
    if (!r) throw Object.assign(new Error('not found'), { status: 404 });
    const japanese = Boolean(ja.sets[r[2]]);
    const card = cardFromRow(r, idx);
    d = {
      card, ext: {}, set: { id: r[2], name: idx.sets[r[2]]?.[0], series: idx.sets[r[2]]?.[2] },
      variants: r[6].map((v) => ({ variant: v[0], label: v[0], price: v[1], priceLow: null, confidence: null, change7d: v[4], change30d: null, grades: v[2] || v[3] ? { g9: v[2], psa10: v[3] } : null, volume: null, sources: [], grading: null })),
      history: {}, rates: { era: 'modern', custom: false, p10: 0.45, p9: 0.42, p8: 0.1 }, fx: 1, signals: [], listings: [],
      links: { tcgplayer: `https://www.tcgplayer.com/product/${r[0]}`, ebaySold: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(`${r[1]} ${r[3] ?? ''}${japanese ? ' japanese' : ''}`)}&LH_Sold=1&LH_Complete=1` },
    };
  }
  const rates = LS.get<Record<string, any>>('gemRates', {})[id];
  if (rates) d = { ...d, rates: { ...d.rates, ...rates, custom: true } };
  const all = await valued();
  return { ...d, costs: costs(), holdings: all.filter((h) => h.cardId === id), watch: LS.get<any[]>('watchlist', []).filter((w) => w.cardId === id) };
}

// ---------------------------------------------------------------- router
export async function staticRequest(method: string, url: string, body?: any): Promise<any> {
  const u = new URL(url, location.origin);
  const path = u.pathname.replace(/^.*?\/api\//, '/api/');
  const q = Object.fromEntries(u.searchParams);
  const m = (re: RegExp) => re.exec(path);
  let r: RegExpExecArray | null;

  if (method === 'GET') {
    if (path === '/api/status') {
      const s = await file('status.json');
      return { ...s, counts: { ...s.counts, holdings: holdings().length } };
    }
    if (path === '/api/market') return file('market.json');
    if (path === '/api/deals') return deals(q);
    if (path === '/api/spreads') return spreads(q);
    if (path === '/api/search') return { items: await search(q.q ?? '', Number(q.limit) || 24) };
    if (path === '/api/sets') return file('sets.json');
    if (path === '/api/index') return (await index()).idx;
    if ((r = m(/^\/api\/sets\/([^/]+)$/))) return file(`sets/${decodeURIComponent(r[1])}.json`);
    if ((r = m(/^\/api\/cards\/([^/]+)$/))) return cardDetail(decodeURIComponent(r[1]));
    if (path === '/api/settings') return { ...localSettings(), static: true };
    if (path === '/api/collection') return collection(Number(q.days) || 90);
    if (path === '/api/watchlist') {
      const { byId, idx } = await catalog();
      return {
        items: LS.get<any[]>('watchlist', []).flatMap((w) => {
          const row = byId.get(w.cardId);
          if (!row) return [];
          const card = cardFromRow(row, idx, w.variant);
          return [{ card, variant: w.variant ?? card.variant, variantLabel: '', target: w.target, bestAsk: null, hit: w.target != null && card.price != null && card.price <= w.target, createdAt: w.createdAt }];
        }),
      };
    }
  }

  if (path === '/api/settings' && method === 'PUT') {
    LS.set('settings', { ...LS.get('settings', {}), ...body });
    markDataChanged();
    return { ...localSettings(), static: true };
  }
  if (path === '/api/refresh') return { started: false, running: 'GitHub Actions (every 6 hours)' };

  if (path === '/api/collection' && method === 'POST') {
    const { byId, idx } = await catalog();
    const row = byId.get(body.cardId);
    const card = row ? cardFromRow(row, idx, body.variant) : null;
    const now = Date.now();
    const h: LocalHolding = {
      id: crypto.randomUUID(), cardId: body.cardId, game: 'pokemon', name: card?.name ?? 'Card', setName: card?.set ?? null, number: card?.number ?? null,
      image: card?.image ?? null, variant: body.variant ?? card?.variant ?? null, grader: body.grader ?? null, grade: body.grade ?? null,
      condition: body.condition ?? 'NM', quantity: Math.max(1, Number(body.quantity) || 1), costBasis: body.costBasis ?? null,
      acquiredAt: body.acquiredAt ?? null, notes: body.notes ?? null, createdAt: now, updatedAt: now,
      language: body.language ?? null, customValue: body.customValue ?? null,
    };
    saveHoldings([h, ...allHoldings()], [h.id]);
    return (await valued()).find((x) => x.id === h.id);
  }
  if ((r = m(/^\/api\/collection\/([^/]+)$/))) {
    const id = decodeURIComponent(r[1]);
    if (method === 'PATCH') {
      saveHoldings(allHoldings().map((h) => (h.id === id ? { ...h, ...body, id, updatedAt: Date.now() } : h)), [id]);
      return (await valued()).find((x) => x.id === id);
    }
    if (method === 'DELETE') {
      // Kept as a deletion so it also disappears from the phone.
      saveHoldings(allHoldings().map((h) => (h.id === id ? { ...h, deleted: true, updatedAt: Date.now() } : h)), [id]);
      return { ok: true };
    }
  }
  if (path === '/api/watchlist' && method === 'PUT') {
    const list = LS.get<any[]>('watchlist', []).filter((w) => !(w.cardId === body.cardId && (w.variant ?? null) === (body.variant ?? null)));
    list.unshift({ cardId: body.cardId, variant: body.variant ?? null, target: body.target != null && body.target !== '' ? Number(body.target) : null, createdAt: Date.now() });
    LS.set('watchlist', list);
    markDataChanged();
    return { ok: true };
  }
  if ((r = m(/^\/api\/watchlist\/([^/]+)$/)) && method === 'DELETE') {
    const id = decodeURIComponent(r[1]);
    LS.set('watchlist', LS.get<any[]>('watchlist', []).filter((w) => !(w.cardId === id && (!q.variant || w.variant === q.variant || w.variant == null))));
    markDataChanged();
    return { ok: true };
  }
  if ((r = m(/^\/api\/cards\/([^/]+)\/gem-rates$/))) {
    const id = decodeURIComponent(r[1]);
    const all = LS.get<Record<string, any>>('gemRates', {});
    if (method === 'PUT') all[id] = { p10: Number(body.p10), p9: Number(body.p9), p8: Number(body.p8) };
    else delete all[id];
    LS.set('gemRates', all);
    return cardDetail(id);
  }
  throw Object.assign(new Error('Not available on the hosted site'), { status: 404 });
}
