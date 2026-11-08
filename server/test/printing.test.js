import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byPrinting } from '../src/catalogIndex.js';

// [printing, raw price]: a card's printings are sorted so the first is what it defaults to.
const order = (...v) => v.map((x) => [x[0], x[1]]).sort(byPrinting).map((x) => x[0]);

test('the regular printing comes first, 1st Edition last even when it is pricier', () => {
  assert.deepEqual(order(['1stEditionNormal', 40], ['normal', 0.5]), ['normal', '1stEditionNormal']);
  assert.deepEqual(order(['1stEditionHolofoil', 900], ['unlimitedHolofoil', 60]), ['unlimitedHolofoil', '1stEditionHolofoil']);
});

test('1st Edition sorts after printings the catalog does not know yet', () => {
  assert.deepEqual(order(['1stEditionNormal', 40], ['shadowless', 20]), ['shadowless', '1stEditionNormal']);
  assert.deepEqual(order(['1stEditionHolofoil', 900], ['someNewPrinting', 1]), ['someNewPrinting', '1stEditionHolofoil']);
});

test('a card that only comes in 1st Edition keeps it', () => {
  assert.deepEqual(order(['1stEditionHolofoil', 500]), ['1stEditionHolofoil']);
});

test('reverse holo is never ahead of the regular printing', () => {
  assert.deepEqual(order(['reverseHolofoil', 3], ['normal', 0.2]), ['normal', 'reverseHolofoil']);
});
