// JSON API used by the website and the iOS app.

import { cardOut, valuationOut, gradesOut, upsertCards, upsertQuotes, img, gameLabel } from './store.js';
import { extractFeatures, matchLocal, searchCatalog } from './engine/identify.js';
import { gradeEV, ratesFor } from './engine/grading.js';
import { KINDS } from './engine/signals.js';
import { holdingValue, revalue } from './engine/valuation.js';
import { valuedHoldings, summary, sync, upsertHolding, hydrate } from './collection.js';
import { ebayConfigured, ebaySearchUrl, ebaySoldUrl } from './providers/ebay.js';
import { searchPokemon } from './providers/pokemontcg.js';
import { scryfallBySetNumber, scryfallFuzzy } from './providers/scryfall.js';
import { ygoBySetCode, ygoByName } from './providers/ygoprodeck.js';
import { searchPriceCharting } from './providers/pricecharting.js';
import { safeJSON, groupBy, log, daysAgo } from './lib/util.js';
import { networkInterfaces } from 'node:os';

export const VARIANT_LABEL = {
  normal: 'Normal', holofoil: 'Holo', reverseHolofoil: 'Reverse Holo', '1stEditionHolofoil': '1st Edition Holo',
  '1stEditionNormal': '1st Edition', unlimitedHolofoil: 'Unlimited Holo', nonfoil: 'Non-foil', foil: 'Foil', etched: 'Etched', default: '',
};
const SOURCE_LABEL = { tcgplayer: 'TCGplayer', cardmarket: 'Cardmarket', scryfall: 'TCGplayer (via Scryfall)', ygoprodeck: 'YGOPRODeck', ygo_ref: 'Card-level', pricecharting: 'PriceCharting' };

const vlabel = (v) => VARIANT_LABEL[v] ?? v;
const int = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);

/** Primary (highest-value) valuation per card id. */
function primaryVals(db, ids) {
  const out = new Map();
  const uniq = [...new Set(ids)];
  for (let i = 0; i < uniq.length; i += 500) {
    const part = uniq.slice(i, i + 500);
    const rows = db.all(`SELECT * FROM valuations WHERE card_id IN (${part.map(() => '?').join(',')})`, ...part);
    for (const [id, vs] of groupBy(rows, (r) => r.card_id)) out.set(id, vs.sort((a, b) => (b.raw ?? 0) - (a.raw ?? 0)));
  }
  return out;
}

function cardsById(db, ids) {
  const out = new Map();
  const uniq = [...new Set(ids)];
  for (let i = 0; i < uniq.length; i += 500) {
    const part = uniq.slice(i, i + 500);
    for (const r of db.all(`SELECT * FROM cards WHERE id IN (${part.map(() => '?').join(',')})`, ...part)) out.set(r.id, r);
  }
  return out;
}

function dealOut(s, cards, vals) {
  const card = cards.get(s.card_id);
  const val = vals.get(`${s.card_id}|${s.variant}`);
  const data = safeJSON(s.data, {});
  if (data.image) data.image = img(data.image);
  return {
    id: s.id,
    kind: s.kind,
    kindLabel: KINDS[s.kind]?.label ?? s.kind,
    score: s.score,
    price: s.price,
    value: s.value,
    upside: s.upside,
    discount: s.value ? Math.round((1 - s.price / s.value) * 1000) / 1000 : null,
    confidence: s.confidence,
    variant: s.variant,
    variantLabel: vlabel(s.variant),
    card: cardOut(card, val),
    data,
    computedAt: s.computed_at,
  };
}

function valsByKey(db, rows) {
  const out = new Map();
  for (const r of rows) {
    const v = db.get('SELECT * FROM valuations WHERE card_id = ? AND variant = ?', r.card_id, r.variant);
    if (v) out.set(`${r.card_id}|${r.variant}`, v);
  }
  return out;
}

const GAMES = new Set(['pokemon', 'mtg', 'yugioh', 'sports', 'other']);

