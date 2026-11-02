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
  assert.ok(!s.items.some((x) => x.card.id.startsWith('pc:demo-pkm')));
});

test('card detail has grading EV, history and links', async () => {
  const { api } = setup();
  const d = await api('GET', '/api/cards/pkm:base1-4', {});
  assert.equal(d.card.name, 'Charizard');
  assert.ok(d.variants[0].grading.ev > 0);
  assert.ok(d.history.holofoil.length > 100);
  assert.ok(d.links.ebaySold.includes('LH_Sold=1'));
});

test('identify resolves printed identifiers without live lookups', async () => {
  const { api } = setup();
  const r = await api('POST', '/api/identify', {}, { live: false, lines: [{ text: 'Umbreon VMAX', y: 0.05, h: 0.05 }, { text: '215/203', y: 0.95, h: 0.02 }] });
  assert.equal(r.candidates[0].card.id, 'pkm:swsh7-215');
  assert.ok(r.candidates[0].card.price > 0);
});

test('collection sync is last-write-wins with tombstones', async () => {
  const { api } = setup();
  const base = await api('POST', '/api/collection/sync', {}, { items: [], since: 0 });
  const h = base.items[0];
  const stale = await api('POST', '/api/collection/sync', {}, { items: [{ ...h, quantity: 9, updatedAt: h.updatedAt - 1 }], since: base.serverTime });
  assert.equal(stale.applied, 0);
  const fresh = await api('POST', '/api/collection/sync', {}, { items: [{ ...h, quantity: 9, updatedAt: Date.now() + 1 }], since: base.serverTime });
  assert.equal(fresh.applied, 1);
  assert.equal(fresh.items[0].quantity, 9);
  await api('DELETE', `/api/collection/${h.id}`, {});
  const after = await api('GET', '/api/collection', {});
  assert.ok(!after.items.some((x) => x.id === h.id));
  const created = await api('POST', '/api/collection', {}, { cardId: 'pkm:base1-58', grader: 'PSA', grade: '10' });
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

test('PriceCharting products link to catalog cards by name, number and set', () => {
  const db = openDatabase(':memory:');
  upsertCards(db, [{ id: 'pkm:base1-4', game: 'pokemon', name: 'Charizard', setName: 'Base', number: '4' }]);
  upsertQuotes(db, [{ cardId: 'pkm:base1-4', variant: 'holofoil', source: 'tcgplayer', data: { market: 400 } }]);
  const rows = [
    { id: '1', 'product-name': 'Charizard #4', 'console-name': 'Pokemon Base Set', 'loose-price': '400', 'manual-only-price': '9000' },
    { id: '2', 'product-name': 'Charizard [1st Edition] #4', 'console-name': 'Pokemon Base Set', 'loose-price': '9000', 'manual-only-price': '300000' },
    { id: '3', 'product-name': 'Charizard #4', 'console-name': 'Pokemon Japanese Base Set', 'loose-price': '200', 'manual-only-price': '2000' },
  ].map((r) => mapRow(r, 'pokemon-cards'));
  upsertCards(db, rows.map((r) => r.card));
  upsertQuotes(db, rows.map((r) => r.quote));
  linkPriceCharting(db);
  const links = db.all('SELECT * FROM links');
  assert.equal(links.length, 1);
  assert.equal(links[0].pc_id, 'pc:1');
  assert.equal(links[0].variant, 'holofoil');
});
