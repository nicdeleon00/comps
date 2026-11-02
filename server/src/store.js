// Write helpers for the catalog. Providers produce plain objects; this module
// persists them in batched transactions.

import { safeJSON, yearOf } from './lib/util.js';

export function upsertCards(db, cards) {
  if (!cards.length) return 0;
  const sql = `INSERT INTO cards (id, game, name, set_name, set_code, number, printed_total, rarity, release_date, image, image_large, ext, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET game=excluded.game, name=excluded.name, set_name=excluded.set_name, set_code=excluded.set_code,
      number=excluded.number, printed_total=excluded.printed_total, rarity=excluded.rarity, release_date=excluded.release_date,
      image=COALESCE(excluded.image, cards.image), image_large=COALESCE(excluded.image_large, cards.image_large),
      ext=excluded.ext, updated_at=excluded.updated_at`;
  const t = Date.now();
  db.tx(() => {
    for (const c of cards) {
      db.run(sql, c.id, c.game, c.name, c.setName ?? null, c.setCode ?? null, c.number ?? null, c.printedTotal ?? null,
        c.rarity ?? null, c.releaseDate ?? null, c.image ?? null, c.imageLarge ?? null, c.ext ? JSON.stringify(c.ext) : null, t);
    }
  });
  return cards.length;
}

export function upsertQuotes(db, quotes) {
  if (!quotes.length) return 0;
  const sql = `INSERT INTO quotes (card_id, variant, source, currency, data, updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(card_id, variant, source) DO UPDATE SET currency=excluded.currency, data=excluded.data, updated_at=excluded.updated_at`;
  const t = Date.now();
  db.tx(() => {
    for (const q of quotes) {
      db.run(sql, q.cardId, q.variant, q.source, q.currency ?? 'USD', JSON.stringify(q.data), q.updatedAt ?? t);
    }
  });
  return quotes.length;
}

/** Drops quotes a provider no longer reports (e.g. card fell under min price). */
export function pruneQuotes(db, source, olderThan, idPrefix = '') {
  return db.run('DELETE FROM quotes WHERE source = ? AND updated_at < ? AND card_id LIKE ?', source, olderThan, `${idPrefix}%`).changes;
}

export function setJob(db, name, patch) {
  const cur = db.get('SELECT * FROM jobs WHERE name = ?', name) ?? { name };
  const next = { ...cur, ...patch };
  db.run(
    `INSERT INTO jobs (name, status, started_at, finished_at, items, message) VALUES (?,?,?,?,?,?)
     ON CONFLICT(name) DO UPDATE SET status=excluded.status, started_at=excluded.started_at, finished_at=excluded.finished_at, items=excluded.items, message=excluded.message`,
    name, next.status ?? null, next.started_at ?? null, next.finished_at ?? null, next.items ?? null, next.message ?? null,
  );
}

const GAME_LABEL = { pokemon: 'Pokémon', mtg: 'Magic', yugioh: 'Yu-Gi-Oh!', sports: 'Sports', other: 'Other' };
export const gameLabel = (g) => GAME_LABEL[g] ?? g;

/** Rewrites remote image URLs through the local caching proxy. */
export function img(url) {
  if (!url) return null;
  return `/img?u=${encodeURIComponent(url)}`;
}

/** Shape a card row (+ optional valuation row) for API responses. */
export function cardOut(row, val) {
  if (!row) return null;
  const ext = safeJSON(row.ext, {});
  return {
    id: row.id,
    game: row.game,
    name: row.name,
    set: row.set_name,
    setCode: row.set_code,
    number: row.number,
    total: row.printed_total,
    rarity: row.rarity,
    year: yearOf(row.release_date),
    image: img(row.image),
    imageLarge: img(row.image_large ?? row.image),
    tags: ext.tags ?? undefined,
    ...(val ? valuationOut(val) : {}),
  };
}

export function valuationOut(v) {
  return {
    variant: v.variant,
    price: v.raw,
    priceLow: v.raw_low,
    confidence: v.confidence,
    change7d: v.change_7d,
    change30d: v.change_30d,
    grades: gradesOut(v),
    volume: v.volume,
  };
}

export function gradesOut(v) {
  const g = {};
  for (const k of ['g7', 'g8', 'g9', 'g95', 'psa10', 'bgs10', 'cgc10', 'sgc10']) if (v[k] != null) g[k] = v[k];
  return Object.keys(g).length ? g : null;
}

/** Card + its primary (highest-value) variant valuation, many ids at once. */
export function loadCards(db, ids) {
  if (!ids.length) return new Map();
  const out = new Map();
  const uniq = [...new Set(ids)];
  for (let i = 0; i < uniq.length; i += 500) {
    const part = uniq.slice(i, i + 500);
    const ph = part.map(() => '?').join(',');
    for (const r of db.all(`SELECT * FROM cards WHERE id IN (${ph})`, ...part)) out.set(r.id, r);
  }
  return out;
}

export function loadValuation(db, cardId, variant) {
  return db.get('SELECT * FROM valuations WHERE card_id = ? AND variant = ?', cardId, variant);
}
