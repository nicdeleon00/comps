import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { upsertCards } from '../src/store.js';
import { buildIndex } from '../src/catalogIndex.js';

const card = (pid, name, number, total) => ({
  id: `tcg:${pid}`, game: 'pokemon', name, setName: 'Mega Evolution Promo', number, printedTotal: total, rarity: 'Promo',
  ext: { groupId: 24451, series: 'Mega Evolution', baseName: name },
});

test('a new promo with no price yet is still in the catalog, so it can be scanned', () => {
  const db = openDatabase(':memory:');
  db.run(`INSERT INTO sets (id, name, code, series, released, cards) VALUES ('24451', 'Mega Evolution Promo', 'MEP', 'Mega Evolution', '2025-09-26', 2)`);
  upsertCards(db, [card(700001, 'Mega Darkrai ex', '090', null), card(650000, 'Pikachu', '001', null)]);
  db.run(`INSERT INTO valuations (card_id, variant, raw, change_7d) VALUES ('tcg:650000', 'holofoil', 12.345, 0.0512)`);

  const idx = buildIndex(db);
  assert.deepEqual(Object.keys(idx.sets), ['24451']);
  const darkrai = idx.cards.find((c) => c[0] === 700001);
  assert.deepEqual(darkrai, [700001, 'Mega Darkrai ex', '24451', '090', null, 'Promo', []], 'listed, with no printings yet');
  assert.deepEqual(idx.cards.find((c) => c[0] === 650000)[6], [['holofoil', 12.35, null, null, 0.051]], 'priced cards unchanged');
});
