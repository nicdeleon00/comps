// Raw → graded expected value.
//
// The question this answers: "If I buy this card raw and send it to PSA, what
// do I expect to clear after fees, and how often does it need to come back a
// 10 just to break even?"  The break-even gem rate is the most robust number
// here because it doesn't depend on our gem-rate assumptions at all.

import { clamp, yearOf } from '../lib/util.js';

/**
 * Default grade distributions by print era. These are deliberately rough
 * starting points; real gem rates vary a lot by set and card, which is why
 * they can be overridden per card and why we always show the break-even rate.
 */
export const ERA_RATES = {
  vintage: { p10: 0.06, p9: 0.3, p8: 0.4 }, // ≤ 2002: WotC era, centering & edge wear
  mid: { p10: 0.2, p9: 0.45, p8: 0.25 }, //    2003–2016
  modern: { p10: 0.45, p9: 0.42, p8: 0.1 }, //  2017+: better print quality
};

export function eraOf(releaseDate) {
  const y = yearOf(releaseDate);
  if (!y) return 'modern';
  if (y <= 2002) return 'vintage';
  if (y <= 2016) return 'mid';
  return 'modern';
}

const netSale = (v, c) => (v == null ? null : v * (1 - c.sellFeePct) - c.sellFixed);

/**
 * @param {object} v   valuation: raw, g7, g8, g9, psa10 (USD)
 * @param {object} c   costs: fee, shipping, sellFeePct (0..1), sellFixed
 * @param {object} r   rates: p10, p9, p8 (rest falls to "≤7")
 */
export function gradeEV(v, c, r) {
  const raw = v.raw;
  const v10 = v.psa10;
  if (!(raw > 0) || !(v10 > 0)) return null;
  // Missing grades fall back conservatively.
  const v9 = v.g9 ?? null;
  const v8 = v.g8 ?? (v9 != null ? Math.min(v9, raw * 1.15) : raw);
  const vLow = v.g7 != null ? Math.min(v.g7, v8) : Math.min(raw * 0.9, v8);
  const nineValue = v9 ?? v8;

  const p10 = clamp(r.p10);
  const p9 = clamp(r.p9, 0, 1 - p10);
  const p8 = clamp(r.p8, 0, 1 - p10 - p9);
  const pLow = Math.max(0, 1 - p10 - p9 - p8);

  const outcomes = [
    { grade: '10', p: p10, value: v10 },
    { grade: '9', p: p9, value: nineValue },
    { grade: '8', p: p8, value: v8 },
    { grade: '≤7', p: pLow, value: vLow },
  ].map((o) => ({ ...o, net: netSale(o.value, c) }));

  const cost = raw + c.fee + c.shipping;
  const ev = outcomes.reduce((s, o) => s + o.p * o.net, 0);
  const profit = ev - cost;

  // Break-even P(10), holding the *shape* of the non-10 outcomes fixed.
  const rest = 1 - p10;
  const nonTenNet = rest > 0 ? outcomes.slice(1).reduce((s, o) => s + (o.p / rest) * o.net, 0) : outcomes[1].net;
  const ten = outcomes[0].net;
  let breakEven = null;
  if (ten > cost) breakEven = clamp((cost - nonTenNet) / (ten - nonTenNet), 0, 1);

  // What a guaranteed 9 or 10 would clear — useful for "sure thing" cards.
  const if10 = ten - cost;
  const if9 = netSale(nineValue, c) - cost;

  return {
    raw,
    cost: r2(cost),
    ev: r2(ev),
    profit: r2(profit),
    roi: r2(profit / cost),
    breakEven: breakEven == null ? null : Math.round(breakEven * 1000) / 1000,
    multiple: r2(v10 / raw),
    if10: r2(if10),
    if9: r2(if9),
    rates: { p10, p9, p8, pLow: Math.round(pLow * 1000) / 1000 },
    outcomes: outcomes.map((o) => ({ grade: o.grade, p: Math.round(o.p * 1000) / 1000, value: r2(o.value), net: r2(o.net) })),
  };
}

const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

/** Recomputes the spreads table from current valuations. */
export function computeSpreads(db, costs) {
  const overrides = new Map(db.all('SELECT * FROM gem_rates').map((r) => [r.card_id, r]));
  const rows = db.all(`
    SELECT v.*, c.release_date, c.game FROM valuations v JOIN cards c ON c.id = v.card_id
    WHERE v.psa10 > 0 AND v.raw > 0
      AND v.card_id NOT IN (SELECT pc_id FROM links)`);
  const t = Date.now();
  let n = 0;
  db.tx(() => {
    db.run('DELETE FROM spreads');
    for (const v of rows) {
      const era = eraOf(v.release_date);
      const o = overrides.get(v.card_id);
      const rates = o ? { p10: o.p10, p9: o.p9 ?? ERA_RATES[era].p9, p8: o.p8 ?? ERA_RATES[era].p8 } : ERA_RATES[era];
      const g = gradeEV(v, costs, rates);
      if (!g) continue;
      db.run(`INSERT INTO spreads (card_id, variant, raw, g9, psa10, multiple, cost, ev, profit, roi, break_even, volume, data, computed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        v.card_id, v.variant, v.raw, v.g9, v.psa10, g.multiple, g.cost, g.ev, g.profit, g.roi, g.breakEven, v.volume,
        JSON.stringify({ era, custom: Boolean(o), rates: g.rates, outcomes: g.outcomes, if10: g.if10, if9: g.if9 }), t);
      n++;
    }
  });
  return n;
}

export function ratesFor(db, cardId, releaseDate) {
  const era = eraOf(releaseDate);
  const o = db.get('SELECT * FROM gem_rates WHERE card_id = ?', cardId);
  return { era, custom: Boolean(o), ...(o ? { p10: o.p10, p9: o.p9 ?? ERA_RATES[era].p9, p8: o.p8 ?? ERA_RATES[era].p8 } : ERA_RATES[era]) };
}
