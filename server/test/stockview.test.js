import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byStore, byProduct, stockLabel, logLabel, radiusOptions, isStale } from '../../web/src/lib/stock.ts';

const store = (id, distance, chain = 'bestbuy') => ({ id: `${chain}:${id}`, chain, number: String(id), name: `Store ${id}`, distance });
const product = (id, name, chain = 'bestbuy') => ({ id: `${chain}:${id}`, chain, sku: String(id), name, price: 10 });
const doc = {
  v: 1, updatedAt: 1000, radius: 50,
  chains: { bestbuy: { name: 'Best Buy', ok: true, exact: false }, dg: { name: 'Dollar General', ok: true, exact: true } },
  stores: [store(2, 30), store(1, 5.2), store(3, 12), store(9, 8, 'dg')],
  products: [product('a', 'Delta Reign Booster Bundle'), product('b', '30th Celebration Mini Tin'), product('c', 'Pokémon Poster Collection', 'dg')],
  stock: [
    { s: 'bestbuy:1', p: 'bestbuy:a', in: true, low: false, qty: null, since: 10, log: [[10, 1]] },
    { s: 'bestbuy:1', p: 'bestbuy:b', in: false, low: false, qty: null, since: 50, log: [[10, 1], [50, 0]] },
    { s: 'bestbuy:2', p: 'bestbuy:a', in: true, low: true, qty: null, since: 20, log: [[20, 1]] },
    { s: 'bestbuy:2', p: 'bestbuy:b', in: true, low: false, qty: null, since: 20, log: [[20, 1]] },
    { s: 'dg:9', p: 'dg:c', in: true, low: false, qty: 3, since: 30, log: [[30, 3]] },
  ],
};
const all = { chain: null, miles: 50, inStockOnly: false, query: '' };

test('by store: closest first, in-stock lines before sold-out ones', () => {
  const g = byStore(doc, all);
  assert.deepEqual(g.map((x) => x.store.id), ['bestbuy:1', 'dg:9', 'bestbuy:3', 'bestbuy:2']);
  assert.deepEqual(g[0].items.map((i) => [i.product.sku, i.entry.in]), [['a', true], ['b', false]]);
  assert.equal(g[0].inStock, 1);
  assert.equal(g[2].items.length, 0, 'a store with nothing is still listed');
  assert.deepEqual(g[3].items.map((i) => i.product.name), ['30th Celebration Mini Tin', 'Delta Reign Booster Bundle'], 'by name');
  assert.equal(g[1].chainName, 'Dollar General');
  assert.equal(g[1].exact, true);
});

test('in stock only, chain, distance and search narrow it down', () => {
  const only = byStore(doc, { ...all, inStockOnly: true });
  assert.deepEqual(only.map((x) => x.store.id), ['bestbuy:1', 'dg:9', 'bestbuy:2']);
  assert.deepEqual(only[0].items.map((i) => i.product.sku), ['a'], 'sold-out lines hidden');
  assert.deepEqual(byStore(doc, { ...all, chain: 'dg' }).map((x) => x.store.id), ['dg:9']);
  assert.deepEqual(byStore(doc, { ...all, miles: 10 }).map((x) => x.store.id), ['bestbuy:1', 'dg:9']);
  assert.deepEqual(byStore(doc, { ...all, query: 'mini tin' }).map((x) => x.store.id), ['bestbuy:1', 'bestbuy:2']);
  assert.deepEqual(byStore(doc, { ...all, query: 'pokemon poster' }).map((x) => x.store.id), ['dg:9'], 'accents ignored');
});

test('by product: in the most stores first, each with its stores closest first', () => {
  const g = byProduct(doc, all);
  assert.deepEqual(g.map((x) => [x.product.sku, x.places.map((p) => p.store.number)]), [['a', ['1', '2']], ['b', ['2']], ['c', ['9']]]);
  assert.deepEqual(byProduct(doc, { ...all, miles: 10 }).map((x) => x.product.sku), ['a', 'c']);
});

test('labels', () => {
  assert.equal(stockLabel({ in: true, low: false, qty: null }), 'In stock');
  assert.equal(stockLabel({ in: true, low: true, qty: null }), 'Low stock');
  assert.equal(stockLabel({ in: true, low: false, qty: 3 }), '3 on hand');
  assert.equal(stockLabel({ in: false, low: false, qty: null }), 'Sold out');
  assert.equal(logLabel(0, true), 'Sold out');
  assert.equal(logLabel(2, true), '2 on hand');
  assert.equal(logLabel(1, false), 'In stock');
  assert.deepEqual(radiusOptions(50), [10, 25, 50]);
  assert.deepEqual(radiusOptions(30), [10, 25, 30]);
  assert.ok(isStale({ updatedAt: 0 }, 3 * 3600_000) && !isStale({ updatedAt: 0 }, 3600_000));
});
