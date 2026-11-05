import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createSettings } from '../src/settings.js';
import { createJobs } from '../src/jobs.js';
import { createApi } from '../src/api.js';
import { seedDemo } from '../src/demo.js';
import { linkPriceCharting, mapRow } from '../src/providers/pricecharting.js';
import { upsertCards, upsertQuotes } from '../src/store.js';

function setup() {
  const db = openDatabase(':memory:');
  const settings = createSettings(db);
  const jobs = createJobs(db, settings);
  seedDemo(db, settings);
  jobs.recompute();
  const api = createApi({ db, settings, jobs });
  return { db, settings, jobs, api };
}

test('market, deals and spreads come back populated and sorted', async () => {
  const { api } = setup();
  const m = await api('GET', '/api/market', {});
  assert.ok(m.deals.length > 0);
  assert.ok(m.spreads.length > 0);
  const d = await api('GET', '/api/deals', { limit: '100' });
  for (let i = 1; i < d.items.length; i++) assert.ok(d.items[i - 1].score >= d.items[i].score);
  const s = await api('GET', '/api/spreads', { sort: 'roi', limit: '100' });
  for (let i = 1; i < s.items.length; i++) assert.ok(s.items[i - 1].roi >= s.items[i].roi);
  // Linked PriceCharting duplicates never show up as separate rows.
  assert.ok(!s.items.some((x) => x.card.id.startsWith('pc:')));
});

test('card detail has grading EV, history and links', async () => {
  const { api } = setup();
  const d = await api('GET', '/api/cards/tcg:42382', {});
  assert.equal(d.card.name, 'Charizard');
  assert.ok(d.variants[0].grading.ev > 0);
  assert.ok(d.history.holofoil.length > 100);
  assert.ok(d.links.ebaySold.includes('LH_Sold=1'));
});

test('collection: edit, delete and add graded copies', async () => {
  const { api } = setup();
  const h = (await api('GET', '/api/collection', {})).items[0];
  const edited = await api('PATCH', `/api/collection/${h.id}`, {}, { quantity: 9 });
  assert.equal(edited.quantity, 9);
  await api('DELETE', `/api/collection/${h.id}`, {});
  const after = await api('GET', '/api/collection', {});
  assert.ok(!after.items.some((x) => x.id === h.id));
  const created = await api('POST', '/api/collection', {}, { cardId: 'tcg:900005', grader: 'PSA', grade: '10' });
  assert.equal(created.name, 'Pikachu');
  assert.equal(created.basis, 'psa10');
});

test('settings never leak secrets and ignore masked echoes', async () => {
  const { api, settings } = setup();
  await api('PUT', '/api/settings', {}, { pricechartingToken: 'secret-token-1234' });
  const pub = await api('GET', '/api/settings', {});
  assert.equal(pub.pricechartingToken, '••••1234');
  await api('PUT', '/api/settings', {}, { pricechartingToken: '••••1234', gradingFee: 30 });
  assert.equal(settings.get().pricechartingToken, 'secret-token-1234');
  assert.equal(settings.get().gradingFee, 30);
});

test('PriceCharting products link to TCGplayer cards by product id, or name, number and set', () => {
  const db = openDatabase(':memory:');
  upsertCards(db, [
    { id: 'tcg:42382', game: 'pokemon', name: 'Charizard', setName: 'Base Set', number: '004', ext: { baseName: 'Charizard', groupId: 604 } },
    { id: 'tcg:106999', game: 'pokemon', name: 'Charizard', setName: 'Base Set (Shadowless)', number: '004', ext: { baseName: 'Charizard', groupId: 1663 } },
  ]);
  upsertQuotes(db, [
    { cardId: 'tcg:42382', variant: 'holofoil', source: 'tcgplayer', data: { market: 400 } },
    { cardId: 'tcg:106999', variant: '1stEditionHolofoil', source: 'tcgplayer', data: { market: 9000 } },
    { cardId: 'tcg:106999', variant: 'holofoil', source: 'tcgplayer', data: { market: 1500 } },
  ]);
  const rows = [
    { id: '1', 'product-name': 'Charizard #4', 'console-name': 'Pokemon Base Set', 'loose-price': '400', 'manual-only-price': '9000' },
    { id: '2', 'product-name': 'Charizard [1st Edition] #4', 'console-name': 'Pokemon Base Set', 'loose-price': '9000', 'manual-only-price': '300000' },
    { id: '3', 'product-name': 'Charizard #4', 'console-name': 'Pokemon Japanese Base Set', 'loose-price': '200', 'manual-only-price': '2000' },
    { id: '4', 'product-name': 'Charizard [Shadowless] #4', 'console-name': 'Pokemon Base Set', 'loose-price': '1500', 'manual-only-price': '50000' },
  ].map((r) => mapRow(r, 'pokemon-cards'));
  upsertCards(db, rows.map((r) => r.card));
  upsertQuotes(db, rows.map((r) => r.quote));
  linkPriceCharting(db);
  const links = db.all('SELECT * FROM links ORDER BY pc_id');
  assert.deepEqual(links.map((l) => `${l.pc_id}>${l.card_id}/${l.variant}`), ['pc:1>tcg:42382/holofoil', 'pc:4>tcg:106999/holofoil']);
});

test('sets endpoint groups cards by set with values', async () => {
  const { api } = setup();
  const sets = await api('GET', '/api/sets', {});
  assert.ok(sets.items.length >= 5);
  const evs = sets.items.find((s) => s.name === 'Evolving Skies');
  assert.ok(evs.value > 1000);
  const detail = await api('GET', `/api/sets/${evs.id}`, {});
  assert.equal(detail.cards[0].name, 'Umbreon VMAX (Alternate Art Secret)');
  const filtered = await api('GET', '/api/deals', { series: 'Wizards of the Coast', limit: '100' });
  assert.ok(filtered.items.every((d) => d.card.series === 'Wizards of the Coast'));
});

test('reprint products are flagged so the scanner prefers the original printing', async () => {
  const { reprintGroups } = await import('../src/engine/printings.js');
  const db = openDatabase(':memory:');
  const set = (id, name, released) => db.run('INSERT INTO sets (id, name, code, series, released, supplemental, modified, cards) VALUES (?,?,?,?,?,?,?,?)', id, name, null, 'Scarlet & Violet', released, 0, null, 12);
  set('1', 'Obsidian Flames', '2023-08-11');
  set('2', 'Holiday Reprints', '2024-11-01');
  set('3', 'Prize Pack Series Cards', '2022-01-01');
  const card = (gid, i, name) => ({ id: `tcg:${gid}${String(i).padStart(3, '0')}`, game: 'pokemon', name, number: String(i).padStart(3, '0'), printedTotal: '197', ext: { groupId: gid, baseName: name } });
  const cards = [];
  for (let i = 1; i <= 12; i++) {
    cards.push(card('1', i, `Mon ${i}`));
    cards.push(card('2', i, i <= 9 ? `Mon ${i}` : `New ${i}`)); // 9 of 12 repeat Obsidian Flames
  }
  cards.push(card('3', 1, 'Mon 1'));
  upsertCards(db, cards);
  const alt = reprintGroups(db);
  assert.ok(alt.has('2'), 'mostly repeats an earlier set');
  assert.ok(alt.has('3'), 'known reprint product, by name');
  assert.ok(!alt.has('1'), 'the original set');
});
