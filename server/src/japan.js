// Japanese Pokémon cards: TCGplayer's "Pokemon Japan" category, through TCGCSV.
//
// They go into their own catalog file, data/index-ja.json, in the same shape as index.json, and
// are kept out of the English database tables so Japanese prices never mix into the English
// pages, deals and master sets. The card lists are cached in the database (refetched only when
// TCGplayer changes a set), prices about once a day; if TCGCSV is down, the last catalog is used.

import { getJSON } from './lib/http.js';
import { variantKey, prepareGroups, seriesFor } from './providers/tcgcsv.js';
import { byPrinting } from './catalogIndex.js';
import { log } from './lib/util.js';

const BASE = process.env.TCGCSV_BASE ?? 'https://tcgcsv.com/tcgplayer';
export const JAPAN_CATEGORY = 85;
const PRICES_EVERY = 20 * 3600_000;

/** "SV2a: Pokemon Card 151" -> "Pokemon Card 151"; names without a code stay as they are. */
export function cleanJapaneseSetName(name) {
  return String(name).replace(/^[A-Za-z]{1,4}\d{0,3}[A-Za-z]?\s*:\s*/, '').trim();
}

/** Era from the Japanese set code ("SV2a", "S12a", "SM12a", "M1L"), else from the name and date. */
export function japaneseSeries(code, name, released) {
  const c = String(code || '').toUpperCase();
  if (/^M\d/.test(c) || /^MC|^MBG|^MBD/.test(c)) return 'Mega Evolution';
  if (/^SV/.test(c)) return 'Scarlet & Violet';
  if (/^SM/.test(c)) return 'Sun & Moon';
  if (/^S\d|^SA|^SC|^SI|^SJ|^SK|^SP|^SH/.test(c)) return 'Sword & Shield';
  if (/^XY|^CP/.test(c)) return 'XY';
  if (/^BW|^EBB/.test(c)) return 'Black & White';
  return seriesFor(name, released);
}

/** "Pikachu - 025/165 (Poke Ball Pattern)" -> "Pikachu (Poke Ball Pattern)": the number is shown separately. */
export function cleanJapaneseName(name) {
  return String(name).replace(/\s+-\s+[A-Za-z]*\d+[a-z]?(?:\/[A-Za-z0-9-]+)?(?=\s*(?:\(|\[|$))/, '').replace(/\s+/g, ' ').trim();
}

/** One product to a catalog row ([id, name, set, number, total, rarity]), or null for sealed product. */
export function japaneseCard(p, groupId) {
  const numberRaw = p.extendedData?.find((e) => e.name === 'Number')?.value;
  if (!numberRaw) return null;
  const [number, total] = String(numberRaw).split('/').map((s) => s.trim());
  const name = cleanJapaneseName(p.name);
  const rarity = p.extendedData?.find((e) => e.name === 'Rarity')?.value;
  return [p.productId, name, String(groupId), number, total || null, rarity && rarity !== 'None' ? rarity : null];
}

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS japan_sets (
    id TEXT PRIMARY KEY, modified TEXT, prices_at INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL)`);
}

/** Refreshes the cached Japanese catalog. Never throws: a failure keeps the last catalog. */
export async function refreshJapan(db) {
  ensureTable(db);
  let groups;
  try {
    groups = prepareGroups((await getJSON(`${BASE}/${JAPAN_CATEGORY}/groups`, { timeout: 30_000, retries: 3 })).results ?? []);
  } catch (err) {
    log.warn(`japan: couldn't list sets (${err.message}); keeping the last catalog`);
    return 0;
  }
  const known = new Map(db.all('SELECT id, modified, prices_at FROM japan_sets').map((r) => [r.id, r]));
  let updated = 0;
  for (const g of groups) {
    const id = String(g.groupId);
    const prev = known.get(id);
    try {
      let data = prev ? JSON.parse(db.get('SELECT data FROM japan_sets WHERE id = ?', id).data) : null;
      if (!data || prev.modified !== g.modifiedOn) {
        const products = (await getJSON(`${BASE}/${JAPAN_CATEGORY}/${g.groupId}/products`, { minInterval: 50, timeout: 30_000, retries: 3 })).results ?? [];
        const cards = products.map((p) => japaneseCard(p, g.groupId)).filter(Boolean);
        data = { set: [cleanJapaneseSetName(g.name), g.abbreviation || null, japaneseSeries(g.abbreviation, g.name, g.released), g.released, 0], cards, prices: data?.prices ?? {} };
      }
      let pricesAt = prev?.prices_at ?? 0;
      if (Date.now() - pricesAt > PRICES_EVERY && data.cards.length) {
        const rows = (await getJSON(`${BASE}/${JAPAN_CATEGORY}/${g.groupId}/prices`, { minInterval: 50, timeout: 30_000, retries: 3 })).results ?? [];
        const prices = {};
        for (const r of rows) {
          const v = r.marketPrice ?? r.midPrice;
          if (v == null) continue;
          (prices[r.productId] ??= []).push([variantKey(r.subTypeName), Math.round(v * 100) / 100]);
        }
        data.prices = prices;
        pricesAt = Date.now();
      }
      db.run(`INSERT INTO japan_sets (id, modified, prices_at, data) VALUES (?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET modified = excluded.modified, prices_at = excluded.prices_at, data = excluded.data`,
        id, g.modifiedOn ?? null, pricesAt, JSON.stringify(data));
      updated++;
    } catch (err) {
      log.warn(`japan ${g.name}: ${err.message}`);
    }
  }
  log.info(`japan: ${groups.length} sets, ${updated} checked`);
  return updated;
}

/** The Japanese catalog file: same shape as index.json, with every set marked Japanese. */
export function buildJapaneseIndex(db) {
  ensureTable(db);
  const sets = {};
  const cards = [];
  for (const r of db.all('SELECT id, data FROM japan_sets')) {
    const data = JSON.parse(r.data);
    let n = 0;
    for (const c of data.cards) {
      // A card with no price yet (a new promo) is still listed, so it can be scanned and added.
      const pv = (data.prices[c[0]] ?? []).map(([variant, raw]) => [variant, raw, null, null, null]);
      pv.sort(byPrinting);
      cards.push([c[0], cleanJapaneseName(c[1]), ...c.slice(2), pv]);
      n++;
    }
    if (n) sets[r.id] = data.set;
  }
  return { v: 1, lang: 'ja', updatedAt: Date.now(), imageBase: 'https://tcgplayer-cdn.tcgplayer.com/product/', sets, cards };
}
