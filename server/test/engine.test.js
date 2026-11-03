import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradeEV, ERA_RATES, eraOf } from '../src/engine/grading.js';
import { classifyListing, parseGrade } from '../src/engine/listings.js';
import { extractFeatures } from '../src/engine/identify.js';
import { valuate, holdingValue, gradeKey } from '../src/engine/valuation.js';
import { scoreSignal } from '../src/engine/signals.js';
import { parseProductName, mapRow } from '../src/providers/pricecharting.js';
import { mapProduct, mapPrice, prepareGroups, cleanSetName, seriesFor, variantKey } from '../src/providers/tcgcsv.js';
import { matchSets, quotesFromCard } from '../src/providers/tcgdex.js';
import { parseCSV, similarity, money } from '../src/lib/util.js';
import { byPrinting } from '../src/export.js';

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

test('Pokémon era buckets', () => {
  assert.equal(eraOf('1999-01-09'), 'wotc');
  assert.equal(eraOf('2005-02-14'), 'ex');
  assert.equal(eraOf('2014-05-07'), 'bwxy');
  assert.equal(eraOf('2019-08-23'), 'sm');
  assert.equal(eraOf('2023-09-22'), 'modern');
});

const charizard = { game: 'pokemon', name: 'Charizard', base_name: 'Charizard', number: '004', printed_total: '102', set_name: 'Base Set' };

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

