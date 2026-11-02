// Pokémon TCG API (pokemontcg.io). Free; an API key raises rate limits.
// Gives every English card with TCGplayer (USD) and Cardmarket (EUR) prices.

import { getJSON } from '../lib/http.js';
import { upsertCards, upsertQuotes, pruneQuotes } from '../store.js';
import { log } from '../lib/util.js';

const BASE = process.env.POKEMONTCG_BASE ?? 'https://api.pokemontcg.io/v2';
const SELECT = 'id,name,number,rarity,set,images,tcgplayer,cardmarket';

// Order of preference when picking which TCGplayer variant Cardmarket's
// (non-reverse) prices belong to.
const PRIMARY_ORDER = ['holofoil', 'normal', '1stEditionHolofoil', 'unlimitedHolofoil', '1stEditionNormal', 'reverseHolofoil'];

export function mapCard(c) {
  const set = c.set ?? {};
  const card = {
    id: `pkm:${c.id}`,
    game: 'pokemon',
    name: c.name,
    setName: set.name,
    setCode: set.id,
    number: c.number,
    printedTotal: set.printedTotal != null ? String(set.printedTotal) : null,
    rarity: c.rarity ?? null,
    releaseDate: set.releaseDate ? set.releaseDate.replaceAll('/', '-') : null,
    image: c.images?.small ?? null,
    imageLarge: c.images?.large ?? null,
    ext: {
      series: set.series,
      ptcgo: set.ptcgoCode,
      tcgplayer: c.tcgplayer?.url,
      cardmarket: c.cardmarket?.url,
    },
  };

  const quotes = [];
  const tp = c.tcgplayer?.prices ?? {};
  const tpUpdated = c.tcgplayer?.updatedAt ? Date.parse(c.tcgplayer.updatedAt.replaceAll('/', '-')) : undefined;
  for (const [variant, p] of Object.entries(tp)) {
    if (!p || (p.market == null && p.mid == null)) continue;
    quotes.push({
      cardId: card.id, variant, source: 'tcgplayer', currency: 'USD', updatedAt: Date.now(),
      data: { market: p.market ?? null, low: p.low ?? null, mid: p.mid ?? null, high: p.high ?? null, directLow: p.directLow ?? null, asOf: tpUpdated ?? null },
    });
  }

  const cm = c.cardmarket?.prices;
  if (cm) {
    const variants = Object.keys(tp);
    const primary = PRIMARY_ORDER.find((v) => v !== 'reverseHolofoil' && variants.includes(v)) ?? 'normal';
    if (cm.trendPrice || cm.averageSellPrice) {
      quotes.push({
        cardId: card.id, variant: primary, source: 'cardmarket', currency: 'EUR', updatedAt: Date.now(),
        data: { trend: cm.trendPrice ?? null, avgSell: cm.averageSellPrice ?? null, low: cm.lowPrice ?? null, lowExPlus: cm.lowPriceExPlus ?? null, avg1: cm.avg1 ?? null, avg7: cm.avg7 ?? null, avg30: cm.avg30 ?? null },
      });
    }
    if (variants.includes('reverseHolofoil') && (cm.reverseHoloTrend || cm.reverseHoloSell)) {
      quotes.push({
        cardId: card.id, variant: 'reverseHolofoil', source: 'cardmarket', currency: 'EUR', updatedAt: Date.now(),
        data: { trend: cm.reverseHoloTrend ?? null, avgSell: cm.reverseHoloSell ?? null, low: cm.reverseHoloLow ?? null, avg1: cm.reverseHoloAvg1 ?? null, avg7: cm.reverseHoloAvg7 ?? null, avg30: cm.reverseHoloAvg30 ?? null },
      });
    }
  }
  return { card, quotes };
}

export async function refreshPokemon(db, settings, onProgress = () => {}) {
  const key = settings.pokemontcgApiKey;
  const headers = key ? { 'X-Api-Key': key } : {};
  // Without a key the API allows ~30 req/min.
  const minInterval = key ? 150 : 2100;
  const started = Date.now();
  let page = 1;
  let total = Infinity;
  let seen = 0;
  while (seen < total) {
    const url = `${BASE}/cards?page=${page}&pageSize=250&orderBy=set.releaseDate&select=${SELECT}`;
    const res = await getJSON(url, { headers, minInterval, timeout: 60_000, retries: 5 });
    total = res.totalCount ?? 0;
    const data = res.data ?? [];
    if (!data.length) break;
    const cards = [];
    const quotes = [];
    for (const c of data) {
      const m = mapCard(c);
      cards.push(m.card);
      quotes.push(...m.quotes);
    }
    upsertCards(db, cards);
    upsertQuotes(db, quotes);
    seen += data.length;
    onProgress(seen, total);
    page++;
  }
  const pruned = pruneQuotes(db, 'tcgplayer', started, 'pkm:') + pruneQuotes(db, 'cardmarket', started, 'pkm:');
  log.info(`pokemon: ${seen} cards (${pruned} stale quotes pruned)`);
  return seen;
}

/** Live lookup used by /api/identify when the local catalog has no match. */
export async function searchPokemon(settings, q) {
  const key = settings.pokemontcgApiKey;
  const url = `${BASE}/cards?q=${encodeURIComponent(q)}&pageSize=12&orderBy=-set.releaseDate&select=${SELECT}`;
  const res = await getJSON(url, { headers: key ? { 'X-Api-Key': key } : {}, timeout: 15_000, retries: 1 });
  return (res.data ?? []).map(mapCard);
}
