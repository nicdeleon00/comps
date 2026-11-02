// Undervalued-card signals. Each signal says: "here's a price you can buy at
// (or the market is at) and here's why we think the card is worth more."

import { clamp, median, safeJSON, daysAgo, groupBy } from '../lib/util.js';
import { gradeEV, eraOf, ERA_RATES } from './grading.js';
import { gradeKey } from './valuation.js';

export const KINDS = {
  listing: { label: 'Live listing', weight: 1 },
  dip: { label: 'Price dip', weight: 0.85 },
  momentum: { label: 'Momentum lag', weight: 0.8 },
  ask: { label: 'Low ask', weight: 0.72 },
  xmarket: { label: 'Cross-market', weight: 0.7 },
};

/** 0–100. Rewards deep discounts, real dollar upside and confidence. */
export function scoreSignal({ discount, upside, confidence, kind }) {
  const d = clamp((discount - 0.1) / 0.5);
  const u = clamp(Math.log10(Math.max(upside, 1)) / Math.log10(500));
  const s = clamp(0.5 * d + 0.25 * u + 0.25 * clamp(confidence));
  return Math.round(100 * s * (KINDS[kind]?.weight ?? 0.7));
}

const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

export function computeSignals(db, { fx, costs }) {
  const vals = db.all(`SELECT v.*, c.game, c.release_date, c.name FROM valuations v JOIN cards c ON c.id = v.card_id
    WHERE v.card_id NOT IN (SELECT pc_id FROM links)`);
  const valByKey = new Map(vals.map((v) => [`${v.card_id}|${v.variant}`, v]));
  const quotes = groupBy(
    db.all(`SELECT card_id, variant, source, data FROM quotes WHERE source IN ('tcgplayer','scryfall','cardmarket')`),
    (q) => `${q.card_id}|${q.variant}`,
  );
  const out = [];
  const push = (kind, v, price, value, confidence, data) => {
    const upside = value - price;
    const discount = 1 - price / value;
    if (!(price > 0) || !(upside > 0)) return;
    const score = scoreSignal({ discount, upside, confidence, kind });
    out.push({ kind, card_id: v.card_id, variant: v.variant, score, price: r2(price), value: r2(value), upside: r2(upside), confidence: r2(confidence), data });
  };

  for (const v of vals) {
    if (!(v.raw > 0)) continue;
    const qs = Object.fromEntries((quotes.get(`${v.card_id}|${v.variant}`) ?? []).map((q) => [q.source, safeJSON(q.data, {})]));
    const us = qs.tcgplayer?.market ?? qs.scryfall?.market ?? null;
    const cm = qs.cardmarket;
    const eu = cm?.trend ? cm.trend * fx : null;

    // 1. Lowest ask far under market. TCGplayer "low" can be a played copy, so
    //    confidence is capped.
    const low = qs.tcgplayer?.low;
    if (low > 0 && v.raw >= 8 && low / v.raw <= 0.72) {
      push('ask', v, low, v.raw, Math.min(0.6, v.confidence), { source: 'tcgplayer', market: us });
    }

    // 2. Cross-market: EU trend well under US market (buy on Cardmarket).
    if (us >= 15 && eu > 0 && eu <= us * 0.65) {
      push('xmarket', v, eu, us, Math.min(0.7, v.confidence), { direction: 'eu', eur: cm.trend, fx, note: 'before shipping and import' });
    }

    // 3. Momentum lag: EU rolling averages climbing, US price hasn't followed.
    if (cm?.avg7 && cm?.avg30 && cm.avg1 && us >= 5 && eu) {
      const accel = cm.avg7 / cm.avg30;
      if (accel >= 1.2 && cm.avg1 >= cm.avg7 * 0.97 && us <= eu * 0.95) {
        const target = Math.max(eu, us * accel);
        push('momentum', v, us, target, Math.min(0.65, v.confidence * 0.9), { avg1: cm.avg1, avg7: cm.avg7, avg30: cm.avg30, fx, accel: r2(accel) });
      }
    }
  }

  // 4. Dips versus our own 30-day history.
  const since = daysAgo(32);
  const recent = daysAgo(2);
  const hist = groupBy(db.all('SELECT card_id, variant, day, raw FROM history WHERE day >= ? AND raw > 0', since), (h) => `${h.card_id}|${h.variant}`);
  for (const [key, pts] of hist) {
    const v = valByKey.get(key);
    if (!v || !(v.raw >= 10)) continue;
    const base = pts.filter((p) => p.day < recent);
    if (base.length < 10) continue;
    const m = median(base.map((p) => p.raw));
    if (m > 0 && v.raw <= m * 0.78) {
      push('dip', v, v.raw, m, v.confidence * clamp(base.length / 25, 0.5, 1), { median30: r2(m), points: base.length });
    }
  }

  // 5. Live eBay listings under fair value.
  const listings = db.all('SELECT * FROM listings WHERE fetched_at > ?', Date.now() - 36 * 3600_000);
  const spreadOk = new Set(db.all('SELECT card_id || \'|\' || variant AS k FROM spreads WHERE profit > 0').map((r) => r.k));
  for (const l of listings) {
    const key = `${l.card_id}|${l.variant}`;
    const v = valByKey.get(key);
    if (!v) continue;
    const gk = gradeKey(l.grader, l.grade);
    const value = gk ? v[gk] : v.raw;
    if (!(value > 0)) continue;
    const total = l.price + (l.shipping ?? 0);
    if (total > value * 0.85 || value - total < 5) continue;
    const data = { itemId: l.item_id, title: l.title, url: l.url, image: l.image, seller: l.seller, feedback: l.feedback, shipping: l.shipping, grader: l.grader, grade: l.grade, gradeKey: gk ?? 'raw' };
    // A cheap raw copy of a card with a strong graded premium is a double win.
    if (!gk && spreadOk.has(key) && v.psa10) {
      const g = gradeEV({ ...v, raw: total }, costs, ERA_RATES[eraOf(v.release_date)]);
      if (g && g.profit > 0) data.grading = { ev: g.ev, profit: g.profit, roi: g.roi, breakEven: g.breakEven };
    }
    push('listing', v, total, value, v.confidence * (l.feedback >= 99.5 ? 1 : 0.9), data);
  }

  const t = Date.now();
  db.tx(() => {
    db.run('DELETE FROM signals');
    for (const s of out) {
      db.run(`INSERT INTO signals (kind, card_id, variant, score, price, value, upside, confidence, data, computed_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        s.kind, s.card_id, s.variant, s.score, s.price, s.value, s.upside, s.confidence, JSON.stringify(s.data ?? {}), t);
    }
  });
  return out.length;
}
