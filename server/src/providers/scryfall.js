// Scryfall (Magic: The Gathering). Free, no key. Prices are daily TCGplayer
// market (USD) and Cardmarket (EUR). We only pull printings above a price floor.

import { getJSON } from '../lib/http.js';
import { upsertCards, upsertQuotes, pruneQuotes } from '../store.js';
import { log } from '../lib/util.js';

const BASE = 'https://api.scryfall.com';
const HEADERS = { Accept: 'application/json;q=0.9,*/*;q=0.8' };

export function mapCard(c) {
  const face = c.card_faces?.[0] ?? {};
  const imgs = c.image_uris ?? face.image_uris ?? {};
  const card = {
    id: `mtg:${c.id}`,
    game: 'mtg',
    name: c.name,
    setName: c.set_name,
    setCode: c.set,
    number: c.collector_number,
    printedTotal: c.printed_size != null ? String(c.printed_size) : null,
    rarity: c.rarity ? c.rarity[0].toUpperCase() + c.rarity.slice(1) : null,
    releaseDate: c.released_at ?? null,
    image: imgs.normal ?? imgs.small ?? null,
    imageLarge: imgs.large ?? imgs.normal ?? null,
    ext: {
      scryfall: c.scryfall_uri,
      tcgplayer: c.purchase_uris?.tcgplayer,
      cardmarket: c.purchase_uris?.cardmarket,
      tcgplayerId: c.tcgplayer_id ?? null,
      lang: c.lang,
    },
  };
  const p = c.prices ?? {};
  const quotes = [];
  const add = (variant, usd, eur) => {
    if (usd) quotes.push({ cardId: card.id, variant, source: 'scryfall', currency: 'USD', data: { market: Number(usd) } });
    if (eur) quotes.push({ cardId: card.id, variant, source: 'cardmarket', currency: 'EUR', data: { trend: Number(eur) } });
  };
  add('nonfoil', p.usd, p.eur);
  add('foil', p.usd_foil, p.eur_foil);
  add('etched', p.usd_etched, null);
  return { card, quotes };
}

export async function refreshScryfall(db, settings, onProgress = () => {}) {
  const min = Number(settings.mtgMinUsd) || 2;
  const started = Date.now();
  // Scryfall can filter on the non-foil USD price only; foils ride along with their printing.
  const q = `usd>=${min} game:paper`;
  let url = `${BASE}/cards/search?q=${encodeURIComponent(q)}&unique=prints&order=usd&dir=desc`;
  let seen = 0;
  let total = 0;
  while (url) {
    // Scryfall asks for 50–100ms between requests.
    const res = await getJSON(url, { headers: HEADERS, minInterval: 120, timeout: 60_000, retries: 4 });
    total = res.total_cards ?? total;
    const cards = [];
    const quotes = [];
    for (const c of res.data ?? []) {
      const m = mapCard(c);
      cards.push(m.card);
      quotes.push(...m.quotes);
    }
    upsertCards(db, cards);
    upsertQuotes(db, quotes);
    seen += cards.length;
    onProgress(seen, total);
    url = res.has_more ? res.next_page : null;
  }
  pruneQuotes(db, 'scryfall', started, 'mtg:');
  pruneQuotes(db, 'cardmarket', started, 'mtg:');
  log.info(`mtg: ${seen} printings`);
  return seen;
}

/** Exact printing by set code + collector number (scanner). */
export async function scryfallBySetNumber(set, number) {
  const c = await getJSON(`${BASE}/cards/${encodeURIComponent(set.toLowerCase())}/${encodeURIComponent(number)}`, { headers: HEADERS, retries: 0, timeout: 10_000 });
  return mapCard(c);
}

export async function scryfallFuzzy(name) {
  const res = await getJSON(`${BASE}/cards/search?q=${encodeURIComponent(`!"${name}" game:paper`)}&unique=prints&order=released`, { headers: HEADERS, retries: 0, timeout: 10_000 })
    .catch(() => getJSON(`${BASE}/cards/named?fuzzy=${encodeURIComponent(name)}`, { headers: HEADERS, retries: 0, timeout: 10_000 }).then((c) => ({ data: [c] })));
  return (res.data ?? []).slice(0, 12).map(mapCard);
}
