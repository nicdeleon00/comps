// PriceCharting (paid subscription token). The only source here with graded
// prices: ungraded, grade 7, 8, 9, 9.5, PSA 10, BGS 10, CGC 10, SGC 10 —
// which is what powers the raw → graded spread engine. Also covers sports cards.

import { getText } from '../lib/http.js';
import { upsertCards, upsertQuotes, pruneQuotes } from '../store.js';
import { parseCSV, money, norm, similarity, log, groupBy } from '../lib/util.js';

const BASE = process.env.PRICECHARTING_BASE ?? 'https://www.pricecharting.com';

const GAME_BY_CATEGORY = {
  'pokemon-cards': 'pokemon',
  'magic-cards': 'mtg',
  'yugioh-cards': 'yugioh',
};

// PriceCharting reuses its video-game column names for card grades.
const GRADE_COLUMNS = {
  ungraded: 'loose-price',
  g7: 'cib-price',
  g8: 'new-price',
  g9: 'graded-price',
  g95: 'box-only-price',
  psa10: 'manual-only-price',
  bgs10: 'bgs-10-price',
  cgc10: 'condition-17-price',
  sgc10: 'condition-18-price',
};

/** "Charizard [1st Edition] #4" -> { base: "Charizard", tags: ["1st Edition"], number: "4" } */
export function parseProductName(name) {
  const tags = [...String(name).matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].trim());
  let rest = String(name).replace(/\[[^\]]*\]/g, ' ');
  let number = null;
  const m = /#\s*([A-Za-z0-9][A-Za-z0-9\-\/]*)\s*$/.exec(rest);
  if (m) {
    number = m[1];
    rest = rest.slice(0, m.index);
  }
  return { base: rest.replace(/\s+/g, ' ').trim(), tags, number };
}

function stripConsole(consoleName, game) {
  const prefix = { pokemon: /^pokemon\s+/i, mtg: /^magic\s+/i, yugioh: /^yugioh\s+/i }[game];
  return prefix ? consoleName.replace(prefix, '') : consoleName;
}

export function mapRow(row, category) {
  const id = row.id ?? row['id'];
  const productName = row['product-name'];
  if (!id || !productName) return null;
  const game = GAME_BY_CATEGORY[category] ?? 'sports';
  const p = parseProductName(productName);
  const consoleName = row['console-name'] ?? '';
  const data = {};
  for (const [k, col] of Object.entries(GRADE_COLUMNS)) data[k] = money(row[col]);
  data.volume = Number(row['sales-volume']) || null;
  if (!data.ungraded && !data.psa10 && !data.g9) return null;
  const card = {
    id: `pc:${id}`,
    game: game === 'sports' && !/card/i.test(category) ? 'other' : game,
    name: p.base || productName,
    setName: stripConsole(consoleName, game),
    setCode: consoleName,
    number: p.number,
    printedTotal: null,
    rarity: null,
    releaseDate: row['release-date'] || null,
    image: null,
    imageLarge: null,
    ext: { pricecharting: `${BASE}/game/${id}`, tags: p.tags.length ? p.tags : undefined, category, tcgId: row['tcg-id'] || null },
  };
  return { card, quote: { cardId: card.id, variant: 'default', source: 'pricecharting', currency: 'USD', data } };
}

export async function refreshPriceCharting(db, settings, onProgress = () => {}) {
  const token = settings.pricechartingToken;
  if (!token) return 0;
  const started = Date.now();
  const categories = String(settings.pricechartingCategories).split(',').map((s) => s.trim()).filter(Boolean);
  let total = 0;
  for (const category of categories) {
    let text;
    try {
      text = await getText(`${BASE}/price-guide/download-custom?t=${encodeURIComponent(token)}&category=${encodeURIComponent(category)}`, { timeout: 300_000, retries: 2 });
    } catch (err) {
      log.warn(`pricecharting ${category}: ${err.message}`);
      continue;
    }
    let cards = [];
    let quotes = [];
    for (const row of parseCSV(text)) {
      const m = mapRow(row, category);
      if (!m) continue;
      cards.push(m.card);
      quotes.push(m.quote);
      if (cards.length >= 2000) {
        upsertCards(db, cards); upsertQuotes(db, quotes);
        total += cards.length; cards = []; quotes = [];
        onProgress(total, null);
      }
    }
    upsertCards(db, cards); upsertQuotes(db, quotes);
    total += cards.length;
    log.info(`pricecharting ${category}: done (${total} total)`);
  }
  if (total) pruneQuotes(db, 'pricecharting', started, 'pc:');
  linkPriceCharting(db);
  return total;
}

