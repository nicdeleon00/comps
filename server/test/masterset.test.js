import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitName, slotsBySet, ownedMap, withOwned, progress, slotDone, compareNumbers } from '../../web/src/lib/masterset.ts';

const v = (variant, raw) => [variant, raw, null, null, null];
const idx = {
  imageBase: 'https://img/',
  sets: { 1: ['Prismatic Evolutions', 'PRE', 'Scarlet & Violet', '2025-01-17'] },
  cards: [
    [11, 'Eevee (Master Ball Pattern)', '1', '074', '131', 'Common', [v('holofoil', 12)]],
    [10, 'Eevee', '1', '074', '131', 'Common', [v('normal', 0.25), v('reverseHolofoil', 0.3)]],
    [12, 'Eevee (Poke Ball Pattern)', '1', '074', '131', 'Common', [v('holofoil', 1.25)]],
    [20, 'Umbreon ex', '1', '161', '131', 'Special Illustration Rare', [v('holofoil', 1100)]],
    [30, 'Eevee ex', '1', '75', '131', 'Double Rare', [v('holofoil', 5)]],
    [40, 'Leafeon', '1', '006', '131', 'Rare', [v('holofoil', null)]],
  ],
};

test('pattern names split into the card and its printing', () => {
  assert.deepEqual(splitName('Eevee (Poke Ball Pattern)'), { base: 'Eevee', tags: ['Poké Ball'] });
  assert.deepEqual(splitName("Erika's Oddish (Energy Symbol Pattern)"), { base: "Erika's Oddish", tags: ['Energy Symbol'] });
  assert.deepEqual(splitName('Pikachu (Prerelease) [Staff]'), { base: 'Pikachu', tags: ['Prerelease', 'Staff'] });
  assert.deepEqual(splitName('Umbreon ex'), { base: 'Umbreon ex', tags: [] });
});

test('every printing of a card number becomes one slot, in collector order', () => {
  const slots = slotsBySet(idx).get('1');
  assert.deepEqual(slots.map((s) => s.number), ['006', '074', '75', '161']);
  const eevee = slots.find((s) => s.number === '074');
  assert.equal(eevee.name, 'Eevee');
  assert.equal(eevee.cardId, 'tcg:10', 'the untagged product is the face of the slot');
  assert.deepEqual(eevee.printings.map((p) => p.label), ['Normal', 'Reverse Holo', 'Poké Ball', 'Master Ball']);
  assert.deepEqual(eevee.printings.map((p) => p.short), ['N', 'RH', 'PB', 'MB']);
  assert.notEqual(slots.find((s) => s.number === '75').key, eevee.key, 'Eevee ex is its own card');
});

test('progress counts what you have, its value and the cost to finish', () => {
  const owned = ownedMap([
    { cardId: 'tcg:10', variantResolved: 'normal', quantity: 3 },
    { cardId: 'tcg:12', variantResolved: 'holofoil', quantity: 1 },
    { cardId: 'tcg:99', variantResolved: null, quantity: 1 },
  ]);
  const slots = withOwned(slotsBySet(idx).get('1'), owned);
  const eevee = slots.find((s) => s.number === '074');
  assert.equal(eevee.printings[0].have, 3);
  const master = progress(slots, 'master');
  assert.deepEqual(master, { total: 7, owned: 2, value: 1.5, toComplete: 1117.3, full: 1118.8, unpriced: 1 });
  const base = progress(slots, 'base');
  // One of each: Eevee counts once (its best copy you have), others at their cheapest printing.
  assert.equal(base.total, 4);
  assert.equal(base.owned, 1);
  assert.equal(base.value, 1.25);
  assert.equal(base.toComplete, 1105);
  assert.equal(slotDone(eevee, 'base'), true);
  assert.equal(slotDone(eevee, 'master'), false);
});

test('card numbers sort like a binder', () => {
  assert.deepEqual(['TG02', '10', '2', '001', 'TG10', '100'].sort(compareNumbers), ['001', '2', '10', '100', 'TG02', 'TG10']);
});
