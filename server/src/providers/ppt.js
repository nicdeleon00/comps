// Graded prices (PSA, CGC, BGS, SGC) from PokemonPriceTracker's free plan.
//
// The free plan gives 100 credits a day and a lookup with graded sales costs 2,
// so each day we learn about 50 cards — and remember them. Every answer (even
// "no graded sales") is stored in the database that the scheduled refresh keeps,
// and a card is only asked about again after weeks. The most valuable cards that
// have never been looked up go first, so coverage grows every day without
// repeating work.

import { upsertQuotes } from '../store.js';
import { safeJSON, log } from '../lib/util.js';

const BASE = process.env.PPT_BASE ?? 'https://www.pokemonpricetracker.com/api/v2';
const COST = 2; // 1 credit for the card + 1 for graded sales
const DAY_MS = 86_400_000;
const PRINTING_RANK = { normal: 0, holofoil: 1, unlimitedHolofoil: 2, reverseHolofoil: 3, '1stEditionNormal': 4, '1stEditionHolofoil': 5 };

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};

/** How long an answer stays good: pricier cards move faster, so check them more often. */
export const ttlDays = (raw, found) => (!found ? 60 : raw >= 100 ? 21 : 45);

// "PSA 10", "psa_10", "psa10" → psa10; "BGS 9.5" → bgs95
const gradeKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
const FIELD = { psa10: 'psa10', psa9: 'g9', psa8: 'g8', psa7: 'g7', bgs95: 'g95', bgs10: 'bgs10', cgc10: 'cgc10', sgc10: 'sgc10', cgc95: 'g95' };

/** Pulls graded prices out of one card from the API, tolerating shape differences. */
export function gradedFrom(card) {
  const ebay = card?.ebay ?? card?.graded ?? card?.gradedPrices ?? null;
  if (!ebay || typeof ebay !== 'object') return null;
  const table = ebay.salesByGrade ?? ebay.grades ?? ebay.byGrade ?? ebay;
  const out = {};
  let volume = null;
  for (const [k, g] of Object.entries(table)) {
    const field = FIELD[gradeKey(k)];
    if (!field || !g || typeof g !== 'object') continue;
    const smart = g.smartMarketPrice;
    const price = num(smart?.price ?? smart?.value ?? smart) ?? num(g.marketPrice7Day) ?? num(g.medianPrice) ?? num(g.averagePrice) ?? num(g.avg) ?? num(g.price);
    if (price == null) continue;
    out[field] ??= price;
    if (field === 'psa10') volume = Number(g.count ?? g.salesCount ?? g.dailyVolume7Day) || null;
  }
  if (!Object.keys(out).length) return null;
  const weekly = Number(ebay.salesVelocityWeekly ?? ebay.salesVelocity?.weekly);
  return { ...out, volume: Number.isFinite(weekly) && weekly > 0 ? Math.round(weekly * 4) : volume };
}

// Where grading pays off most often; these go first.
const SWEET_SPOT = [10, 500];

/** Cards to look up today: never looked up first (grading sweet spot first, most valuable first), then the stalest. */
export function pickCards(db, { limit, minUsd, maxUsd, now }) {
  // One lookup per card, valued at its regular printing (what you'd send to grade) —
  // chosen among all printings, so an expensive holo isn't swapped for its reverse holo.
  const byCard = new Map();
  for (const r of db.all(`SELECT card_id, variant, raw FROM valuations WHERE card_id LIKE 'tcg:%' AND raw > 0`)) {
    const cur = byCard.get(r.card_id);
    const rank = PRINTING_RANK[r.variant] ?? 9;
    if (!cur || rank < cur.rank) byCard.set(r.card_id, { ...r, rank });
  }
  const known = new Map(db.all(`SELECT card_id, data, updated_at FROM quotes WHERE source = 'ppt'`).map((q) => [q.card_id, { at: q.updated_at, found: safeJSON(q.data, {}).found !== false }]));
  const fresh = [];
  const stale = [];
  for (const c of byCard.values()) {
    if (c.raw < minUsd || c.raw > maxUsd) continue;
    const k = known.get(c.card_id);
    if (!k) fresh.push(c);
    else if (now - k.at > ttlDays(c.raw, k.found) * DAY_MS) stale.push({ ...c, at: k.at });
  }
  const sweet = (c) => (c.raw >= SWEET_SPOT[0] && c.raw <= SWEET_SPOT[1] ? 0 : 1);
  fresh.sort((a, b) => sweet(a) - sweet(b) || b.raw - a.raw);
  stale.sort((a, b) => a.at - b.at);
  return [...fresh, ...stale].slice(0, limit);
}

