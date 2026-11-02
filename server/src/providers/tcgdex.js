// TCGdex (api.tcgdex.net): open Pokémon card database with daily Cardmarket
// (European) prices per printing. We use it for the cards that matter — the
// ones worth enough to trade — to power cross-market and momentum signals.
// Each TCGdex printing lists its TCGplayer product id, so matches are exact.

import { getJSON } from '../lib/http.js';
import { upsertQuotes } from '../store.js';
import { similarity, norm, log } from '../lib/util.js';

const BASE = process.env.TCGDEX_BASE ?? 'https://api.tcgdex.net/v2/en';
const numKey = (n) => String(n ?? '').toUpperCase().replace(/^([A-Z]*)0+(?=\d)/, '$1');

/** Pairs our sets (TCGplayer groups) with TCGdex sets by name and card count. */
export function matchSets(ours, theirs) {
  const out = new Map();
  for (const s of ours) {
    const name = norm(s.name);
    let best = null;
    let bestScore = 0;
    for (const t of theirs) {
      const tn = norm(t.name);
      let score = similarity(name, tn);
      // "151" vs "Scarlet & Violet 151": their name contained in ours.
      if (tn && name.endsWith(tn) && tn.length >= 3) score = Math.max(score, 0.82);
      if (s.total && t.official && Number(s.total) === Number(t.official)) score += 0.15;
      if (score > bestScore) { bestScore = score; best = t; }
    }
    if (best && bestScore >= 0.8) out.set(s.id, best.id);
  }
  return out;
}

/** Cardmarket prices for our variants from one TCGdex card. */
export function quotesFromCard(card, productId, variants) {
  const entry = (card.variants_detailed ?? []).find((v) => Number(v.thirdParty?.tcgplayer) === Number(productId) && v.pricing?.cardmarket);
  const cm = entry?.pricing?.cardmarket;
  if (!cm) return [];
  const out = [];
  const primary = ['holofoil', 'normal', '1stEditionHolofoil', 'unlimitedHolofoil', '1stEditionNormal'].find((v) => variants.includes(v)) ?? variants.find((v) => v !== 'reverseHolofoil');
  const pos = (x) => (Number(x) > 0 ? Number(x) : null);
  if (primary && pos(cm.trend)) {
    out.push({ variant: primary, data: { trend: pos(cm.trend), avgSell: pos(cm.avg), low: pos(cm.low), avg1: pos(cm.avg1), avg7: pos(cm.avg7), avg30: pos(cm.avg30) } });
  }
  if (variants.includes('reverseHolofoil') && pos(cm['trend-holo'])) {
    out.push({ variant: 'reverseHolofoil', data: { trend: pos(cm['trend-holo']), avgSell: pos(cm['avg-holo']), low: pos(cm['low-holo']), avg1: pos(cm['avg1-holo']), avg7: pos(cm['avg7-holo']), avg30: pos(cm['avg30-holo']) } });
  }
  return out;
}

export async function refreshTcgdex(db, settings, onProgress = () => {}) {
  const minUsd = Number(settings.euMinUsd) || 15;
  const maxCards = Number(settings.euMaxCards) || 900;

  // 1. Set mapping (cheap; refreshed every run).
  const theirs = (await getJSON(`${BASE}/sets`, { timeout: 30_000, retries: 2 })).map((t) => ({ id: t.id, name: t.name, official: t.cardCount?.official }));
  const ours = db.all(`SELECT s.id, s.name, (SELECT printed_total FROM cards c WHERE c.group_id = s.id AND printed_total GLOB '[0-9]*'
      GROUP BY printed_total ORDER BY COUNT(*) DESC LIMIT 1) AS total FROM sets s`);
  const setMap = matchSets(ours, theirs);
  db.tx(() => { for (const [sid, tid] of setMap) db.run('UPDATE sets SET tcgdex_id = ? WHERE id = ?', tid, sid); });

  // 2. Which cards: the most valuable variants with a TCGplayer market price.
  const targets = db.all(`SELECT c.id, c.group_id, c.number, c.base_name, json_extract(c.ext, '$.productId') AS pid,
      (SELECT group_concat(variant) FROM quotes q WHERE q.card_id = c.id AND q.source = 'tcgplayer') AS variants,
      MAX(v.raw) AS raw
    FROM cards c JOIN valuations v ON v.card_id = c.id
    WHERE c.id LIKE 'tcg:%' AND v.raw >= ?
    GROUP BY c.id ORDER BY raw DESC LIMIT ?`, minUsd, maxCards);

  // 3. Resolve TCGdex card ids per set (one set listing each), cached in tcgdex_map.
  const mapped = new Map(db.all('SELECT card_id, tcgdex_id FROM tcgdex_map').map((r) => [r.card_id, r.tcgdex_id]));
  const needSets = new Set(targets.filter((t) => !mapped.has(t.id) && setMap.has(String(t.group_id))).map((t) => String(t.group_id)));
  for (const sid of needSets) {
    try {
      const set = await getJSON(`${BASE}/sets/${encodeURIComponent(setMap.get(sid))}`, { minInterval: 150, timeout: 30_000, retries: 2 });
      const byNum = new Map();
      for (const c of set.cards ?? []) {
        const k = numKey(c.localId);
        if (!byNum.has(k)) byNum.set(k, []);
        byNum.get(k).push(c);
      }
      db.tx(() => {
        for (const t of targets.filter((x) => String(x.group_id) === sid && !mapped.has(x.id))) {
          const cands = byNum.get(numKey(t.number)) ?? [];
          const hit = cands.find((c) => similarity(c.name, t.base_name) >= 0.6) ?? (cands.length === 1 ? cands[0] : null);
          db.run('INSERT OR REPLACE INTO tcgdex_map (card_id, tcgdex_id, checked_at) VALUES (?,?,?)', t.id, hit?.id ?? null, Date.now());
          mapped.set(t.id, hit?.id ?? null);
        }
      });
    } catch (err) {
      log.warn(`tcgdex set ${sid}: ${err.message}`);
    }
  }

  // 4. Fetch prices.
  let n = 0;
  let done = 0;
  const quotes = [];
  for (const t of targets) {
    done++;
    const tid = mapped.get(t.id);
    if (!tid) continue;
    try {
      const card = await getJSON(`${BASE}/cards/${encodeURIComponent(tid)}`, { minInterval: 150, timeout: 20_000, retries: 1 });
      for (const q of quotesFromCard(card, t.pid, String(t.variants ?? '').split(',').filter(Boolean))) {
        quotes.push({ cardId: t.id, variant: q.variant, source: 'cardmarket', currency: 'EUR', data: q.data });
        n++;
      }
    } catch (err) {
      if (err.status === 404) db.run('UPDATE tcgdex_map SET tcgdex_id = NULL WHERE card_id = ?', t.id);
    }
    if (quotes.length >= 200) { upsertQuotes(db, quotes.splice(0)); }
    if (done % 25 === 0) onProgress(done, targets.length);
  }
  upsertQuotes(db, quotes);
  // EU prices for cards that dropped out of the target list go stale; drop them after 3 days.
  db.run(`DELETE FROM quotes WHERE source = 'cardmarket' AND updated_at < ?`, Date.now() - 3 * 86_400_000);
  log.info(`tcgdex: ${setMap.size} sets matched, ${n} Cardmarket prices for ${targets.length} cards`);
  return n;
}