test('OCR features: secret rares and black star promos', () => {
  assert.deepEqual([extractFeatures([{ text: 'TG05/TG30', y: 0.95 }]).number, extractFeatures([{ text: 'TG05/TG30', y: 0.95 }]).total], ['TG05', 'TG30']);
  assert.equal(extractFeatures([{ text: 'SWSH050', y: 0.95 }]).number, 'SWSH050');
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

// Shapes below are copied from live TCGCSV / TCGdex responses.
test('TCGCSV groups: set names and eras', () => {
  assert.equal(cleanSetName('SWSH07: Evolving Skies'), 'Evolving Skies');
  assert.equal(cleanSetName('SV: Scarlet & Violet 151'), 'Scarlet & Violet 151');
  assert.equal(cleanSetName('SM - Cosmic Eclipse'), 'Cosmic Eclipse');
  assert.equal(cleanSetName('ME06: Delta Reign'), 'Delta Reign');
  assert.equal(seriesFor('ME06: Delta Reign', '2026-11-06'), 'Mega Evolution');
  assert.equal(seriesFor('SV: Prismatic Evolutions', '2025-01-17'), 'Scarlet & Violet');
  assert.equal(seriesFor('Hidden Fates: Shiny Vault', '2019-08-23'), 'Sun & Moon');
  assert.equal(seriesFor('EX Team Rocket Returns', '2004-11-01'), 'EX');
  assert.equal(seriesFor('Team Rocket', '2000-04-24'), 'Wizards of the Coast');
  assert.equal(seriesFor('McDonald\'s Promos 2019', '2019-10-01'), 'Sun & Moon');
  // Placeholder dates shared by many groups are ignored.
  const gs = prepareGroups(Array.from({ length: 7 }, (_, i) => ({ groupId: i, name: `POP Series ${i}`, publishedOn: '2026-11-01T00:00:00' })));
  assert.equal(gs[0].released, null);
  assert.equal(gs[0].series, 'POP');
});

test('TCGCSV products and prices', () => {
  const group = prepareGroups([{ groupId: 23237, name: 'SV: Scarlet & Violet 151', abbreviation: 'MEW', publishedOn: '2023-09-22T00:00:00' }])[0];
  const card = mapProduct({ productId: 502552, name: 'Bulbasaur - 001/165', imageUrl: 'https://tcgplayer-cdn.tcgplayer.com/product/502552_200w.jpg', url: 'https://www.tcgplayer.com/product/502552',
    extendedData: [{ name: 'Number', value: '001/165' }, { name: 'Rarity', value: 'Common' }] }, group);
  assert.equal(card.id, 'tcg:502552');
  assert.equal(card.name, 'Bulbasaur');
  assert.deepEqual([card.number, card.printedTotal, card.setName, card.ext.series], ['001', '165', 'Scarlet & Violet 151', 'Scarlet & Violet']);
  assert.equal(card.imageLarge, 'https://tcgplayer-cdn.tcgplayer.com/product/502552_400w.jpg');
  const alt = mapProduct({ productId: 246688, name: 'Leafeon V (Alternate Full Art)', extendedData: [{ name: 'Number', value: '167/203' }] }, group);
  assert.equal(alt.name, 'Leafeon V (Alternate Full Art)');
  assert.equal(alt.ext.baseName, 'Leafeon V');
  assert.equal(mapProduct({ productId: 1, name: 'Evolving Skies Booster Box', extendedData: [] }, group), null);
  const q = mapPrice({ productId: 42346, lowPrice: 43.5, midPrice: 55.0, highPrice: 1499.99, marketPrice: 75.55, directLowPrice: null, subTypeName: 'Holofoil' });
  assert.deepEqual([q.cardId, q.variant, q.data.market, q.data.low], ['tcg:42346', 'holofoil', 75.55, 43.5]);
  assert.equal(variantKey('1st Edition Holofoil'), '1stEditionHolofoil');
  assert.equal(variantKey('Reverse Holofoil'), 'reverseHolofoil');
});

test('TCGdex: set matching and Cardmarket prices by TCGplayer product id', () => {
  const m = matchSets([{ id: '23237', name: 'Scarlet & Violet 151', total: '165' }, { id: '604', name: 'Base Set', total: '102' }],
    [{ id: 'sv03.5', name: '151', official: 165 }, { id: 'base1', name: 'Base Set', official: 102 }, { id: 'base4', name: 'Base Set 2', official: 130 }]);
  assert.equal(m.get('23237'), 'sv03.5');
  assert.equal(m.get('604'), 'base1');
  const card = { variants_detailed: [
    { type: 'holo', subtype: 'unlimited', thirdParty: { cardmarket: 273699, tcgplayer: 42382 }, pricing: { cardmarket: { avg: 458.1, low: 99, trend: 490.62, avg1: 470.5, avg7: 398.82, avg30: 460.58, 'trend-holo': 123.63 } } },
    { type: 'holo', subtype: 'shadowless', thirdParty: { tcgplayer: 106999 }, pricing: { cardmarket: { trend: 3843.13 } } },
  ] };
  const qs = quotesFromCard(card, 42382, ['holofoil']);
  assert.equal(qs.length, 1);
  assert.deepEqual([qs[0].variant, qs[0].data.trend, qs[0].data.avg7], ['holofoil', 490.62, 398.82]);
  assert.equal(quotesFromCard(card, 555, ['holofoil']).length, 0);
});

test('utils', () => {
  const rows = [...parseCSV('id,"product-name",price\n1,"Charizard, Holo",$1.00\n2,"Say ""hi""",3\n')];
  assert.equal(rows[0]['product-name'], 'Charizard, Holo');
  assert.equal(rows[1]['product-name'], 'Say "hi"');
  assert.equal(money('$1,234.56'), 1234.56);
  assert.ok(similarity('Charizard', 'Charizrd') > 0.85);
});

test('catalog lists the regular printing first, not the priciest', () => {
  const order = (vs) => vs.slice().sort(byPrinting).map((v) => v[0]);
  assert.deepEqual(order([['reverseHolofoil', 0.25], ['normal', 0.16]]), ['normal', 'reverseHolofoil']);
  assert.deepEqual(order([['reverseHolofoil', 0.4], ['holofoil', 0.24]]), ['holofoil', 'reverseHolofoil']);
  assert.deepEqual(order([['1stEditionHolofoil', 9000], ['unlimitedHolofoil', 400]]), ['unlimitedHolofoil', '1stEditionHolofoil']);
  assert.deepEqual(order([['1stEditionNormal', 30], ['normal', 2]]), ['normal', '1stEditionNormal']);
});