function usage(db, today) {
  const u = safeJSON(db.get(`SELECT value FROM settings WHERE key = '_pptUsage'`)?.value, {});
  return u.day === today ? u.credits ?? 0 : 0;
}
function saveUsage(db, today, credits) {
  db.run(`INSERT INTO settings(key, value) VALUES('_pptUsage', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, JSON.stringify({ day: today, credits }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One refresh run: spends what's left of today's credits on the next cards. Returns cards learned. */
export async function refreshGraded(db, settings, progress = () => {}, { fetchImpl = fetch, now = Date.now(), pause = 1100 } = {}) {
  const key = settings.pptApiKey;
  if (!key) return 0;
  const today = new Date(now).toISOString().slice(0, 10);
  let used = usage(db, today);
  const budget = Number(settings.pptDailyCredits) || 96;
  const cards = pickCards(db, { limit: Math.max(0, Math.floor((budget - used) / COST)), minUsd: Number(settings.pptMinUsd) || 2, maxUsd: Number(settings.pptMaxUsd) || 5000, now });
  if (!cards.length) {
    log.info(`graded: nothing to look up (${used}/${budget} credits used today)`);
    return 0;
  }
  let learned = 0;
  let sampled = false;
  for (const [i, c] of cards.entries()) {
    const pid = c.card_id.slice(4);
    let res;
    try {
      res = await fetchImpl(`${BASE}/cards?tcgPlayerId=${pid}&includeEbay=true&days=30`, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      log.warn(`graded: ${e.message}`);
      break;
    }
    if (res.status === 401 || res.status === 403) throw new Error('PokemonPriceTracker rejected the API key (PPT_API_KEY)');
    if (res.status === 429) { log.info('graded: out of credits for today'); used = budget; break; }
    const cost = Number(res.headers.get('x-ratelimit-cost') ?? res.headers.get('x-api-calls-consumed') ?? COST) || COST;
    used += cost;
    if (!res.ok) { log.warn(`graded: ${pid} answered ${res.status}`); continue; }
    const body = await res.json().catch(() => null);
    const card = Array.isArray(body?.data) ? body.data[0] : body?.data ?? null;
    if (!sampled && card) {
      // Shape check in the run log (no prices), so format changes are easy to spot.
      log.info(`graded: sample fields — card: ${Object.keys(card).slice(0, 25).join(', ')}; ebay: ${Object.keys(card.ebay ?? {}).join(', ')}`);
      sampled = true;
    }
    const graded = gradedFrom(card);
    upsertQuotes(db, [{ cardId: c.card_id, variant: c.variant, source: 'ppt', currency: 'USD', data: { ...(graded ?? {}), found: Boolean(graded), fetchedAt: now }, updatedAt: now }]);
    if (graded) learned++;
    progress(i + 1, cards.length);
    const remaining = res.headers.get('x-ratelimit-daily-remaining');
    if (remaining != null && Number(remaining) < COST) { used = budget; break; }
    if (pause) await sleep(pause); // free plan: 60 calls a minute
  }
  saveUsage(db, today, used);
  const total = db.get(`SELECT COUNT(*) n FROM quotes WHERE source = 'ppt' AND data NOT LIKE '%"found":false%'`).n;
  log.info(`graded: looked up ${cards.length} cards, ${learned} with graded sales · ${total} cards known in all · ${used}/${budget} credits today`);
  return learned;
}