// ---------------------------------------------------------------------------
// Linking PriceCharting products to catalog cards (images, variants, FMV).

const SET_NOISE = /\b(pokemon|set|the|tcg|cards?|and)\b/g;
const setNorm = (s) => norm(s).replace(SET_NOISE, ' ').replace(/\s+/g, ' ').trim();
const numNorm = (n) => String(n ?? '').toLowerCase().replace(/-(en|eu|na|de|fr|it|sp|pt)(?=\d)/, '').replace(/[^a-z0-9]/g, '').replace(/^0+(?=\d)/, '');
const nameNorm = (s) => norm(s).replace(/\b(holo|rare|card)\b/g, '').replace(/\s+/g, ' ').trim();

function variantFor(tags, available) {
  const t = tags.map((x) => x.toLowerCase());
  if (t.some((x) => x.includes('japanese') || x.includes('error') || x.includes('misprint'))) return null;
  if (t.some((x) => x.includes('reverse'))) return available.includes('reverseHolofoil') ? 'reverseHolofoil' : null;
  if (t.some((x) => x.includes('1st edition'))) {
    return ['1stEditionHolofoil', '1stEditionNormal'].find((v) => available.includes(v)) ?? null;
  }
  // Shadowless is its own TCGplayer set; the set match handles it.
  const known = t.filter((x) => !x.includes('shadowless') && !x.includes('holo'));
  if (known.length) return null; // unknown printing tag — don't guess
  return ['holofoil', 'unlimitedHolofoil', 'normal', 'default'].find((v) => available.includes(v)) ?? available.find((v) => v !== 'reverseHolofoil') ?? null;
}

export function linkPriceCharting(db) {
  const pcs = db.all(`SELECT id, game, name, set_code, number, ext FROM cards WHERE id LIKE 'pc:%' AND game = 'pokemon'`);
  if (!pcs.length) return 0;
  const catalog = db.all(`SELECT c.id, c.base_name, c.name, c.set_name, c.number, c.ext,
      (SELECT group_concat(DISTINCT variant) FROM quotes q WHERE q.card_id = c.id) AS variants
    FROM cards c WHERE c.id LIKE 'tcg:%'`);
  const byKey = groupBy(catalog, (c) => `${nameNorm(c.base_name || c.name)}|${numNorm(c.number)}`);
  const byProduct = new Map(catalog.map((c) => [c.id.slice(4), c]));
  const links = [];
  for (const pc of pcs) {
    if (/japanese|chinese|korean/i.test(pc.set_code ?? '')) continue;
    const ext = JSON.parse(pc.ext ?? '{}');
    const tags = ext.tags ?? [];
    const shadowless = tags.some((x) => /shadowless/i.test(x));
    let best = null;
    let bestScore = 0;
    // PriceCharting carries the TCGplayer product id for many cards: exact match.
    if (ext.tcgId && byProduct.has(String(ext.tcgId))) {
      best = byProduct.get(String(ext.tcgId));
      bestScore = 1;
    } else {
      const candidates = byKey.get(`${nameNorm(pc.name)}|${numNorm(pc.number)}`) ?? [];
      const pcSet = setNorm(pc.set_code);
      for (const c of candidates) {
        if (shadowless !== /shadowless/i.test(c.set_name ?? '')) continue;
        const cs = setNorm(String(c.set_name ?? '').replace(/\(shadowless\)/i, ''));
        let s = similarity(pcSet, cs);
        if (cs && (pcSet.includes(cs) || cs.includes(pcSet))) s = Math.max(s, 0.85);
        if (s > bestScore) { bestScore = s; best = c; }
      }
      if (!pc.number) bestScore *= 0.9;
    }
    if (!best || bestScore < 0.62) continue;
    const variant = variantFor(tags, (best.variants ?? '').split(',').filter(Boolean));
    if (!variant) continue;
    links.push([best.id, variant, pc.id, Math.round(bestScore * 100) / 100]);
  }
  db.tx(() => {
    db.run('DELETE FROM links');
    for (const l of links) {
      db.run(`INSERT INTO links (card_id, variant, pc_id, confidence) VALUES (?,?,?,?)
        ON CONFLICT(card_id, variant) DO UPDATE SET pc_id = excluded.pc_id, confidence = excluded.confidence
        WHERE excluded.confidence > links.confidence`, ...l);
    }
  });
  log.info(`pricecharting: linked ${links.length} of ${pcs.length} products to catalog cards`);
  return links.length;
}
