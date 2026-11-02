// YGOPRODeck (Yu-Gi-Oh!). Free, no key, one request returns the whole card
// database. Each printing (set code + rarity) becomes its own catalog card.

import { getJSON } from '../lib/http.js';
import { upsertCards, upsertQuotes, pruneQuotes } from '../store.js';
import { log, money } from '../lib/util.js';

const BASE = 'https://db.ygoprodeck.com/api/v7';

export function rarityCode(s) {
  const code = String(s.set_rarity_code ?? '').replace(/[()]/g, '').trim();
  if (code) return code;
  return String(s.set_rarity ?? 'X').split(/\s+/).map((w) => w[0]).join('').toUpperCase();
}

export function mapCard(c, minUsd = 0) {
  const out = [];
  const imgId = c.card_images?.[0]?.id ?? c.id;
  const cardPrices = c.card_prices?.[0] ?? {};
  for (const s of c.card_sets ?? []) {
    const price = money(s.set_price);
    if (minUsd && !(price >= minUsd)) continue;
    const card = {
      id: `ygo:${s.set_code}:${rarityCode(s)}`,
      game: 'yugioh',
      name: c.name,
      setName: s.set_name,
      setCode: s.set_code,
      number: s.set_code,
      printedTotal: null,
      rarity: s.set_rarity,
      releaseDate: null,
      image: `https://images.ygoprodeck.com/images/cards_small/${imgId}.jpg`,
      imageLarge: `https://images.ygoprodeck.com/images/cards/${imgId}.jpg`,
      ext: { konamiId: c.id, ygoprodeck: c.ygoprodeck_url, type: c.type },
    };
    const quotes = [];
    if (price) quotes.push({ cardId: card.id, variant: 'default', source: 'ygoprodeck', currency: 'USD', data: { market: price } });
    // Card-level marketplace prices (cheapest printing) — reference only.
    const ref = { tcgplayer: money(cardPrices.tcgplayer_price), cardmarket: money(cardPrices.cardmarket_price), ebay: money(cardPrices.ebay_price) };
    if (ref.tcgplayer || ref.ebay) quotes.push({ cardId: card.id, variant: 'default', source: 'ygo_ref', currency: 'USD', data: ref });
    out.push({ card, quotes });
  }
  return out;
}

export async function refreshYgo(db, settings, onProgress = () => {}) {
  const started = Date.now();
  const res = await getJSON(`${BASE}/cardinfo.php`, { timeout: 180_000, retries: 3 });
  const all = res.data ?? [];
  const min = Number(settings.ygoMinUsd) || 2;
  let cards = [];
  let quotes = [];
  let n = 0;
  for (const c of all) {
    for (const m of mapCard(c, min)) {
      cards.push(m.card);
      quotes.push(...m.quotes);
    }
    if (cards.length >= 2000) {
      upsertCards(db, cards); upsertQuotes(db, quotes);
      n += cards.length; cards = []; quotes = [];
      onProgress(n, null);
    }
  }
  upsertCards(db, cards); upsertQuotes(db, quotes);
  n += cards.length;
  pruneQuotes(db, 'ygoprodeck', started, 'ygo:');
  pruneQuotes(db, 'ygo_ref', started, 'ygo:');
  log.info(`yugioh: ${n} printings ≥ $${min}`);
  return n;
}

/** Exact printing lookup by set code, e.g. "LOB-EN001" (scanner). */
export async function ygoBySetCode(code) {
  const info = await getJSON(`${BASE}/cardsetsinfo.php?setcode=${encodeURIComponent(code)}`, { retries: 0, timeout: 10_000 });
  if (!info?.id) return [];
  const full = await getJSON(`${BASE}/cardinfo.php?id=${info.id}`, { retries: 0, timeout: 10_000 });
  const c = full.data?.[0];
  return c ? mapCard(c).filter((m) => m.card.setCode === code) : [];
}

export async function ygoByName(name) {
  const full = await getJSON(`${BASE}/cardinfo.php?fname=${encodeURIComponent(name)}&num=6&offset=0`, { retries: 0, timeout: 10_000 });
  return (full.data ?? []).flatMap((c) => mapCard(c)).slice(0, 20);
}
