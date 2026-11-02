// Sample data for trying the UI without network access or API keys.
// Enabled only with COMPS_DEMO=1. Card identities are real; every price,
// listing and history point is generated and the UI labels it "Sample data".

import { upsertCards, upsertQuotes } from './store.js';
import { upsertHolding } from './collection.js';
import { day } from './lib/util.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CDN = 'https://tcgplayer-cdn.tcgplayer.com/product';

// [groupId, set name, code, series, released]
const SETS = [
  [604, 'Base Set', 'BS', 'Wizards of the Coast', '1999-01-09'],
  [1396, 'Neo Genesis', 'N1', 'Neo', '2000-12-16'],
  [1404, 'EX Deoxys', 'DX', 'EX', '2005-02-14'],
  [2594, 'Hidden Fates: Shiny Vault', 'HIF:SV', 'Sun & Moon', '2019-08-23'],
  [2781, 'Shining Fates: Shiny Vault', 'SHFSV', 'Sword & Shield', '2021-02-19'],
  [2848, 'Evolving Skies', 'SWSH07', 'Sword & Shield', '2021-08-27'],
  [3118, 'Lost Origin', 'SWSH11', 'Sword & Shield', '2022-09-09'],
  [3170, 'Silver Tempest', 'SWSH12', 'Sword & Shield', '2022-11-11'],
  [17689, 'Crown Zenith: Galarian Gallery', 'CRZ:GG', 'Sword & Shield', '2023-01-20'],
  [23228, 'Obsidian Flames', 'OBF', 'Scarlet & Violet', '2023-08-11'],
  [23237, 'Scarlet & Violet 151', 'MEW', 'Scarlet & Violet', '2023-09-22'],
  [23353, 'Paldean Fates', 'PAF', 'Scarlet & Violet', '2024-01-26'],
  [23651, 'Surging Sparks', 'SSP', 'Scarlet & Violet', '2024-11-08'],
  [23821, 'Prismatic Evolutions', 'PRE', 'Scarlet & Violet', '2025-01-17'],
];

// [productId, name, groupId, number, total, rarity, variant, raw, g9, g10]
const POKEMON = [
  [42382, 'Charizard', 604, '004', '102', 'Holo Rare', 'holofoil', 412, 1350, 8900],
  [900002, 'Blastoise', 604, '002', '102', 'Holo Rare', 'holofoil', 138, 520, 3400],
  [900003, 'Venusaur', 604, '015', '102', 'Holo Rare', 'holofoil', 104, 390, 2650],
  [42347, 'Mewtwo', 604, '010', '102', 'Holo Rare', 'holofoil', 46, 210, 1400],
  [900005, 'Pikachu', 604, '058', '102', 'Common', 'normal', 7.5, 58, 420],
  [900006, 'Lugia', 1396, '9', '111', 'Holo Rare', 'holofoil', 310, 1150, 9800],
  [900007, 'Rayquaza Star', 1404, '107', '107', 'Rare Holo Star', 'holofoil', 980, 2400, 7900],
  [900008, 'Charizard GX', 2594, 'SV49', 'SV94', 'Shiny Holo Rare', 'holofoil', 96, 135, 410],
  [900009, 'Charizard VMAX', 2781, 'SV107', 'SV122', 'Shiny Holo Rare', 'holofoil', 118, 150, 360],
  [900010, 'Umbreon VMAX (Alternate Art Secret)', 2848, '215', '203', 'Secret Rare', 'holofoil', 1460, 1580, 3250],
  [900011, 'Rayquaza VMAX (Alternate Art Secret)', 2848, '218', '203', 'Secret Rare', 'holofoil', 612, 690, 1480],
  [246704, 'Sylveon VMAX (Alternate Art Secret)', 2848, '212', '203', 'Secret Rare', 'holofoil', 318, 350, 760],
  [900013, 'Glaceon VMAX (Alternate Art Secret)', 2848, '209', '203', 'Secret Rare', 'holofoil', 342, 380, 830],
  [246719, 'Umbreon V (Alternate Full Art)', 2848, '189', '203', 'Ultra Rare', 'holofoil', 298, 330, 640],
  [900015, 'Giratina V (Alternate Full Art)', 3118, '186', '196', 'Ultra Rare', 'holofoil', 470, 505, 1120],
  [900016, 'Lugia V (Alternate Full Art)', 3170, '186', '195', 'Ultra Rare', 'holofoil', 255, 290, 705],
  [900017, 'Giratina VSTAR', 17689, 'GG69', 'GG70', 'Secret Rare', 'holofoil', 168, 190, 470],
  [900018, 'Charizard ex', 23228, '223', '197', 'Special Illustration Rare', 'holofoil', 86, 98, 260],
  [900019, 'Charizard ex', 23237, '199', '165', 'Special Illustration Rare', 'holofoil', 228, 255, 610],
  [900020, 'Venusaur ex', 23237, '198', '165', 'Special Illustration Rare', 'holofoil', 62, 70, 175],
  [900021, 'Blastoise ex', 23237, '200', '165', 'Special Illustration Rare', 'holofoil', 71, 80, 205],
  [900022, "Erika's Invitation", 23237, '203', '165', 'Special Illustration Rare', 'holofoil', 82, 92, 255],
  [513721, 'Pikachu', 23237, '173', '165', 'Illustration Rare', 'holofoil', 14, 22, 85],
  [900024, 'Charizard ex', 23353, '234', '091', 'Special Illustration Rare', 'holofoil', 118, 132, 320],
  [900025, 'Pikachu ex', 23651, '238', '191', 'Special Illustration Rare', 'holofoil', 410, 440, 920],
  [900026, 'Umbreon ex', 23821, '161', '131', 'Special Illustration Rare', 'holofoil', 1180, 1260, 2600],
  [900027, 'Eevee ex', 23821, '167', '131', 'Special Illustration Rare', 'holofoil', 92, 104, 260],
];

