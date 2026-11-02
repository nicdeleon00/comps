import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradeEV, ERA_RATES, eraOf } from '../src/engine/grading.js';
import { classifyListing, parseGrade } from '../src/engine/listings.js';
import { extractFeatures } from '../src/engine/identify.js';
import { valuate, holdingValue, gradeKey } from '../src/engine/valuation.js';
import { scoreSignal } from '../src/engine/signals.js';
import { parseProductName, mapRow } from '../src/providers/pricecharting.js';
import { mapCard as mapPokemon } from '../src/providers/pokemontcg.js';
import { mapCard as mapScryfall } from '../src/providers/scryfall.js';
import { mapCard as mapYgo } from '../src/providers/ygoprodeck.js';
import { parseCSV, similarity, money } from '../src/lib/util.js';

const costs = { fee: 25, shipping: 5, sellFeePct: 0.13, sellFixed: 0 };

test('grade EV: hand-checked example', () => {
  const g = gradeEV({ raw: 20, g8: 15, g9: 40, psa10: 200 }, costs, { p10: 0.5, p9: 0.4, p8: 0.1 });
  // net10 = 174, net9 = 34.8, net8 = 13.05; EV = 87 + 13.92 + 1.305 = 102.225
  assert.equal(g.cost, 50);
  assert.equal(g.ev, 102.23);
  assert.ok(Math.abs(g.profit - 52.225) < 0.01);
  assert.equal(g.multiple, 10);
  // break-even: non-10 net = (0.4*34.8 + 0.1*13.05)/0.5 = 30.45; (50-30.45)/(174-30.45)
  assert.ok(Math.abs(g.breakEven - (50 - 30.45) / (174 - 30.45)) < 0.001);
});

test('grade EV: unprofitable even at 100% tens has no break-even', () => {
  const g = gradeEV({ raw: 100, g9: 90, psa10: 120 }, costs, ERA_RATES.modern);
  assert.equal(g.breakEven, null);
  assert.ok(g.profit < 0);
});

test('grade EV: needs raw and PSA 10', () => {
  assert.equal(gradeEV({ raw: 10 }, costs, ERA_RATES.modern), null);
  assert.equal(gradeEV({ psa10: 10 }, costs, ERA_RATES.modern), null);
});

test('era buckets', () => {
  assert.equal(eraOf('1999-01-09'), 'vintage');
  assert.equal(eraOf('2010-05-01'), 'mid');
  assert.equal(eraOf('2023-09-22'), 'modern');
});

const charizard = { game: 'pokemon', name: 'Charizard', number: '4', printed_total: '102', set_name: 'Base' };

test('listing filter: accepts a clean raw copy', () => {
  assert.deepEqual(classifyListing('Charizard 4/102 Base Set Holo Rare WOTC 1999 NM', charizard, 'holofoil'), { ok: true });
});

test('listing filter: parses graded slabs', () => {
  const r = classifyListing('PSA 9 MINT Charizard 4/102 Base Set Holo Unlimited', charizard, 'holofoil');
  assert.equal(r.ok, true);
  assert.equal(r.grader, 'PSA');
  assert.equal(r.grade, '9');
  assert.deepEqual(parseGrade('Beckett BGS 9.5 Gem Mint Lugia'), { grader: 'BGS', grade: '9.5' });
  assert.deepEqual(parseGrade('CGC Pristine 10 Pikachu'), { grader: 'CGC', grade: '10' });
});

test('listing filter: rejects junk, wrong printing, damage', () => {
  const cases = [
    ['Charizard 4/102 Base Set PROXY custom card', 'junk'],
    ['Charizard 4/102 Base Set 1st Edition Holo', 'edition'],
    ['Charizard 4/102 Base Set Shadowless Holo', 'shadowless'],
    ['Charizard 14/102 Holo Rare', 'number'],
    ['Charizard 4/102 Base Set Holo heavily played', 'condition'],
    ['Japanese Charizard No. 006 Base Set Holo 4/102', 'language'],
    ['Pokemon lot Charizard 4/102 and more', 'junk'],
    ['Charizard 4/102 Base Set Holo graded slab', 'graded-unknown'],
  ];
  for (const [title, why] of cases) {
    const r = classifyListing(title, charizard, 'holofoil');
    assert.equal(r.ok, false, title);
    assert.ok(r.reason.startsWith(why), `${title}: ${r.reason}`);
  }
});

test('listing filter: "120 HP" is not a condition', () => {
  assert.equal(classifyListing('Charizard 120 HP 4/102 Base Set Holo', charizard, 'holofoil').ok, true);
});

test('OCR features: Pokémon', () => {
  const f = extractFeatures([
    { text: 'BASIC', y: 0.03, h: 0.02 },
    { text: 'Pikachu', y: 0.05, h: 0.05 },
    { text: 'HP 60', y: 0.05, h: 0.04 },
    { text: 'Illus. Atsuko Nishida 058/102 ●', y: 0.95, h: 0.02 },
  ]);
  assert.equal(f.game, 'pokemon');
  assert.equal(f.name, 'Pikachu');
  assert.equal(f.number, '058');
  assert.equal(f.total, '102');
});

test('OCR features: Yu-Gi-Oh set code beats everything', () => {
  const f = extractFeatures([{ text: 'Blue-Eyes White Dragon', y: 0.05, h: 0.05 }, { text: 'LOB-EN001', y: 0.72, h: 0.02 }]);
  assert.equal(f.game, 'yugioh');
  assert.equal(f.setCode, 'LOB-EN001');
});

