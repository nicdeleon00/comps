// TCGCSV (tcgcsv.com): daily dumps of TCGplayer's catalog and prices.
// Every English Pokémon set (category 3), every card, every printing, with
// market / low / mid / high / direct-low prices. Free, no key.

import { getJSON } from '../lib/http.js';
import { upsertCards, upsertQuotes } from '../store.js';
import { log } from '../lib/util.js';

const BASE = process.env.TCGCSV_BASE ?? 'https://tcgcsv.com/tcgplayer';
const POKEMON_CATEGORY = 3;

const SUBTYPE = {
  Normal: 'normal',
  Holofoil: 'holofoil',
  'Reverse Holofoil': 'reverseHolofoil',
  '1st Edition Holofoil': '1stEditionHolofoil',
  '1st Edition Normal': '1stEditionNormal',
  '1st Edition': '1stEditionNormal',
  'Unlimited Holofoil': 'unlimitedHolofoil',
  Unlimited: 'normal',
};

export function variantKey(subTypeName) {
  if (SUBTYPE[subTypeName]) return SUBTYPE[subTypeName];
  const words = String(subTypeName || 'default').split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('') || 'default';
}

// Era of a set, from its TCGplayer name, falling back to its release date.
const SERIES_RULES = [
  [/^ME\d*:|^ME:|^MEE:|^MEP\b|Mega Evolution/i, 'Mega Evolution'],
  [/^SV\d*:|^SV:|^SVE:|^SVP\b|Scarlet & Violet/i, 'Scarlet & Violet'],
  [/^SWSH\d*:|^SWSH:|Sword & Shield|Shining Fates|Champion's Path|^Celebrations|^Pokemon GO$/i, 'Sword & Shield'],
  [/^SM\b|^SM -|Hidden Fates|Detective Pikachu|Dragon Majesty|Shining Legends|Cosmic Eclipse/i, 'Sun & Moon'],
  [/^XY\b|^XY -|^Generations|Double Crisis|Kalos Starter/i, 'XY'],
  [/Black and White|^BW |Legendary Treasures|Plasma (Storm|Freeze|Blast)|Boundaries Crossed|Dragon Vault|Dragons Exalted|Dark Explorers|Next Destinies|Noble Victories|Emerging Powers/i, 'Black & White'],
  [/HeartGold|HGSS|Call of Legends|^Triumphant|^Undaunted|^Unleashed/i, 'HeartGold & SoulSilver'],
  [/Platinum|^Arceus|Supreme Victors|Rising Rivals|^Rumble|Diamond and Pearl|^DP |Stormfront|Legends Awakened|Majestic Dawn|Great Encounters|Secret Wonders|Mysterious Treasures/i, 'Diamond & Pearl'],
  [/^EX\b|^EX Trainer/i, 'EX'],
  [/^Expedition|^Aquapolis|^Skyridge|e-Reader/i, 'e-Card'],
  [/^Neo |Southern Islands/i, 'Neo'],
  [/^POP Series/i, 'POP'],
  [/Legendary Collection|^Base Set|^Jungle$|^Fossil$|^Team Rocket$|^Gym |WoTC|Best of Promos/i, 'Wizards of the Coast'],
];
const SERIES_BY_DATE = [
  ['2025-09-01', 'Mega Evolution'], ['2023-03-01', 'Scarlet & Violet'], ['2020-02-01', 'Sword & Shield'], ['2017-02-01', 'Sun & Moon'],
  ['2014-02-01', 'XY'], ['2011-04-01', 'Black & White'], ['2010-02-01', 'HeartGold & SoulSilver'], ['2007-05-01', 'Diamond & Pearl'],
  ['2003-06-01', 'EX'], ['2001-09-01', 'e-Card'], ['2000-12-01', 'Neo'], ['1990-01-01', 'Wizards of the Coast'],
];

export const SERIES_ORDER = ['Mega Evolution', 'Scarlet & Violet', 'Sword & Shield', 'Sun & Moon', 'XY', 'Black & White', 'HeartGold & SoulSilver',
  'Diamond & Pearl', 'EX', 'POP', 'e-Card', 'Neo', 'Wizards of the Coast', 'Promos & other'];

export function seriesFor(name, released) {
  for (const [re, s] of SERIES_RULES) if (re.test(name)) return s;
  if (released) for (const [d, s] of SERIES_BY_DATE) if (released >= d) return s;
  return 'Promos & other';
}

/** "SWSH07: Evolving Skies" -> "Evolving Skies", "SM - Cosmic Eclipse" -> "Cosmic Eclipse". */
export function cleanSetName(name) {
  return String(name)
    .replace(/^(?:ME|SV|SWSH|SM|XY|MEE|SVE)\d*\s*:\s*/i, '')
    .replace(/^(?:SM|XY)\s+-\s+/i, '')
    .trim();
}

const ext = (p, key) => p.extendedData?.find((e) => e.name === key)?.value ?? null;

/** Maps one TCGplayer product to a catalog card, or null for sealed product. */
export function mapProduct(p, group) {
  const numberRaw = ext(p, 'Number');
  if (!numberRaw) return null;
  const [number, total] = String(numberRaw).split('/').map((s) => s.trim());
  // TCGplayer appends " - 001/165" to some names; keep "(Alternate Full Art)"-style qualifiers.
  const name = String(p.name).replace(/\s+-\s+[A-Za-z]*\d+[a-z]?(?:\/[A-Za-z]*\d+)?\s*$/, '').trim();
  const baseName = name.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const img = p.imageUrl || `https://tcgplayer-cdn.tcgplayer.com/product/${p.productId}_200w.jpg`;
  return {
    id: `tcg:${p.productId}`,
    game: 'pokemon',
    name,
    setName: group.cleanName,
    setCode: group.abbreviation || null,
    number,
    printedTotal: total || null,
    rarity: ext(p, 'Rarity'),
    releaseDate: group.released,
    image: img,
    imageLarge: img.replace(/_200w\.jpg$/, '_400w.jpg'),
    ext: { groupId: group.groupId, series: group.series, baseName, tcgplayer: p.url, productId: p.productId, cardType: ext(p, 'Card Type') ?? undefined },
  };
}

export function mapPrice(r) {
  if (r.marketPrice == null && r.midPrice == null) return null;
  return {
    cardId: `tcg:${r.productId}`,
    variant: variantKey(r.subTypeName),
    source: 'tcgplayer',
    currency: 'USD',
    data: { market: r.marketPrice ?? null, low: r.lowPrice ?? null, mid: r.midPrice ?? null, high: r.highPrice ?? null, directLow: r.directLowPrice ?? null },
  };
}

/** Tags each group with its era and a usable release date. */
export function prepareGroups(groups) {
  // Many old or odd groups share a placeholder publish date; don't trust those.
  const counts = new Map();
  for (const g of groups) counts.set(g.publishedOn?.slice(0, 10), (counts.get(g.publishedOn?.slice(0, 10)) ?? 0) + 1);
  return groups.map((g) => {
    const d = g.publishedOn?.slice(0, 10) ?? null;
    const released = d && counts.get(d) < 6 ? d : null;
    return { ...g, released, cleanName: cleanSetName(g.name), series: seriesFor(g.name, released) };
  });
}

export async function refreshTcgcsv(db, settings, onProgress = () => {}) {
  const started = Date.now();
  const res = await getJSON(`${BASE}/${POKEMON_CATEGORY}/groups`, { timeout: 30_000, retries: 3 });
  const groups = prepareGroups(res.results ?? []);
  if (!groups.length) throw new Error('TCGCSV returned no Pokémon sets');
  const known = new Map(db.all('SELECT id, modified, cards FROM sets').map((s) => [s.id, s]));
  let cardsTotal = 0;
  let pricesTotal = 0;
  let i = 0;
  const ok = [];
  for (const g of groups) {
    i++;
    const id = String(g.groupId);
    const prev = known.get(id);
    try {
      // Card list only changes when TCGplayer edits the set; prices change daily.
      if (!prev || prev.modified !== g.modifiedOn || !prev.cards) {
        const products = await getJSON(`${BASE}/${POKEMON_CATEGORY}/${g.groupId}/products`, { minInterval: 50, timeout: 30_000, retries: 3 });
        const cards = (products.results ?? []).map((p) => mapProduct(p, g)).filter(Boolean);
        upsertCards(db, cards);
        cardsTotal += cards.length;
      }
      const prices = await getJSON(`${BASE}/${POKEMON_CATEGORY}/${g.groupId}/prices`, { minInterval: 50, timeout: 30_000, retries: 3 });
      const quotes = (prices.results ?? []).map(mapPrice).filter(Boolean);
      // Only keep prices for products that are cards (sealed product is skipped).
      const ids = new Set(db.all('SELECT id FROM cards WHERE group_id = ?', g.groupId).map((r) => r.id));
      const kept = quotes.filter((q) => ids.has(q.cardId));
      upsertQuotes(db, kept);
      pricesTotal += kept.length;
      db.run(`INSERT INTO sets (id, name, code, series, released, supplemental, modified, cards) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, code=excluded.code, series=excluded.series, released=excluded.released,
          supplemental=excluded.supplemental, modified=excluded.modified, cards=excluded.cards`,
        id, g.cleanName, g.abbreviation || null, g.series, g.released, g.isSupplemental ? 1 : 0, g.modifiedOn ?? null, ids.size);
      ok.push(g.groupId);
    } catch (err) {
      log.warn(`tcgcsv ${g.name}: ${err.message}`);
    }
    onProgress(i, groups.length);
  }
  // Drop prices TCGplayer stopped reporting — only for sets we fetched successfully.
  let pruned = 0;
  for (const gid of ok) {
    pruned += db.run(`DELETE FROM quotes WHERE source = 'tcgplayer' AND updated_at < ? AND card_id IN
      (SELECT id FROM cards WHERE group_id = ?)`, started - 1000, gid).changes;
  }
  log.info(`tcgcsv: ${groups.length} sets, ${cardsTotal} cards updated, ${pricesTotal} prices (${pruned} stale removed)`);
  return pricesTotal;
}
