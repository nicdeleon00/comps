import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLookup, matchListing, parsePrice } from '../../extension/matcher.js';

const v = (variant, raw, g9 = null, psa10 = null) => [variant, raw, g9, psa10, null];
const lookup = buildLookup({
  imageBase: 'https://img/',
  sets: { 1: ['Scarlet & Violet 151', 'MEW', 'Scarlet & Violet', '2023-09-22'], 2: ['Prismatic Evolutions', 'PRE', 'Scarlet & Violet', '2025-01-17'], 3: ['Paldean Fates', 'PAF', 'Scarlet & Violet', '2024-01-26'] },
  cards: [
    [100, 'Charizard ex', '1', '199', '165', 'Special Illustration Rare', [v('holofoil', 300, 400, 1200)]],
    [101, 'Pikachu', '1', '025', '165', 'Common', [v('normal', 0.3), v('reverseHolofoil', 0.8)]],
    [200, 'Eevee', '2', '074', '131', 'Common', [v('normal', 0.25), v('reverseHolofoil', 0.3)]],
    [201, 'Eevee (Master Ball Pattern)', '2', '074', '131', 'Common', [v('holofoil', 12)]],
    [202, 'Eevee (Poke Ball Pattern)', '2', '074', '131', 'Common', [v('holofoil', 1.25)]],
    [300, 'Charizard ex', '3', '054', '091', 'Double Rare', [v('holofoil', 10)]],
  ],
});

test('prices a single card from its name and number', () => {
  const m = matchListing(lookup, { title: 'Charizard ex 199/165 SIR 151', price: 180 });
  assert.equal(m.card.id, 'tcg:100');
  assert.equal(m.value, 300);
  assert.equal(m.discount, 0.4);
  assert.equal(m.confident, true);
});

test('graded listings use graded prices', () => {
  assert.equal(matchListing(lookup, { title: 'PSA 10 Charizard ex 199/165', price: 900 }).value, 1200);
  assert.equal(matchListing(lookup, { title: 'Charizard ex 199/165 CGC 9', price: 900 }).basis, 'g9');
  const bgs = matchListing(lookup, { title: 'Charizard ex 199/165 BGS 8.5', price: 200 });
  assert.equal(bgs.value, null, 'no price for grades we don\'t track');
});

test('picks the right printing', () => {
  assert.equal(matchListing(lookup, { title: 'Eevee 074/131 Master Ball pattern', price: 8 }).card.id, 'tcg:201');
  assert.equal(matchListing(lookup, { title: 'Eevee pokeball 074/131', price: 1 }).card.id, 'tcg:202');
  const plain = matchListing(lookup, { title: 'Eevee 074/131 prismatic', price: 1 });
  assert.equal(plain.card.id, 'tcg:200');
  assert.equal(plain.variant, 'normal');
  assert.equal(matchListing(lookup, { title: 'Pikachu 025/165 reverse holo', price: 1 }).variant, 'reverseHolofoil');
});

test('skips what it can\'t price honestly', () => {
  assert.equal(matchListing(lookup, { title: 'Pokemon card lot 199/165 charizard', price: 50 }), null);
  assert.equal(matchListing(lookup, { title: 'Japanese Charizard ex 199/165', price: 50 }), null);
  assert.equal(matchListing(lookup, { title: 'Charizard ex SIR', price: 50 }), null, 'no number');
  assert.equal(matchListing(lookup, { title: 'Blastoise 199/165', price: 50 }), null, 'number fits but name doesn\'t');
});

test('reads Marketplace prices', () => {
  assert.equal(parsePrice('$1,250'), 1250);
  assert.equal(parsePrice('$45.50'), 45.5);
  assert.equal(parsePrice('$8$10'), 8, 'reduced price');
  assert.equal(parsePrice('Free'), null);
  assert.equal(parsePrice('CA$40'), null);
});