export function seedDemo(db, settings) {
  const r = rng(20261102);
  const jitter = (v, pct) => Math.round(v * (1 + (r() * 2 - 1) * pct) * 100) / 100;
  const cards = [];
  const quotes = [];
  const links = [];
  const histories = []; // [cardId, variant, endRaw, endG9, endG10, drift]
  const fx = 1.08;
  const now = Date.now();

  const setById = new Map(SETS.map(([gid, name, code, series, released]) => [gid, { gid, name, code, series, released }]));
  POKEMON.forEach(([pid, name, gid, number, total, rarity, variant, raw, g9, g10], i) => {
    const set = setById.get(gid);
    const cid = `tcg:${pid}`;
    const baseName = name.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
    cards.push({ id: cid, game: 'pokemon', name, setName: set.name, setCode: set.code, number, printedTotal: total, rarity, releaseDate: set.released,
      image: `${CDN}/${pid}_200w.jpg`, imageLarge: `${CDN}/${pid}_400w.jpg`,
      ext: { groupId: gid, series: set.series, baseName, productId: pid, tcgplayer: `https://www.tcgplayer.com/product/${pid}` } });
    // Some cards get a lowball ask, some a hot EU market, some a lagging US price.
    const lowAsk = i % 5 === 1 ? 0.58 + r() * 0.1 : 0.82 + r() * 0.12;
    quotes.push({ cardId: cid, variant, source: 'tcgplayer', data: { market: raw, low: Math.round(raw * lowAsk * 100) / 100, mid: jitter(raw * 1.08, 0.03), high: jitter(raw * 2.2, 0.2) } });
    if (variant === 'holofoil' && rarity === 'Holo Rare') {
      quotes.push({ cardId: cid, variant: 'reverseHolofoil', source: 'tcgplayer', data: { market: jitter(raw * 0.4, 0.1), low: jitter(raw * 0.3, 0.1) } });
    }
    const euRatio = i % 7 === 3 ? 0.55 : i % 6 === 2 ? 1.35 : 0.92 + r() * 0.12;
    const trend = Math.round((raw * euRatio / fx) * 100) / 100;
    const accel = i % 6 === 2 ? 1.32 : 0.95 + r() * 0.1;
    if (raw >= 15) quotes.push({ cardId: cid, variant, source: 'cardmarket', currency: 'EUR', data: { trend, avgSell: jitter(trend, 0.04), low: jitter(trend * 0.7, 0.05), avg30: Math.round((trend / accel) * 100) / 100, avg7: trend, avg1: jitter(trend * 1.02, 0.01) } });
    const pcId = `pc:demo-${i}`;
    const vintage = set.released < '2004';
    cards.push({ id: pcId, game: 'pokemon', name: baseName, setName: set.name, setCode: `Pokemon ${set.name}`, number, releaseDate: set.released, ext: { category: 'pokemon-cards' } });
    quotes.push({ cardId: pcId, variant: 'default', source: 'pricecharting', data: {
      // Vintage raw copies are rarely mint, so mid grades still beat raw; modern 7s/8s sell under raw.
      ungraded: jitter(raw, 0.05), g7: jitter(vintage ? Math.max(raw * 1.08, g9 * 0.3) : raw * 0.72, 0.05),
      g8: jitter(vintage ? Math.max(raw * 1.3, g9 * 0.5) : raw * 0.9, 0.05), g9, g95: jitter(g9 * 1.35, 0.05), psa10: g10,
      bgs10: jitter(g10 * 1.25, 0.1), cgc10: jitter(g10 * 0.62, 0.08), sgc10: jitter(g10 * 0.7, 0.08), volume: Math.round(8 + r() * 200) } });
    links.push([cid, variant, pcId]);
    const drift = i % 8 === 0 ? 0.18 : i % 9 === 4 ? -0.3 : (r() - 0.45) * 0.25;
    histories.push([cid, variant, raw, g9, g10, drift]);
  });

  upsertCards(db, cards);
  upsertQuotes(db, quotes);
  db.tx(() => {
    for (const st of SETS) {
      const n = POKEMON.filter((c) => c[2] === st[0]).length;
      db.run('INSERT OR REPLACE INTO sets (id, name, code, series, released, supplemental, modified, cards) VALUES (?,?,?,?,?,?,?,?)', String(st[0]), st[1], st[2], st[3], st[4], 0, null, n);
    }
  });

  db.tx(() => {
    for (const [cid, variant, pc] of links) db.run('INSERT OR REPLACE INTO links (card_id, variant, pc_id, confidence) VALUES (?,?,?,?)', cid, variant, pc, 0.95);

    // 180 days of history: a random walk that ends at today's value.
    const ins = 'INSERT OR REPLACE INTO history (card_id, variant, day, raw, g9, psa10) VALUES (?,?,?,?,?,?)';
    for (const [cid, variant, raw, g9, g10, drift] of histories) {
      const days = 180;
      let x = 1;
      const path = [];
      for (let d = 0; d < days; d++) {
        path.push(x);
        x *= 1 + (r() - 0.5) * 0.035;
      }
      const end = path[path.length - 1];
      for (let d = 0; d < days; d++) {
        // Blend the noise with a linear drift so the series has shape.
        const t = d / (days - 1);
        const shape = (path[d] / end) * (1 - drift * (1 - t));
        const dd = day(now - (days - d) * 86_400_000);
        db.run(ins, cid, variant, dd, Math.round(raw * shape * 100) / 100, g9 ? Math.round(g9 * (0.5 + shape / 2) * 100) / 100 : null, g10 ? Math.round(g10 * (0.4 + shape * 0.6) * 100) / 100 : null);
      }
    }

    // eBay-style listings, a few clearly underpriced.
    const L = [
      ['tcg:42382', 'holofoil', 'Charizard 4/102 Base Set Unlimited Holo Rare WOTC 1999 NM', 305, 5, null, null],
      ['tcg:42382', 'holofoil', 'PSA 9 Charizard 4/102 Base Set Holo Unlimited Pokemon 1999', 1080, 0, 'PSA', '9'],
      ['tcg:900005', 'normal', 'Pikachu 58/102 Base Set Yellow Cheeks Pokemon Card NM', 3.99, 1.25, null, null],
      ['tcg:900010', 'holofoil', 'Umbreon VMAX 215/203 Evolving Skies Alt Art Secret Rare Pokemon NM/M', 1095, 0, null, null],
      ['tcg:900010', 'holofoil', 'PSA 10 GEM MINT Umbreon VMAX 215/203 Evolving Skies Alternate Art', 2690, 0, 'PSA', '10'],
      ['tcg:900019', 'holofoil', 'Charizard ex 199/165 SIR Pokemon 151 Special Illustration Rare Pack Fresh', 159, 4.5, null, null],
      ['tcg:900006', 'holofoil', 'Lugia 9/111 Neo Genesis Unlimited Holo Rare Pokemon Card', 228, 5, null, null],
      ['tcg:900015', 'holofoil', 'Giratina V 186/196 Lost Origin Alt Art Pokemon Card Near Mint', 362, 0, null, null],
      ['tcg:900025', 'holofoil', 'CGC 10 Pristine Pikachu ex 238/191 Surging Sparks SIR', 610, 0, 'CGC', '10'],
      ['tcg:900002', 'holofoil', 'Blastoise 2/102 Base Set Holo Rare Unlimited 1999 WOTC', 99, 4.99, null, null],
      ['tcg:900016', 'holofoil', 'Lugia V Alternate Art 186/195 Silver Tempest Pokemon Card', 192, 1, null, null],
    ];
    L.forEach(([cid, variant, title, price, ship, grader, grade], i) => {
      db.run(`INSERT OR REPLACE INTO listings (item_id, card_id, variant, title, price, shipping, currency, buying, grader, grade, url, image, seller, feedback, fetched_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, `demo-${i}`, cid, variant, title, price, ship, 'USD', 'FIXED_PRICE', grader, grade,
        `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(title)}`, null, `seller_${(i * 7919) % 997}`, 99.2 + (i % 8) / 10, now);
    });

    // A starter collection.
    const H = [
      ['tcg:42382', 'holofoil', 'PSA', '9', 1, 980, 400],
      ['tcg:900010', 'holofoil', null, null, 1, 620, 380],
      ['tcg:900011', 'holofoil', 'PSA', '10', 1, 1100, 300],
      ['tcg:900019', 'holofoil', null, null, 2, 140, 200],
      ['tcg:900026', 'holofoil', null, null, 1, 1050, 90],
      ['tcg:900025', 'holofoil', 'PSA', '10', 1, 640, 120],
      ['tcg:900005', 'normal', null, null, 4, 3, 500],
      ['tcg:900008', 'holofoil', 'PSA', '10', 1, 380, 600],
      ['tcg:900015', 'holofoil', null, null, 1, 290, 260],
      ['tcg:246719', 'holofoil', null, null, 2, 210, 330],
    ];
    H.forEach(([cid, variant, grader, grade, qty, cost, ageDays], i) => {
      const c = db.get('SELECT * FROM cards WHERE id = ?', cid);
      upsertHolding(db, {
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, cardId: cid, game: c.game, name: c.name, setName: c.set_name, number: c.number, image: c.image,
        variant, grader, grade, condition: 'NM', quantity: qty, costBasis: cost, acquiredAt: day(now - ageDays * 86_400_000),
        createdAt: now - ageDays * 86_400_000, updatedAt: now - i * 1000,
      }, { force: true });
    });

    for (const [cid, variant, target] of [['tcg:900026', 'holofoil', 1000], ['tcg:900006', 'holofoil', 260], ['tcg:900007', 'holofoil', null], ['tcg:900027', 'holofoil', 80]]) {
      db.run('INSERT OR REPLACE INTO watchlist (card_id, variant, target, created_at) VALUES (?,?,?,?)', cid, variant, target, now);
    }
  });

  settings.set({ _demo: '1', fxEurUsd: fx, _fxSource: 'sample' });
}