function listDeals(db, q) {
  const where = ['1=1'];
  const p = [];
  if (q.kind && KINDS[q.kind]) { where.push('s.kind = ?'); p.push(q.kind); }
  if (GAMES.has(q.game)) { where.push('c.game = ?'); p.push(q.game); }
  if (q.max) { where.push('s.price <= ?'); p.push(Number(q.max)); }
  if (q.min) { where.push('s.price >= ?'); p.push(Number(q.min)); }
  if (q.minScore) { where.push('s.score >= ?'); p.push(Number(q.minScore)); }
  const order = { upside: 's.upside DESC', discount: '(s.price / s.value) ASC', price: 's.price ASC', score: 's.score DESC' }[q.sort] ?? 's.score DESC';
  const limit = Math.min(200, int(q.limit, 50));
  const offset = int(q.offset, 0);
  const rows = db.all(`SELECT s.* FROM signals s JOIN cards c ON c.id = s.card_id WHERE ${where.join(' AND ')} ORDER BY ${order}, s.id LIMIT ? OFFSET ?`, ...p, limit, offset);
  const total = db.get(`SELECT COUNT(*) n FROM signals s JOIN cards c ON c.id = s.card_id WHERE ${where.join(' AND ')}`, ...p).n;
  const cards = cardsById(db, rows.map((r) => r.card_id));
  const vals = valsByKey(db, rows);
  const counts = Object.fromEntries(db.all('SELECT kind, COUNT(*) n FROM signals GROUP BY kind').map((r) => [r.kind, r.n]));
  return { items: rows.map((s) => dealOut(s, cards, vals)), total, counts };
}

function spreadOut(s, card, val) {
  const data = safeJSON(s.data, {});
  return {
    card: cardOut(card, val),
    variant: s.variant,
    variantLabel: vlabel(s.variant),
    raw: s.raw, g9: s.g9, psa10: s.psa10,
    multiple: s.multiple, cost: s.cost, ev: s.ev, profit: s.profit, roi: s.roi, breakEven: s.break_even,
    volume: s.volume,
    ...data,
  };
}

function listSpreads(db, q) {
  const where = ['1=1'];
  const p = [];
  if (GAMES.has(q.game)) { where.push('c.game = ?'); p.push(q.game); }
  if (q.maxRaw) { where.push('s.raw <= ?'); p.push(Number(q.maxRaw)); }
  if (q.minRaw) { where.push('s.raw >= ?'); p.push(Number(q.minRaw)); }
  if (q.minProfit != null && q.minProfit !== '') { where.push('s.profit >= ?'); p.push(Number(q.minProfit)); }
  if (q.minVolume) { where.push('COALESCE(s.volume, 0) >= ?'); p.push(Number(q.minVolume)); }
  if (q.maxBreakEven) { where.push('s.break_even IS NOT NULL AND s.break_even <= ?'); p.push(Number(q.maxBreakEven)); }
  const order = { roi: 's.roi DESC', multiple: 's.multiple DESC', breakEven: 's.break_even IS NULL, s.break_even ASC', profit: 's.profit DESC', raw: 's.raw ASC' }[q.sort] ?? 's.profit DESC';
  const limit = Math.min(200, int(q.limit, 50));
  const offset = int(q.offset, 0);
  const rows = db.all(`SELECT s.* FROM spreads s JOIN cards c ON c.id = s.card_id WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`, ...p, limit, offset);
  const total = db.get(`SELECT COUNT(*) n FROM spreads s JOIN cards c ON c.id = s.card_id WHERE ${where.join(' AND ')}`, ...p).n;
  const cards = cardsById(db, rows.map((r) => r.card_id));
  const vals = valsByKey(db, rows);
  return { items: rows.map((s) => spreadOut(s, cards.get(s.card_id), vals.get(`${s.card_id}|${s.variant}`))), total };
}

