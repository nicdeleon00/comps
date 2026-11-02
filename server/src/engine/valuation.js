// Consolidates every source's quote for a card variant into one fair market
// value (USD), a confidence score, graded values, and short-term change.

import { median, clamp, day, daysAgo, safeJSON, groupBy } from '../lib/util.js';

// How much we trust each source as an estimate of US raw near-mint value.
const WEIGHTS = { tcgplayer: 1, pricecharting: 0.9, cardmarket: 0.4 };

/** Pure: quotes (for one card variant) + fx -> valuation fields. */
export function valuate(quotes, fx, linkedPc) {
  const by = Object.fromEntries(quotes.map((q) => [q.source, q]));
  const cand = [];
  const tp = by.tcgplayer?.data;
  if (tp) {
    const v = tp.market ?? tp.mid;
    if (v > 0) cand.push({ src: 'tcgplayer', v, w: tp.market ? WEIGHTS.tcgplayer : 0.5 });
  }
  const cm = by.cardmarket?.data;
  const cmv = cm ? cm.trend ?? cm.avgSell : null;
  if (cmv > 0) cand.push({ src: 'cardmarket', v: cmv * fx, w: WEIGHTS.cardmarket });
  const pc = (linkedPc ?? by.pricecharting)?.data;
  if (pc?.ungraded > 0) cand.push({ src: 'pricecharting', v: pc.ungraded, w: WEIGHTS.pricecharting });

  let raw = null;
  let confidence = 0;
  if (cand.length) {
    // Anchor on the US market (TCGplayer, else PriceCharting); other sources only
    // count when they broadly agree, so a mismatched EU printing can't drag it.
    const anchor = cand.find((c) => c.src === 'tcgplayer') ?? cand.find((c) => c.src === 'pricecharting') ?? null;
    const m = anchor ? anchor.v : median(cand.map((c) => c.v));
    const kept = cand.filter((c) => c === anchor || (c.v <= m * 1.5 && c.v >= m * 0.65));
    const W = kept.reduce((s, c) => s + c.w, 0);
    raw = kept.reduce((s, c) => s + c.v * c.w, 0) / W;
    // Confidence: number/quality of agreeing sources and how tightly they agree.
    const spread = kept.length > 1 ? (Math.max(...kept.map((c) => c.v)) - Math.min(...kept.map((c) => c.v))) / raw : 0.3;
    const breadth = clamp(W / 1.8);
    confidence = clamp(0.3 + 0.45 * breadth + 0.25 * (1 - clamp(spread)));
    if (pc?.volume != null) confidence = clamp(confidence * (pc.volume >= 12 ? 1 : 0.75 + pc.volume / 48));
  }

  const out = {
    raw: r2(raw),
    raw_low: r2(tp?.low ?? (cm?.low ? cm.low * fx : null)),
    confidence: Math.round(confidence * 100) / 100,
    sources: cand.length,
    g7: pc?.g7 ?? null,
    g8: pc?.g8 ?? null,
    g9: pc?.g9 ?? null,
    g95: pc?.g95 ?? null,
    psa10: pc?.psa10 ?? null,
    bgs10: pc?.bgs10 ?? null,
    cgc10: pc?.cgc10 ?? null,
    sgc10: pc?.sgc10 ?? null,
    volume: pc?.volume ?? null,
    // Cardmarket's rolling averages give a trend even before we have history.
    cm_change_7d: cm?.avg7 && cm?.avg30 ? cm.avg7 / cm.avg30 - 1 : null,
  };
  return out;
}

const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

