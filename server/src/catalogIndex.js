// The compact card catalog the website and the iPhone app use for search,
// scanning, pricing and master sets (published as data/index.json).
//
//   cards: [productId, name, setId, number, total, rarity, [[variant, raw, g9, psa10, change7d], ...]] (regular printing first;
//          empty for a card with no price yet, such as a promo that just came out, so it can still be scanned and added)
//   sets:  { setId: [name, code, series, released, reprint (1 = reprint product; the scanner prefers originals)] }

import { reprintGroups } from './engine/printings.js';

const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

// The regular printing first (what a card defaults to); 1st Edition always last, after any printing
// not listed here, so it's never the default while another printing exists.
const PRINTING_RANK = { normal: 0, holofoil: 1, unlimitedHolofoil: 2, reverseHolofoil: 3, '1stEditionNormal': 50, '1stEditionHolofoil': 51 };
const rank = (v) => PRINTING_RANK[v] ?? (/^1stEdition/i.test(v) ? 52 : 9);
export const byPrinting = (a, b) => rank(a[0]) - rank(b[0]) || (b[1] ?? 0) - (a[1] ?? 0);

export function buildIndex(db) {
  const reprints = reprintGroups(db);
  const sets = Object.fromEntries(db.all('SELECT * FROM sets WHERE cards > 0').map((s) => [s.id, [s.name, s.code, s.series, s.released, reprints.has(String(s.id)) ? 1 : 0]]));
  const vals = new Map();
  for (const v of db.all(`SELECT card_id, variant, raw, g9, psa10, change_7d FROM valuations WHERE card_id LIKE 'tcg:%'`)) {
    if (!vals.has(v.card_id)) vals.set(v.card_id, []);
    vals.get(v.card_id).push([v.variant, r2(v.raw), r2(v.g9), r2(v.psa10), v.change_7d == null ? null : Math.round(v.change_7d * 1000) / 1000]);
  }
  const cards = [];
  for (const c of db.all(`SELECT id, name, group_id, number, printed_total, rarity FROM cards WHERE id LIKE 'tcg:%'`)) {
    const pv = vals.get(c.id) ?? [];
    pv.sort(byPrinting);
    cards.push([Number(c.id.slice(4)), c.name, String(c.group_id ?? ''), c.number, c.printed_total, c.rarity, pv]);
  }
  return { v: 1, updatedAt: Date.now(), imageBase: 'https://tcgplayer-cdn.tcgplayer.com/product/', sets, cards };
}