function movers(db, dir, limit = 8) {
  const rows = db.all(`SELECT v.* FROM valuations v WHERE v.raw >= 5 AND v.confidence >= 0.5 AND v.change_7d IS NOT NULL
      AND v.card_id NOT IN (SELECT pc_id FROM links)
    ORDER BY v.change_7d ${dir === 'up' ? 'DESC' : 'ASC'} LIMIT ?`, limit);
  const cards = cardsById(db, rows.map((r) => r.card_id));
  return rows.filter((v) => (dir === 'up' ? v.change_7d > 0 : v.change_7d < 0)).map((v) => cardOut(cards.get(v.card_id), v));
}

function cardDetail(db, settings, id) {
  const row = db.get('SELECT * FROM cards WHERE id = ?', id);
  if (!row) return null;
  const vals = db.all('SELECT * FROM valuations WHERE card_id = ? ORDER BY raw DESC', id);
  const quotes = groupBy(db.all('SELECT * FROM quotes WHERE card_id = ?', id), (q) => q.variant);
  const links = db.all('SELECT * FROM links WHERE card_id = ?', id);
  const costs = settings.grading();
  const rates = ratesFor(db, id, row.release_date);
  const fx = settings.get().fxEurUsd;
  const variants = vals.map((v) => {
    const qs = (quotes.get(v.variant) ?? []).map((q) => ({ source: q.source, label: SOURCE_LABEL[q.source] ?? q.source, currency: q.currency, metrics: safeJSON(q.data, {}), updatedAt: q.updated_at }));
    const link = links.find((l) => l.variant === v.variant);
    if (link) {
      const pq = db.get(`SELECT * FROM quotes WHERE card_id = ? AND source = 'pricecharting'`, link.pc_id);
      if (pq) qs.push({ source: 'pricecharting', label: 'PriceCharting', currency: 'USD', metrics: safeJSON(pq.data, {}), updatedAt: pq.updated_at, linked: link.pc_id, linkConfidence: link.confidence });
    }
    return {
      ...valuationOut(v),
      label: vlabel(v.variant),
      sources: qs,
      grading: v.psa10 ? gradeEV(v, costs, rates) : null,
    };
  });
  const hist = groupBy(db.all('SELECT variant, day, raw, g9, psa10 FROM history WHERE card_id = ? ORDER BY day', id), (h) => h.variant);
  const history = Object.fromEntries([...hist].map(([v, pts]) => [v, pts.map((p) => [p.day, p.raw, p.g9, p.psa10])]));
  const sigRows = db.all('SELECT * FROM signals WHERE card_id = ? ORDER BY score DESC', id);
  const valMap = new Map(vals.map((v) => [`${v.card_id}|${v.variant}`, v]));
  const signals = sigRows.map((s) => dealOut(s, new Map([[id, row]]), valMap));
  const listings = db.all('SELECT * FROM listings WHERE card_id = ? ORDER BY price + COALESCE(shipping,0) ASC LIMIT 30', id).map((l) => ({
    itemId: l.item_id, variant: l.variant, title: l.title, price: l.price, shipping: l.shipping, total: Math.round((l.price + (l.shipping ?? 0)) * 100) / 100,
    grader: l.grader, grade: l.grade, url: l.url, image: img(l.image), seller: l.seller, feedback: l.feedback, fetchedAt: l.fetched_at,
  }));
  const holdings = valuedHoldings(db).filter((h) => h.cardId === id);
  const watch = db.all('SELECT variant, target FROM watchlist WHERE card_id = ?', id);
  const q = row.game === 'pokemon' ? `${row.name} ${row.number}${row.printed_total ? '/' + row.printed_total : ''}` : row.game === 'yugioh' ? `${row.name} ${row.set_code}` : `${row.name} ${row.set_name ?? ''}`;
  const ext = safeJSON(row.ext, {});
  return {
    card: cardOut(row, vals[0]),
    ext: { ...ext, release: row.release_date, gameLabel: gameLabel(row.game) },
    variants,
    history,
    rates,
    costs,
    fx,
    signals,
    listings,
    holdings,
    watch,
    links: {
      ebay: ebaySearchUrl(q, false),
      ebayGraded: ebaySearchUrl(`${q} PSA`, true),
      ebaySold: ebaySoldUrl(q),
      tcgplayer: ext.tcgplayer ?? null,
      cardmarket: ext.cardmarket ?? null,
      scryfall: ext.scryfall ?? null,
      pricecharting: ext.pricecharting ?? (links[0] ? `https://www.pricecharting.com/game/${links[0].pc_id.slice(3)}` : null),
    },
  };
}