test('OCR features: Magic set line + collector number', () => {
  const f = extractFeatures([
    { text: 'Sheoldred, the Apocalypse', y: 0.04, h: 0.04 },
    { text: 'M 0107', y: 0.94, h: 0.015 },
    { text: 'DMU • EN', y: 0.96, h: 0.015 },
  ]);
  assert.equal(f.game, 'mtg');
  assert.equal(f.setCode, 'DMU');
  assert.equal(f.number, '0107');
});

test('valuation: rejects an outlier source and weights the rest', () => {
  const v = valuate([
    { source: 'tcgplayer', data: { market: 100, low: 70 } },
    { source: 'cardmarket', data: { trend: 90 } },
    { source: 'pricecharting', data: { ungraded: 400 } },
  ], 1.1, null);
  // 400 is > 2.5x the median (99), so it's dropped.
  assert.ok(v.raw > 99 && v.raw < 100.5, String(v.raw));
  assert.equal(v.raw_low, 70);
});

test('holding value uses grade, then condition', () => {
  const v = { raw: 100, g9: 300, psa10: 900, bgs10: 1200 };
  assert.equal(holdingValue({ grader: 'PSA', grade: '10' }, v).value, 900);
  assert.equal(holdingValue({ grader: 'BGS', grade: '10' }, v).value, 1200);
  assert.equal(holdingValue({ grader: 'CGC', grade: '9' }, v).value, 300);
  assert.equal(holdingValue({ condition: 'LP' }, v).value, 82);
  assert.equal(gradeKey('SGC', '9.5'), 'g95');
});

test('signal score is monotonic in discount', () => {
  const a = scoreSignal({ discount: 0.2, upside: 50, confidence: 0.8, kind: 'listing' });
  const b = scoreSignal({ discount: 0.4, upside: 50, confidence: 0.8, kind: 'listing' });
  assert.ok(b > a);
});

test('PriceCharting product names', () => {
  assert.deepEqual(parseProductName('Charizard [1st Edition] #4'), { base: 'Charizard', tags: ['1st Edition'], number: '4' });
  assert.deepEqual(parseProductName('Luka Doncic [Silver Prizm] #280'), { base: 'Luka Doncic', tags: ['Silver Prizm'], number: '280' });
  const m = mapRow({ id: '12', 'product-name': 'Pikachu #58', 'console-name': 'Pokemon Base Set', 'loose-price': '$7.50', 'graded-price': '$58.00', 'manual-only-price': '$420.00', 'sales-volume': '210' }, 'pokemon-cards');
  assert.equal(m.card.id, 'pc:12');
  assert.equal(m.card.setName, 'Base Set');
  assert.deepEqual([m.quote.data.ungraded, m.quote.data.g9, m.quote.data.psa10, m.quote.data.volume], [7.5, 58, 420, 210]);
});

test('Pokémon TCG API mapping', () => {
  const { card, quotes } = mapPokemon({
    id: 'base1-4', name: 'Charizard', number: '4', rarity: 'Rare Holo',
    set: { id: 'base1', name: 'Base', series: 'Base', printedTotal: 102, releaseDate: '1999/01/09' },
    images: { small: 'https://images.pokemontcg.io/base1/4.png', large: 'https://images.pokemontcg.io/base1/4_hires.png' },
    tcgplayer: { url: 'x', updatedAt: '2026/11/01', prices: { holofoil: { low: 300, mid: 420, high: 900, market: 410, directLow: null } } },
    cardmarket: { prices: { trendPrice: 350, averageSellPrice: 340, avg1: 360, avg7: 352, avg30: 340, lowPrice: 200 } },
  });
  assert.equal(card.id, 'pkm:base1-4');
  assert.equal(card.releaseDate, '1999-01-09');
  assert.equal(quotes.length, 2);
  assert.equal(quotes[1].variant, 'holofoil');
  assert.equal(quotes[1].currency, 'EUR');
});

test('Scryfall mapping (double-faced card images)', () => {
  const { card, quotes } = mapScryfall({ id: 'abc', name: 'Delver of Secrets // Insectile Aberration', set: 'isd', set_name: 'Innistrad', collector_number: '51', rarity: 'common', released_at: '2011-09-30',
    card_faces: [{ image_uris: { normal: 'https://cards.scryfall.io/n.jpg', large: 'https://cards.scryfall.io/l.jpg' } }], prices: { usd: '0.50', usd_foil: '12.00', eur: '0.30' } });
  assert.equal(card.image, 'https://cards.scryfall.io/n.jpg');
  assert.deepEqual(quotes.map((q) => `${q.variant}/${q.source}`), ['nonfoil/scryfall', 'nonfoil/cardmarket', 'foil/scryfall']);
});

test('YGOPRODeck mapping: one card per printing', () => {
  const out = mapYgo({ id: 89631139, name: 'Blue-Eyes White Dragon', card_images: [{ id: 89631139 }],
    card_sets: [{ set_name: 'LOB', set_code: 'LOB-EN001', set_rarity: 'Ultra Rare', set_rarity_code: '(UR)', set_price: '95.5' }, { set_name: 'SDK', set_code: 'SDK-001', set_rarity: 'Ultra Rare', set_rarity_code: '(UR)', set_price: '0' }],
    card_prices: [{ tcgplayer_price: '1.2' }] }, 2);
  assert.equal(out.length, 1);
  assert.equal(out[0].card.id, 'ygo:LOB-EN001:UR');
});

test('utils', () => {
  const rows = [...parseCSV('id,"product-name",price\n1,"Charizard, Holo",$1.00\n2,"Say ""hi""",3\n')];
  assert.equal(rows[0]['product-name'], 'Charizard, Holo');
  assert.equal(rows[1]['product-name'], 'Say "hi"');
  assert.equal(money('$1,234.56'), 1234.56);
  assert.ok(similarity('Charizard', 'Charizrd') > 0.85);
});
