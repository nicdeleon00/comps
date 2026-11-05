import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLookup, matchListing, parsePrice, fakePrice } from '../../extension/matcher.js';
import { fakePrice as siteFakePrice } from '../../web/src/lib/fakePrice.ts';

const v = (variant, raw, g9 = null, psa10 = null) => [variant, raw, g9, psa10, null];
const lookup = buildLookup({
  imageBase: 'https://img/',
  sets: {
    1: ['Scarlet & Violet 151', 'MEW', 'Scarlet & Violet', '2023-09-22'],
    2: ['Prismatic Evolutions', 'PRE', 'Scarlet & Violet', '2025-01-17'],
    3: ['Obsidian Flames', 'OBF', 'Scarlet & Violet', '2023-08-11'],
    4: ['Evolving Skies', 'EVS', 'Sword & Shield', '2021-08-27'],
    5: ['Pikachu World Collection Promos', null, 'Other', '2010-01-01'],
  },
  cards: [
    [100, 'Charizard ex', '1', '199', '165', 'Special Illustration Rare', [v('holofoil', 300, 400, 1200)]],
    [101, 'Charizard ex', '1', '006', '165', 'Double Rare', [v('holofoil', 5)]],
    [102, 'Charizard ex', '1', '183', '165', 'Ultra Rare', [v('holofoil', 9)]],
    [103, 'Charizard ex', '3', '223', '197', 'Special Illustration Rare', [v('holofoil', 90)]],
    [110, 'Pikachu', '1', '025', '165', 'Common', [v('normal', 0.3), v('reverseHolofoil', 0.8)]],
    [111, 'Pikachu', '5', '6', null, 'Promo', [v('holofoil', 60)]],
    [200, 'Eevee', '2', '074', '131', 'Common', [v('normal', 0.25), v('reverseHolofoil', 0.3)]],
    [201, 'Eevee (Master Ball Pattern)', '2', '074', '131', 'Common', [v('holofoil', 12)]],
    [202, 'Eevee (Poke Ball Pattern)', '2', '074', '131', 'Common', [v('holofoil', 1.25)]],
    [300, 'Umbreon VMAX (Alternate Art Secret)', '4', '215', '203', 'Secret Rare', [v('holofoil', 2200)]],
    [301, 'Umbreon VMAX', '4', '095', '203', 'Ultra Rare', [v('holofoil', 6)]],
  ],
});
const m = (title, price = 10) => matchListing(lookup, { title, price });

test('a card number pins the card', () => {
  const x = m('Charizard ex 199/165', 180);
  assert.equal(x.card.id, 'tcg:100');
  assert.equal(x.value, 300);
  assert.equal(x.discount, 0.4);
  assert.ok(x.deal && x.confident);
});

test('without a number: name, then set and rarity words', () => {
  assert.equal(m('Charizard ex SIR 151').card.id, 'tcg:100');
  assert.equal(m('charizard ex obsidian flames').card.id, 'tcg:103');
  assert.equal(m('Umbreon VMAX alt art').card.id, 'tcg:300');
  assert.equal(m('Moonbreon').card.id, 'tcg:300', 'nickname');
});

test('a title that fits several cards gives a range, and only beats the cheapest', () => {
  const x = m('Pokemon Charizard ex 151', 4);
  assert.equal(x.confident, false);
  assert.equal(x.value, null);
  assert.deepEqual([x.low, x.high, x.matches], [5, 300, 3]);
  assert.equal(x.deal, false, '$4 vs $5 cheapest is too small a saving');
  assert.equal(m('Pokemon Charizard ex 151', 1.5).deal, true, 'under even the cheapest Charizard ex in 151');
});

test('pattern printings and plain printings', () => {
  assert.equal(m('Eevee master ball prismatic').card.id, 'tcg:201');
  assert.equal(m('Eevee pokeball 074/131').card.id, 'tcg:202');
  assert.equal(m('Eevee 074/131').card.id, 'tcg:200');
  assert.equal(m('Pikachu 025/165 reverse holo').variant, 'reverseHolofoil');
});

test('the card\'s own name doesn\'t vote for a set', () => {
  // "Pikachu" alone must not jump to the Pikachu promo set; it stays a range (or nothing).
  const x = m('Pikachu');
  assert.ok(!x || !x.confident);
});

test('graded listings use graded prices', () => {
  assert.equal(m('PSA 10 Charizard ex 199/165').value, 1200);
  assert.equal(m('Charizard ex 199/165 CGC 9').basis, 'g9');
  assert.equal(m('Charizard ex 199/165 BGS 8.5').value, null);
});

test('skips what it can\'t price honestly', () => {
  for (const t of ['Pokemon card lot 199/165 charizard', 'Japanese Charizard ex 199/165', 'WTB Charizard ex SIR', 'Prismatic Evolutions booster bundle', 'Blastoise 199/165', 'Pokemon cards']) {
    assert.equal(m(t), null, t);
  }
  for (const p of [0, 1, 12, 123, 1234, 69, 420, 9999, 999999]) {
    const x = m('Charizard ex 199/165', p);
    assert.ok(x.fake && !x.deal && x.discount == null, `${p} is not a real price`);
  }
});

test('reads Marketplace prices', () => {
  assert.equal(parsePrice('$1,250'), 1250);
  assert.equal(parsePrice('$45.50'), 45.5);
  assert.equal(parsePrice('$8$10'), 8, 'reduced price');
  assert.equal(parsePrice('Free'), null);
  assert.equal(parsePrice('CA$40'), null);
});

test('fake prices: placeholders, number mashes, memes and absurd asks; the website agrees', () => {
  const cases = [
    [0, null, true], [1, null, true], [1.5, 10, false], [12, null, true], [123, null, true], [1234, null, true], [123456, null, true],
    [69, null, true], [420, null, true], [9999, null, true], [999999, null, true], [111, 10, true], [111, 500, false], [999, 1000, false],
    [999, 100, true], [5000, 10, true], [5000, 4000, false], [180, 317, false], [234, null, false], [150000, null, true],
  ];
  for (const [price, worth, fake] of cases) {
    assert.equal(fakePrice(price, worth), fake, `extension: ${price} (worth ${worth})`);
    assert.equal(siteFakePrice(price, worth), fake, `website: ${price} (worth ${worth})`);
  }
});