async function identify(db, settings, body) {
  const f = extractFeatures(body.lines ?? [], body.game ?? 'auto');
  if (body.name && !f.name) f.name = body.name;
  let matches = matchLocal(db, f);
  if ((!matches.length || matches[0].score < 0.7) && body.live !== false) {
    const s = settings.get();
    const found = [];
    try {
      if (f.game === 'yugioh' && f.setCode) found.push(...await ygoBySetCode(f.setCode));
      else if (f.game === 'mtg' && f.setCode && f.number) found.push(await scryfallBySetNumber(f.setCode, f.number));
      else if (f.game === 'pokemon' && (f.number || f.name)) {
        const parts = [];
        if (f.name) {
          const n = f.name.replace(/["*]/g, '').trim();
          parts.push(/\s/.test(n) ? `name:"${n}"` : `name:${n}*`);
        }
        if (f.number) parts.push(`number:${f.number.replace(/^0+(?=\d)/, '')}`);
        found.push(...await searchPokemon(s, parts.join(' ')));
      } else if (f.game === 'mtg' && f.name) found.push(...await scryfallFuzzy(f.name));
      else if (f.game === 'yugioh' && f.name) found.push(...await ygoByName(f.name));
      else if (f.name || f.text) found.push(...await searchPriceCharting(s, f.name ?? f.text.slice(0, 80)));
    } catch (err) {
      log.warn(`identify live lookup: ${err.message}`);
    }
    if (found.length) {
      upsertCards(db, found.map((m) => m.card));
      upsertQuotes(db, found.flatMap((m) => m.quotes ?? (m.quote ? [m.quote] : [])));
      // Value only the new cards so they're priced immediately.
      revalue(db, s.fxEurUsd, found.map((m) => m.card.id));
      matches = matchLocal(db, f);
      if (!matches.length) matches = found.map((m) => ({ row: db.get('SELECT * FROM cards WHERE id = ?', m.card.id), score: 0.6, reason: 'live search' }));
    }
  }
  const vals = primaryVals(db, matches.map((m) => m.row.id));
  return {
    features: { game: f.game, name: f.name, number: f.number, total: f.total, setCode: f.setCode },
    candidates: matches.map((m) => {
      const vs = vals.get(m.row.id) ?? [];
      return {
        card: cardOut(m.row, vs[0]),
        variants: vs.map((v) => ({ variant: v.variant, label: vlabel(v.variant), price: v.raw, grades: gradesOut(v) })),
        score: Math.round(m.score * 100) / 100,
        reason: m.reason,
      };
    }),
  };
}

function prices(db, items = []) {
  const vals = primaryVals(db, items.map((i) => i.cardId));
  return items.map((h) => {
    const vs = vals.get(h.cardId) ?? [];
    const v = vs.find((x) => x.variant === h.variant) ?? vs[0];
    if (!v) return { cardId: h.cardId, variant: h.variant, value: null };
    const { value, basis } = holdingValue(h, v);
    return { cardId: h.cardId, variant: v.variant, value, basis, raw: v.raw, grades: gradesOut(v), change7d: v.change_7d, change30d: v.change_30d, updatedAt: v.updated_at };
  });
}

function counts(db) {
  return {
    cards: db.get('SELECT COUNT(*) n FROM cards').n,
    valued: db.get('SELECT COUNT(*) n FROM valuations').n,
    deals: db.get('SELECT COUNT(*) n FROM signals').n,
    spreads: db.get('SELECT COUNT(*) n FROM spreads WHERE profit > 0').n,
    listings: db.get('SELECT COUNT(*) n FROM listings').n,
    holdings: db.get('SELECT COUNT(*) n FROM holdings WHERE deleted = 0').n,
  };
}

function lanUrls() {
  const port = process.env.PORT ?? 8787;
  if (process.env.PUBLIC_URL) return [process.env.PUBLIC_URL];
  const out = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${port}`);
  }
  return out;
}

/** Last 30 days of raw values for small inline charts. */
function attachSparks(db, cards) {
  const since = daysAgo(30);
  for (const c of cards) {
    if (!c) continue;
    c.spark = db.all('SELECT raw FROM history WHERE card_id = ? AND variant = ? AND day >= ? AND raw IS NOT NULL ORDER BY day', c.id, c.variant, since).map((r) => r.raw);
  }
  return cards;
}

function status(db, settings, jobs) {
  const s = settings.get();
  return {
    version: '1.0.0',
    demo: s._demo,
    providers: {
      pokemon: { on: s.games.includes('pokemon'), key: Boolean(s.pokemontcgApiKey) },
      mtg: { on: s.games.includes('mtg') },
      yugioh: { on: s.games.includes('yugioh') },
      pricecharting: { on: Boolean(s.pricechartingToken) },
      ebay: { on: ebayConfigured(s) },
    },
    fx: { eurUsd: s.fxEurUsd, source: s._fxSource },
    counts: counts(db),
    lanUrls: lanUrls(),
    ...jobs.status(),
  };
}

export function createApi({ db, settings, jobs }) {
  const routes = [];
  const on = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler });
  };

  on('GET', '/api/health', () => ({ ok: true }));
  on('GET', '/api/status', () => status(db, settings, jobs));

  on('GET', '/api/market', () => {
    const deals = listDeals(db, { limit: 6 });
    const spreads = listSpreads(db, { limit: 6, minProfit: 0, minVolume: 0 });
    return {
      status: status(db, settings, jobs),
      deals: deals.items,
      dealCounts: deals.counts,
      spreads: spreads.items,
      gainers: attachSparks(db, movers(db, 'up')),
      losers: attachSparks(db, movers(db, 'down')),
    };
  });

  on('GET', '/api/deals', ({ query }) => listDeals(db, query));
  on('GET', '/api/spreads', ({ query }) => listSpreads(db, query));

  on('GET', '/api/search', ({ query }) => {
    const rows = searchCatalog(db, query.q ?? '', { game: GAMES.has(query.game) ? query.game : null, limit: Math.min(60, int(query.limit, 24)) });
    const vals = primaryVals(db, rows.map((r) => r.id));
    return { items: rows.map((r) => cardOut(r, vals.get(r.id)?.[0])) };
  });

  on('GET', '/api/cards/:id', ({ params }) => cardDetail(db, settings, params.id) ?? { error: 'not found', status: 404 });

  on('PUT', '/api/cards/:id/gem-rates', ({ params, body }) => {
    const p10 = Number(body.p10);
    if (!(p10 >= 0 && p10 <= 1)) return { error: 'p10 must be 0..1', status: 400 };
    db.run(`INSERT INTO gem_rates (card_id, p10, p9, p8) VALUES (?,?,?,?) ON CONFLICT(card_id) DO UPDATE SET p10 = excluded.p10, p9 = excluded.p9, p8 = excluded.p8`,
      params.id, p10, body.p9 != null ? Number(body.p9) : null, body.p8 != null ? Number(body.p8) : null);
    jobs.recompute();
    return cardDetail(db, settings, params.id);
  });
  on('DELETE', '/api/cards/:id/gem-rates', ({ params }) => {
    db.run('DELETE FROM gem_rates WHERE card_id = ?', params.id);
    jobs.recompute();
    return cardDetail(db, settings, params.id);
  });

  on('POST', '/api/identify', ({ body }) => identify(db, settings, body ?? {}));
  on('POST', '/api/prices', ({ body }) => ({ items: prices(db, body?.items ?? []) }));

  on('GET', '/api/collection', ({ query }) => ({ items: valuedHoldings(db), summary: summary(db, { days: int(query.days, 90) }) }));
  on('GET', '/api/collection/summary', ({ query }) => summary(db, { days: int(query.days, 90) }));
  on('POST', '/api/collection', ({ body }) => {
    if (!body?.cardId) return { error: 'cardId required', status: 400 };
    const { id } = upsertHolding(db, hydrate(db, { ...body, updatedAt: Date.now() }), { force: true });
    return valuedHoldings(db).find((h) => h.id === id);
  });
  on('PATCH', '/api/collection/:id', ({ params, body }) => {
    const cur = db.get('SELECT * FROM holdings WHERE id = ?', params.id);
    if (!cur) return { error: 'not found', status: 404 };
    const merged = { cardId: cur.card_id, game: cur.game, name: cur.name, setName: cur.set_name, number: cur.number, image: cur.image, variant: cur.variant,
      grader: cur.grader, grade: cur.grade, condition: cur.condition, quantity: cur.quantity, costBasis: cur.cost_basis, acquiredAt: cur.acquired_at, notes: cur.notes,
      createdAt: cur.created_at, ...body, id: params.id, updatedAt: Date.now() };
    upsertHolding(db, merged, { force: true });
    return valuedHoldings(db).find((h) => h.id === params.id);
  });
  on('DELETE', '/api/collection/:id', ({ params }) => {
    db.run('UPDATE holdings SET deleted = 1, updated_at = ? WHERE id = ?', Date.now(), params.id);
    return { ok: true };
  });
  on('POST', '/api/collection/sync', ({ body }) => sync(db, body?.items ?? [], body?.since ?? 0));

  on('GET', '/api/watchlist', () => {
    const rows = db.all('SELECT * FROM watchlist ORDER BY created_at DESC');
    const cards = cardsById(db, rows.map((r) => r.card_id));
    return {
      items: rows.map((w) => {
        const v = db.get('SELECT * FROM valuations WHERE card_id = ? AND variant = ?', w.card_id, w.variant);
        const best = db.get('SELECT MIN(price) p FROM signals WHERE card_id = ? AND variant = ?', w.card_id, w.variant)?.p ?? null;
        return { card: cardOut(cards.get(w.card_id), v), variant: w.variant, variantLabel: vlabel(w.variant), target: w.target, bestAsk: best, hit: w.target != null && v?.raw != null && v.raw <= w.target, createdAt: w.created_at };
      }),
    };
  });
  on('PUT', '/api/watchlist', ({ body }) => {
    if (!body?.cardId) return { error: 'cardId required', status: 400 };
    const variant = body.variant ?? db.get('SELECT variant FROM valuations WHERE card_id = ? ORDER BY raw DESC', body.cardId)?.variant ?? 'default';
    db.run(`INSERT INTO watchlist (card_id, variant, target, created_at) VALUES (?,?,?,?) ON CONFLICT(card_id, variant) DO UPDATE SET target = excluded.target`,
      body.cardId, variant, body.target != null && body.target !== '' ? Number(body.target) : null, Date.now());
    return { ok: true, variant };
  });
  on('DELETE', '/api/watchlist/:id', ({ params, query }) => {
    if (query.variant) db.run('DELETE FROM watchlist WHERE card_id = ? AND variant = ?', params.id, query.variant);
    else db.run('DELETE FROM watchlist WHERE card_id = ?', params.id);
    return { ok: true };
  });

  on('GET', '/api/settings', () => settings.public());
  on('PUT', '/api/settings', ({ body }) => {
    const patch = { ...(body ?? {}) };
    // Masked secrets coming back unchanged must not overwrite the real value.
    for (const [k, v] of Object.entries(patch)) if (typeof v === 'string' && v.startsWith('••••')) delete patch[k];
    settings.set(patch);
    if (['gradingFee', 'gradingShipping', 'sellFeePct', 'sellFixed', 'fxEurUsd'].some((k) => k in patch)) jobs.recompute();
    return settings.public();
  });

  on('POST', '/api/refresh', ({ body }) => jobs.trigger(body?.what ?? 'all'));

  return async function handle(method, path, query, body) {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(path);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      return await r.handler({ params, query, body });
    }
    return undefined;
  };
}