/** Rebuilds the valuations table and appends today's history point. */
export function rebuildValuations(db, fx, { historyMinUsd = 0 } = {}) {
  const quotes = db.all('SELECT card_id, variant, source, currency, data FROM quotes').map((q) => ({ ...q, data: safeJSON(q.data, {}) }));
  const pcQuotes = new Map(quotes.filter((q) => q.source === 'pricecharting').map((q) => [q.card_id, q]));
  const links = new Map(db.all('SELECT * FROM links').map((l) => [`${l.card_id}|${l.variant}`, l.pc_id]));
  const groups = groupBy(quotes, (q) => `${q.card_id}|${q.variant}`);

  // Ensure linked variants exist even if only PriceCharting knows them.
  for (const [key, pcId] of links) if (!groups.has(key) && pcQuotes.has(pcId)) groups.set(key, []);

  const today = day();
  const d7 = daysAgo(7);
  const d30 = daysAgo(30);
  const past = (d) => new Map(db.all(
    `SELECT h.card_id || '|' || h.variant AS k, h.raw FROM history h
     JOIN (SELECT card_id, variant, MAX(day) d FROM history WHERE day <= ? GROUP BY card_id, variant) x
       ON x.card_id = h.card_id AND x.variant = h.variant AND x.d = h.day`, d).map((r) => [r.k, r.raw]));
  const at7 = past(d7);
  const at30 = past(d30);

  const t = Date.now();
  let n = 0;
  db.tx(() => {
    db.run('DELETE FROM valuations');
    const ins = `INSERT INTO valuations (card_id, variant, raw, raw_low, confidence, sources, g7, g8, g9, g95, psa10, bgs10, cgc10, sgc10, volume, change_7d, change_30d, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
    const hist = `INSERT INTO history (card_id, variant, day, raw, g9, psa10) VALUES (?,?,?,?,?,?)
      ON CONFLICT(card_id, variant, day) DO UPDATE SET raw = excluded.raw, g9 = excluded.g9, psa10 = excluded.psa10`;
    for (const [key, qs] of groups) {
      const [cardId, variant] = splitKey(key);
      const pcId = links.get(key);
      const v = valuate(qs, fx, pcId ? pcQuotes.get(pcId) : null);
      if (v.raw == null && v.psa10 == null) continue;
      const c7 = at7.get(key);
      const c30 = at30.get(key);
      const change7 = c7 > 0 && v.raw ? v.raw / c7 - 1 : null;
      const change30 = c30 > 0 && v.raw ? v.raw / c30 - 1 : null;
      db.run(ins, cardId, variant, v.raw, v.raw_low, v.confidence, v.sources, v.g7, v.g8, v.g9, v.g95, v.psa10, v.bgs10, v.cgc10, v.sgc10, v.volume,
        r4(change7), r4(change30), t);
      if ((v.raw ?? 0) >= historyMinUsd || v.psa10) db.run(hist, cardId, variant, today, v.raw, v.g9, v.psa10);
      n++;
    }
  });
  return n;
}

/** Values a handful of cards right away (e.g. found by a live scan lookup). No history write. */
export function revalue(db, fx, ids) {
  if (!ids.length) return 0;
  const ph = ids.map(() => '?').join(',');
  const quotes = db.all(`SELECT card_id, variant, source, currency, data FROM quotes WHERE card_id IN (${ph})`, ...ids).map((q) => ({ ...q, data: safeJSON(q.data, {}) }));
  const t = Date.now();
  let n = 0;
  db.tx(() => {
    for (const [key, qs] of groupBy(quotes, (q) => `${q.card_id}|${q.variant}`)) {
      const [cardId, variant] = splitKey(key);
      const v = valuate(qs, fx, null);
      if (v.raw == null && v.psa10 == null) continue;
      db.run(`INSERT OR REPLACE INTO valuations (card_id, variant, raw, raw_low, confidence, sources, g7, g8, g9, g95, psa10, bgs10, cgc10, sgc10, volume, change_7d, change_30d, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, cardId, variant, v.raw, v.raw_low, v.confidence, v.sources, v.g7, v.g8, v.g9, v.g95, v.psa10, v.bgs10, v.cgc10, v.sgc10, v.volume,
        v.cm_change_7d != null ? Math.round(v.cm_change_7d * 10000) / 10000 : null, null, t);
      n++;
    }
  });
  return n;
}

const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10000) / 10000);

function splitKey(key) {
  const i = key.lastIndexOf('|');
  return [key.slice(0, i), key.slice(i + 1)];
}

/** Keeps daily points for 120 days, then one per week. */
export function compactHistory(db) {
  const cutoff = daysAgo(120);
  return db.run(`DELETE FROM history WHERE day < ? AND strftime('%w', day) <> '1'`, cutoff).changes;
}

// Holding value: map a holding's grade/condition to the right price.
const CONDITION_FACTOR = { NM: 1, LP: 0.82, MP: 0.62, HP: 0.42, DMG: 0.25 };

export function gradeKey(grader, grade) {
  if (!grader || !grade) return null;
  const g = Number(grade);
  const G = String(grader).toUpperCase();
  if (g >= 10) return G === 'BGS' ? 'bgs10' : G === 'CGC' ? 'cgc10' : G === 'SGC' ? 'sgc10' : 'psa10';
  if (g >= 9.5) return 'g95';
  if (g >= 9) return 'g9';
  if (g >= 8) return 'g8';
  if (g >= 7) return 'g7';
  return 'low';
}

/** Unit value for a holding given its variant's valuation row. */
export function holdingValue(h, v) {
  if (!v) return { value: null, basis: null };
  const k = gradeKey(h.grader, h.grade);
  if (k && k !== 'low') {
    const val = v[k] ?? (k.endsWith('10') ? v.psa10 : null);
    if (val) return { value: val, basis: k };
    // Unknown graded value: fall back to raw so the portfolio isn't zeroed.
    return { value: v.raw, basis: 'raw' };
  }
  if (k === 'low') return { value: v.g7 ? Math.min(v.g7, v.raw ?? v.g7) * 0.8 : v.raw, basis: 'raw' };
  const f = CONDITION_FACTOR[(h.condition ?? 'NM').toUpperCase()] ?? 1;
  return { value: v.raw != null ? Math.round(v.raw * f * 100) / 100 : null, basis: 'raw' };
}
