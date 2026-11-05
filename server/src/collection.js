// Collection (holdings) storage, valuation and sync with the iOS app.
// Sync is last-write-wins per holding using updatedAt; deletes are tombstones.

import { randomUUID } from 'node:crypto';
import { holdingValue, gradeKey } from './engine/valuation.js';
import { day, daysAgo, groupBy } from './lib/util.js';
import { img } from './store.js';


function rowToHolding(r) {
  return {
    id: r.id,
    cardId: r.card_id,
    game: r.game,
    name: r.name,
    setName: r.set_name,
    number: r.number,
    image: r.image,
    variant: r.variant,
    grader: r.grader,
    grade: r.grade,
    condition: r.condition,
    quantity: r.quantity,
    costBasis: r.cost_basis,
    acquiredAt: r.acquired_at,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deleted: Boolean(r.deleted),
  };
}

export function upsertHolding(db, h) {
  const id = h.id || randomUUID();
  const t = Date.now();
  const updatedAt = Number(h.updatedAt) || t;
  db.run(`INSERT INTO holdings (id, card_id, game, name, set_name, number, image, variant, grader, grade, condition, quantity, cost_basis, acquired_at, notes, created_at, updated_at, deleted)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET card_id=excluded.card_id, game=excluded.game, name=excluded.name, set_name=excluded.set_name, number=excluded.number,
      image=excluded.image, variant=excluded.variant, grader=excluded.grader, grade=excluded.grade, condition=excluded.condition, quantity=excluded.quantity,
      cost_basis=excluded.cost_basis, acquired_at=excluded.acquired_at, notes=excluded.notes, updated_at=excluded.updated_at, deleted=excluded.deleted`,
    id, h.cardId, h.game ?? null, h.name ?? null, h.setName ?? null, h.number ?? null, h.image ?? null, h.variant ?? null,
    h.grader || null, h.grade != null && h.grade !== '' ? String(h.grade) : null, h.condition ?? 'NM', Math.max(1, Number(h.quantity) || 1),
    h.costBasis != null && h.costBasis !== '' ? Number(h.costBasis) : null, h.acquiredAt ?? null, h.notes ?? null,
    Number(h.createdAt) || t, updatedAt, h.deleted ? 1 : 0);
  return { id };
}

/** Fills in name/set/image from the catalog when a client only sent cardId. */
export function hydrate(db, h) {
  if (h.name && h.image) return h;
  const c = db.get('SELECT * FROM cards WHERE id = ?', h.cardId);
  if (!c) return h;
  return { ...h, game: h.game ?? c.game, name: h.name ?? c.name, setName: h.setName ?? c.set_name, number: h.number ?? c.number, image: h.image ?? c.image };
}

function valuationsFor(db, holdings) {
  const ids = [...new Set(holdings.map((h) => h.cardId))];
  const out = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    const rows = db.all(`SELECT * FROM valuations WHERE card_id IN (${part.map(() => '?').join(',')})`, ...part);
    for (const [cid, vs] of groupBy(rows, (r) => r.card_id)) out.set(cid, vs);
  }
  return out;
}

/** Valuation row for a holding's variant, falling back to the card's priciest variant. */
function pickVal(vs, variant) {
  if (!vs?.length) return null;
  return vs.find((v) => v.variant === variant) ?? [...vs].sort((a, b) => (b.raw ?? 0) - (a.raw ?? 0))[0];
}

export function valuedHoldings(db) {
  const hs = db.all('SELECT * FROM holdings WHERE deleted = 0 ORDER BY updated_at DESC').map(rowToHolding);
  const vals = valuationsFor(db, hs);
  return hs.map((h) => {
    const v = pickVal(vals.get(h.cardId), h.variant);
    const { value, basis } = holdingValue(h, v);
    return {
      ...h,
      imageUrl: img(h.image),
      value,
      basis,
      total: value != null ? Math.round(value * h.quantity * 100) / 100 : null,
      change7d: v?.change_7d ?? null,
      variantResolved: v?.variant ?? h.variant,
    };
  });
}

