import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateHistory } from '../src/stock/history.js';
import { productHistory, storeHistory, duration } from '../../web/src/lib/stockHistory.ts';

const H = 3600_000, D = 24 * H;
const doc = (t, stock, checked = ['dg:a', 'dg:b']) => ({
  updatedAt: t, chains: { dg: { ok: true, exact: true, checked } }, stores: [{ id: 'dg:1' }, { id: 'dg:2' }],
  stock: stock.map(([s, p, qty]) => ({ s, p, in: qty > 0, qty: qty > 0 ? qty : null, since: t, log: [[t, qty]] })),
});

test('history: one point per change, sold out recorded, unread products left alone', () => {
  let h = updateHistory(null, doc(1000, [['dg:1', 'dg:a', 5]]));
  assert.deepEqual(h.series, { 'dg:1|dg:a': [[1000, 5]] });
  h = updateHistory(h, doc(2000, [['dg:1', 'dg:a', 5]]));
  assert.deepEqual(h.series['dg:1|dg:a'], [[1000, 5]], 'no change, no point');
  h = updateHistory(h, doc(3000, [['dg:1', 'dg:a', 3], ['dg:2', 'dg:b', 2]]));
  h = updateHistory(h, doc(4000, [['dg:2', 'dg:b', 2]]));
  assert.deepEqual(h.series['dg:1|dg:a'], [[1000, 5], [3000, 3], [4000, 0]]);
  // Product b not read this time: stays at 2, not sold out.
  h = updateHistory(h, doc(5000, [], ['dg:a']));
  assert.deepEqual(h.series['dg:2|dg:b'], [[3000, 2]]);
  assert.equal(h.start, 1000);
});

test('history: months-old points go, keeping the level they left', () => {
  const old = { v: 1, updatedAt: 0, start: 0, series: { 'dg:1|dg:a': [[0, 4], [1 * D, 2], [200 * D, 6]], 'dg:2|dg:b': [[0, 0]] } };
  const h = updateHistory(old, doc(200 * D + 1, [['dg:1', 'dg:a', 6]]));
  assert.deepEqual(h.series['dg:1|dg:a'], [[1 * D, 2], [200 * D, 6]]);
  assert.equal(h.series['dg:2|dg:b'], undefined);
});

test('a product at a store: restocks, how long each lasted, what went', () => {
  const p = productHistory('dg:a', [[0, 2], [1 * H, 0], [10 * H, 18], [20 * H, 12], [40 * H, 0], [50 * H, 6], [60 * H, 9]], 70 * H);
  assert.deepEqual(p.restocks.map((e) => [e.t, e.from, e.to]), [[10 * H, 0, 18], [50 * H, 0, 6], [60 * H, 6, 9]]);
  assert.deepEqual(p.stints, [{ start: 10 * H, end: 40 * H, added: 18 }, { start: 50 * H, end: null, added: 9 }]);
  assert.equal(p.avgShelf, 30 * H);
  assert.equal(p.went, 2 + 6 + 12);
  assert.equal(p.now, 9);
});

test('a store: usual restock day and hours, averages, newest first', () => {
  // Three Tuesday-morning deliveries (local time), two products in one of them.
  const tue = (week, hour) => new Date(2026, 10, 3 + 7 * week, hour, 0).getTime();
  const hist = { v: 1, updatedAt: 0, start: tue(0, 0), series: {
    'dg:1|dg:a': [[tue(0, 1), 0], [tue(0, 7), 10], [tue(0, 20), 0], [tue(1, 8), 12], [tue(2, 0), 0]],
    'dg:1|dg:b': [[tue(0, 1), 0], [tue(1, 8), 4], [tue(2, 7), 6]],
    'dg:2|dg:a': [[tue(0, 1), 3]],
  } };
  const s = storeHistory(hist, 'dg:1', tue(3, 0), 60);
  assert.equal(s.usualDay, 2, 'Tuesday');
  assert.deepEqual(s.usualHours, [6, 9]);
  assert.equal(s.restocks.length, 4);
  assert.equal(s.events[0].t, tue(2, 7), 'newest first');
  assert.equal(s.avgAdded, (10 + 12 + 4 + 2) / 4);
  assert.equal(s.avgShelf, ((20 - 7) * H + (tue(2, 0) - tue(1, 8))) / 2);
  assert.equal(s.products.length, 2);
  assert.equal(duration(90 * 60000), '1h 30m');
  assert.equal(duration(50 * H), '2d 2h');
});
