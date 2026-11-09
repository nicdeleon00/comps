import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDatabase } from '../src/db.js';

// A fake TCGCSV with two Japanese sets: 151 (with a price change between runs) and a sealed-only set.
let priceOf151 = 207.3;
let calls = [];
const server = createServer((req, res) => {
  calls.push(req.url);
  const send = (results) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ results })); };
  if (req.url === '/85/groups') return send([
    { groupId: 23599, name: 'SV2a: Pokemon Card 151', abbreviation: 'SV2a', publishedOn: '2023-06-16T00:00:00', modifiedOn: 'm1' },
    { groupId: 24489, name: 'Limited Collection Master Battle Set', abbreviation: '', publishedOn: '2026-11-08T00:00:00', modifiedOn: 'm1' },
  ]);
  if (req.url === '/85/23599/products') return send([
    { productId: 566346, name: 'Bulbasaur - 001/165', extendedData: [{ name: 'Number', value: '001/165' }, { name: 'Rarity', value: 'Common' }] },
    { productId: 577147, name: 'Mew ex - 205/165', extendedData: [{ name: 'Number', value: '205/165' }, { name: 'Rarity', value: 'Special Art Rare' }] },
    { productId: 999, name: 'Pokemon Card 151 Booster Box', extendedData: [] },
  ]);
  if (req.url === '/85/23599/prices') return send([
    { productId: 566346, subTypeName: 'Normal', marketPrice: 0.23 },
    { productId: 566346, subTypeName: 'Reverse Holofoil', marketPrice: null, midPrice: 0.5 },
    { productId: 577147, subTypeName: 'Holofoil', marketPrice: priceOf151 },
    { productId: 999, subTypeName: 'Normal', marketPrice: 90 },
  ]);
  if (req.url === '/85/24489/products') return send([{ productId: 1, name: 'Battle Set', extendedData: [] }]);
  res.statusCode = 404;
  res.end('{}');
});
await new Promise((r) => server.listen(0, r));
process.env.TCGCSV_BASE = `http://127.0.0.1:${server.address().port}`;
const { refreshJapan, buildJapaneseIndex, cleanJapaneseSetName, cleanJapaneseName, japaneseSeries } = await import('../src/japan.js');

test('card names without the number TCGplayer adds', () => {
  assert.equal(cleanJapaneseName('Pikachu - 025/165 (Poke Ball Pattern)'), 'Pikachu (Poke Ball Pattern)');
  assert.equal(cleanJapaneseName('Mew ex - 205/165'), 'Mew ex');
  assert.equal(cleanJapaneseName("N's Zoroark ex - 131/100"), "N's Zoroark ex");
  assert.equal(cleanJapaneseName('Ho-Oh'), 'Ho-Oh');
  assert.equal(cleanJapaneseName('Porygon-Z - 120/172'), 'Porygon-Z');
});

test('set names and eras from Japanese set codes', () => {
  assert.equal(cleanJapaneseSetName('SV2a: Pokemon Card 151'), 'Pokemon Card 151');
  assert.equal(cleanJapaneseSetName('S12a: VSTAR Universe'), 'VSTAR Universe');
  assert.equal(cleanJapaneseSetName('Vending Machine cards Series 1 (Blue)'), 'Vending Machine cards Series 1 (Blue)');
  assert.equal(japaneseSeries('SV2a', '', null), 'Scarlet & Violet');
  assert.equal(japaneseSeries('S12a', '', null), 'Sword & Shield');
  assert.equal(japaneseSeries('SM12a', '', null), 'Sun & Moon');
  assert.equal(japaneseSeries('M1L', '', null), 'Mega Evolution');
});

test('builds a Japanese catalog in the same shape as index.json, cards only', async () => {
  const db = openDatabase(':memory:');
  await refreshJapan(db);
  const idx = buildJapaneseIndex(db);
  assert.equal(idx.lang, 'ja');
  assert.deepEqual(Object.keys(idx.sets), ['23599']);
  assert.deepEqual(idx.sets['23599'], ['Pokemon Card 151', 'SV2a', 'Scarlet & Violet', '2023-06-16', 0]);
  assert.equal(idx.cards.length, 2);
  const bulba = idx.cards.find((c) => c[0] === 566346);
  assert.deepEqual(bulba.slice(0, 6), [566346, 'Bulbasaur', '23599', '001', '165', 'Common']);
  assert.deepEqual(bulba[6].map((v) => v[0]), ['normal', 'reverseHolofoil'], 'regular printing first');
  assert.equal(bulba[6][1][1], 0.5, 'mid price when there is no market price');
  assert.deepEqual(idx.cards.find((c) => c[0] === 577147)[6], [['holofoil', 207.3, null, null, null]]);
  // English tables untouched.
  assert.equal(db.get('SELECT COUNT(*) n FROM cards').n, 0);
});

test('later runs reuse the card lists and only refetch prices once a day', async () => {
  const db = openDatabase(':memory:');
  await refreshJapan(db);
  calls = [];
  priceOf151 = 250;
  await refreshJapan(db);
  assert.deepEqual(calls, ['/85/groups'], 'nothing refetched within a day');
  db.run('UPDATE japan_sets SET prices_at = 0');
  await refreshJapan(db);
  assert.ok(calls.includes('/85/23599/prices') && !calls.includes('/85/23599/products'));
  assert.equal(buildJapaneseIndex(db).cards.find((c) => c[0] === 577147)[6][0][1], 250);
});

test('TCGCSV down: keeps the last catalog', async () => {
  const db = openDatabase(':memory:');
  await refreshJapan(db);
  const before = buildJapaneseIndex(db).cards.length;
  const base = process.env.TCGCSV_BASE;
  server.close();
  await refreshJapan(db);
  assert.equal(buildJapaneseIndex(db).cards.length, before);
  process.env.TCGCSV_BASE = base;
});