export function summary(db, { days = 90 } = {}) {
  const items = valuedHoldings(db);
  let value = 0;
  let cost = 0;
  let costKnown = 0;
  let change7 = 0;
  let count = 0;
  const byGame = {};
  for (const h of items) {
    count += h.quantity;
    if (h.total != null) {
      value += h.total;
      byGame[h.game ?? 'other'] = (byGame[h.game ?? 'other'] ?? 0) + h.total;
      if (h.change7d != null) change7 += h.total - h.total / (1 + h.change7d);
    }
    if (h.costBasis != null) { cost += h.costBasis * h.quantity; costKnown += h.total ?? 0; }
  }
  const movers = items.filter((h) => h.change7d != null && h.total >= 1)
    .sort((a, b) => Math.abs(b.change7d * b.total) - Math.abs(a.change7d * a.total)).slice(0, 6);
  return {
    value: r2(value),
    cost: cost ? r2(cost) : null,
    gain: cost ? r2(costKnown - cost) : null,
    gainPct: cost ? r2((costKnown - cost) / cost) : null,
    change7d: r2(change7),
    change7dPct: value ? Math.round((change7 / (value - change7)) * 10000) / 10000 : null,
    count,
    unique: items.length,
    byGame,
    movers,
    history: portfolioSeries(db, items, days),
  };
}

const r2 = (x) => Math.round(x * 100) / 100;

/**
 * Value of the *current* collection on each past day, rebuilt from card price
 * history (so the chart is meaningful as soon as cards are added).
 */
function portfolioSeries(db, items, days = 90) {
  if (!items.length) return [];
  const since = daysAgo(days);
  const ids = [...new Set(items.map((h) => h.cardId))];
  const hist = [];
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    hist.push(...db.all(`SELECT card_id, variant, day, raw, g9, psa10 FROM history WHERE day >= ? AND card_id IN (${part.map(() => '?').join(',')})`, since, ...part));
  }
  const byKey = groupBy(hist, (h) => `${h.card_id}|${h.variant}`);
  const allDays = [...new Set(hist.map((h) => h.day))].sort();
  if (!allDays.includes(day())) allDays.push(day());
  const totals = new Map(allDays.map((d) => [d, 0]));
  for (const h of items) {
    if (h.total == null) continue;
    const pts = byKey.get(`${h.cardId}|${h.variantResolved}`) ?? [];
    const metric = h.basis === 'psa10' ? 'psa10' : h.basis === 'g9' ? 'g9' : 'raw';
    const nowRef = pts.length ? pts[pts.length - 1] : null;
    const map = new Map(pts.map((p) => [p.day, p]));
    let last = null;
    for (const d of allDays) {
      const p = map.get(d);
      if (p) last = p;
      let v = h.total;
      if (last && nowRef) {
        const ref = nowRef[metric] ?? nowRef.raw;
        const then = last[metric] ?? last.raw;
        if (ref > 0 && then > 0) v = h.total * (then / ref);
      } else if (!last && pts.length) {
        // Before this card's first data point: assume first known value.
        const first = pts[0];
        const ref = nowRef[metric] ?? nowRef.raw;
        const then = first[metric] ?? first.raw;
        if (ref > 0 && then > 0) v = h.total * (then / ref);
      }
      totals.set(d, totals.get(d) + v);
    }
  }
  return allDays.map((d) => [d, r2(totals.get(d))]);
}

export function snapshotPortfolio(db) {
  const items = valuedHoldings(db);
  if (!items.length) return;
  const value = items.reduce((s, h) => s + (h.total ?? 0), 0);
  const cost = items.reduce((s, h) => s + (h.costBasis ?? 0) * h.quantity, 0);
  db.run(`INSERT INTO portfolio_history (day, value, cost, count) VALUES (?,?,?,?)
    ON CONFLICT(day) DO UPDATE SET value = excluded.value, cost = excluded.cost, count = excluded.count`,
    day(), r2(value), r2(cost), items.reduce((s, h) => s + h.quantity, 0));
}

export { gradeKey };
