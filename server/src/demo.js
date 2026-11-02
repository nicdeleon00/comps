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

const PKM = 'https://images.pokemontcg.io';
const YGO = 'https://images.ygoprodeck.com/images/cards_small';
const YGOL = 'https://images.ygoprodeck.com/images/cards';

// [id, name, set, setCode, number, total, rarity, date, variant, raw, g9, g10]
const POKEMON = [
  ['base1-4', 'Charizard', 'Base', 'base1', '4', '102', 'Rare Holo', '1999-01-09', 'holofoil', 412, 1350, 8900],
  ['base1-2', 'Blastoise', 'Base', 'base1', '2', '102', 'Rare Holo', '1999-01-09', 'holofoil', 138, 520, 3400],
  ['base1-15', 'Venusaur', 'Base', 'base1', '15', '102', 'Rare Holo', '1999-01-09', 'holofoil', 104, 390, 2650],
  ['base1-10', 'Mewtwo', 'Base', 'base1', '10', '102', 'Rare Holo', '1999-01-09', 'holofoil', 46, 210, 1400],
  ['base1-58', 'Pikachu', 'Base', 'base1', '58', '102', 'Common', '1999-01-09', 'normal', 7.5, 58, 420],
  ['neo1-9', 'Lugia', 'Neo Genesis', 'neo1', '9', '111', 'Rare Holo', '2000-12-16', 'holofoil', 310, 1150, 9800],
  ['ex8-107', 'Rayquaza ☆', 'Deoxys', 'ex8', '107', '107', 'Rare Holo Star', '2005-02-14', 'holofoil', 980, 2400, 7900],
  ['sma-SV49', 'Charizard-GX', 'Hidden Fates Shiny Vault', 'sma', 'SV49', '94', 'Rare Shiny GX', '2019-08-23', 'holofoil', 96, 135, 410],
  ['swsh45sv-SV107', 'Charizard VMAX', 'Shining Fates Shiny Vault', 'swsh45sv', 'SV107', '122', 'Rare Shiny', '2021-02-19', 'holofoil', 118, 150, 360],
  ['swsh7-215', 'Umbreon VMAX', 'Evolving Skies', 'swsh7', '215', '203', 'Rare Secret', '2021-08-27', 'holofoil', 1460, 1580, 3250],
  ['swsh7-218', 'Rayquaza VMAX', 'Evolving Skies', 'swsh7', '218', '203', 'Rare Secret', '2021-08-27', 'holofoil', 612, 690, 1480],
  ['swsh7-212', 'Sylveon VMAX', 'Evolving Skies', 'swsh7', '212', '203', 'Rare Secret', '2021-08-27', 'holofoil', 318, 350, 760],
  ['swsh7-209', 'Glaceon VMAX', 'Evolving Skies', 'swsh7', '209', '203', 'Rare Secret', '2021-08-27', 'holofoil', 342, 380, 830],
  ['swsh11-186', 'Giratina V', 'Lost Origin', 'swsh11', '186', '196', 'Rare Ultra', '2022-09-09', 'holofoil', 470, 505, 1120],
  ['swsh12-186', 'Lugia V', 'Silver Tempest', 'swsh12', '186', '195', 'Rare Ultra', '2022-11-11', 'holofoil', 255, 290, 705],
  ['swsh12pt5gg-GG69', 'Giratina VSTAR', 'Crown Zenith Galarian Gallery', 'swsh12pt5gg', 'GG69', '70', 'Rare Secret', '2023-01-20', 'holofoil', 168, 190, 470],
  ['sv3-223', 'Charizard ex', 'Obsidian Flames', 'sv3', '223', '197', 'Special Illustration Rare', '2023-08-11', 'holofoil', 86, 98, 260],
  ['sv3pt5-199', 'Charizard ex', '151', 'sv3pt5', '199', '165', 'Special Illustration Rare', '2023-09-22', 'holofoil', 228, 255, 610],
  ['sv3pt5-198', 'Venusaur ex', '151', 'sv3pt5', '198', '165', 'Special Illustration Rare', '2023-09-22', 'holofoil', 62, 70, 175],
  ['sv3pt5-200', 'Blastoise ex', '151', 'sv3pt5', '200', '165', 'Special Illustration Rare', '2023-09-22', 'holofoil', 71, 80, 205],
  ['sv3pt5-203', "Erika's Invitation", '151', 'sv3pt5', '203', '165', 'Special Illustration Rare', '2023-09-22', 'holofoil', 82, 92, 255],
  ['sv4pt5-234', 'Charizard ex', 'Paldean Fates', 'sv4pt5', '234', '91', 'Special Illustration Rare', '2024-01-26', 'holofoil', 118, 132, 320],
  ['sv8-238', 'Pikachu ex', 'Surging Sparks', 'sv8', '238', '191', 'Special Illustration Rare', '2024-11-08', 'holofoil', 410, 440, 920],
  ['sv8pt5-161', 'Umbreon ex', 'Prismatic Evolutions', 'sv8pt5', '161', '131', 'Special Illustration Rare', '2025-01-17', 'holofoil', 1180, 1260, 2600],
];

// [id, name, set, setCode, number, rarity, date, raw, foilMult]
const MTG = [
  ['demo-sheoldred', 'Sheoldred, the Apocalypse', 'Dominaria United', 'dmu', '107', 'Mythic', '2022-09-09', 72, 1.3],
  ['demo-ragavan', 'Ragavan, Nimble Pilferer', 'Modern Horizons 2', 'mh2', '138', 'Mythic', '2021-06-18', 46, 1.5],
  ['demo-bowmasters', 'Orcish Bowmasters', 'The Lord of the Rings: Tales of Middle-earth', 'ltr', '103', 'Rare', '2023-06-23', 31, 1.4],
  ['demo-onering', 'The One Ring', 'The Lord of the Rings: Tales of Middle-earth', 'ltr', '246', 'Mythic', '2023-06-23', 58, 1.6],
  ['demo-jace', 'Jace, the Mind Sculptor', 'Worldwake', 'wwk', '31', 'Mythic', '2010-02-05', 39, 3.2],
  ['demo-cradle', "Gaea's Cradle", "Urza's Saga", 'usg', '321', 'Rare', '1998-10-12', 780, null],
];

// [konamiId, name, set, setCode, rarityCode, rarity, date, raw, g9, g10]
const YUGIOH = [
  [89631139, 'Blue-Eyes White Dragon', 'Legend of Blue Eyes White Dragon', 'LOB-EN001', 'UR', 'Ultra Rare', '2002-03-08', 92, 360, 1900],
  [46986414, 'Dark Magician', 'Legend of Blue Eyes White Dragon', 'LOB-EN005', 'UR', 'Ultra Rare', '2002-03-08', 44, 190, 980],
  [74677422, 'Red-Eyes Black Dragon', 'Legend of Blue Eyes White Dragon', 'LOB-EN070', 'UR', 'Ultra Rare', '2002-03-08', 38, 170, 860],
  [33396948, 'Exodia the Forbidden One', 'Legend of Blue Eyes White Dragon', 'LOB-EN124', 'UR', 'Ultra Rare', '2002-03-08', 58, 240, 1350],
  [14558127, 'Ash Blossom & Joyous Spring', 'Maximum Crisis', 'MACR-EN036', 'ScR', 'Secret Rare', '2017-05-05', 16, 40, 115],
];

// [id, name, set, number, date, raw, g8, g9, g10, volume]
const SPORTS = [
  ['demo-luka', 'Luka Doncic', 'Basketball Cards 2018 Panini Prizm', '280', '2018-11-01', 215, 240, 340, 1080, 180],
  ['demo-lebron', 'LeBron James', 'Basketball Cards 2003 Topps Chrome', '111', '2003-11-01', 880, 1250, 2150, 8800, 40],
  ['demo-trout', 'Mike Trout', 'Baseball Cards 2011 Topps Update', 'US175', '2011-10-01', 480, 560, 880, 3450, 120],
  ['demo-mahomes', 'Patrick Mahomes', 'Football Cards 2017 Panini Prizm', '269', '2017-12-01', 290, 330, 510, 1580, 90],
  ['demo-ohtani', 'Shohei Ohtani', 'Baseball Cards 2018 Topps Update', 'US1', '2018-10-01', 58, 70, 108, 375, 260],
  ['demo-herbert', 'Justin Herbert', 'Football Cards 2020 Panini Prizm', '325', '2020-12-01', 38, 45, 62, 178, 140],
  ['demo-wemby', 'Victor Wembanyama', 'Basketball Cards 2023 Panini Prizm', '136', '2023-12-01', 64, 75, 98, 290, 310],
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

  POKEMON.forEach(([id, name, set, setCode, number, total, rarity, date, variant, raw, g9, g10], i) => {
    const cid = `pkm:${id}`;
    cards.push({ id: cid, game: 'pokemon', name, setName: set, setCode, number, printedTotal: total, rarity, releaseDate: date,
      image: `${PKM}/${setCode}/${number}.png`, imageLarge: `${PKM}/${setCode}/${number}_hires.png`, ext: { tcgplayer: null } });
    // Some cards get a lowball ask, some a hot EU market, some a lagging US price.
    const lowAsk = i % 5 === 1 ? 0.58 + r() * 0.1 : 0.82 + r() * 0.12;
    quotes.push({ cardId: cid, variant, source: 'tcgplayer', data: { market: raw, low: Math.round(raw * lowAsk * 100) / 100, mid: jitter(raw * 1.08, 0.03), high: jitter(raw * 2.2, 0.2) } });
    const euRatio = i % 7 === 3 ? 0.55 : i % 6 === 2 ? 1.35 : 0.92 + r() * 0.12;
    const trend = Math.round((raw * euRatio / fx) * 100) / 100;
    const accel = i % 6 === 2 ? 1.32 : 0.95 + r() * 0.1;
    quotes.push({ cardId: cid, variant, source: 'cardmarket', currency: 'EUR', data: { trend, avgSell: jitter(trend, 0.04), low: jitter(trend * 0.7, 0.05), avg30: Math.round((trend / accel) * 100) / 100, avg7: trend, avg1: jitter(trend * 1.02, 0.01) } });
    const pcId = `pc:demo-pkm-${i}`;
    cards.push({ id: pcId, game: 'pokemon', name, setName: set, setCode: `Pokemon ${set}`, number, releaseDate: date, ext: { category: 'pokemon-cards' } });
    quotes.push({ cardId: pcId, variant: 'default', source: 'pricecharting', data: {
      // Vintage raw copies are rarely mint, so mid grades still beat raw; modern 7s/8s sell under raw.
      ungraded: jitter(raw, 0.05), g7: jitter(date < '2003' ? Math.max(raw * 1.08, g9 * 0.3) : raw * 0.72, 0.05),
      g8: jitter(date < '2003' ? Math.max(raw * 1.3, g9 * 0.5) : raw * 0.9, 0.05), g9, g95: jitter(g9 * 1.35, 0.05), psa10: g10,
      bgs10: jitter(g10 * 1.25, 0.1), cgc10: jitter(g10 * 0.62, 0.08), sgc10: jitter(g10 * 0.7, 0.08), volume: Math.round(8 + r() * 200) } });
    links.push([cid, variant, pcId]);
    const drift = i % 8 === 0 ? 0.18 : i % 9 === 4 ? -0.3 : (r() - 0.45) * 0.25;
    histories.push([cid, variant, raw, g9, g10, drift]);
  });

  MTG.forEach(([id, name, set, setCode, number, rarity, date, raw, foilMult], i) => {
    const cid = `mtg:${id}`;
    cards.push({ id: cid, game: 'mtg', name, setName: set, setCode, number, rarity, releaseDate: date, ext: {} });
    quotes.push({ cardId: cid, variant: 'nonfoil', source: 'scryfall', data: { market: raw } });
    quotes.push({ cardId: cid, variant: 'nonfoil', source: 'cardmarket', currency: 'EUR', data: { trend: Math.round((raw * (i === 2 ? 0.58 : 0.9 + r() * 0.15) / fx) * 100) / 100 } });
    if (foilMult) {
      quotes.push({ cardId: cid, variant: 'foil', source: 'scryfall', data: { market: Math.round(raw * foilMult * 100) / 100 } });
    }
    histories.push([cid, 'nonfoil', raw, null, null, (r() - 0.5) * 0.3]);
  });

  YUGIOH.forEach(([kid, name, set, code, rc, rarity, date, raw, g9, g10], i) => {
    const cid = `ygo:${code}:${rc}`;
    cards.push({ id: cid, game: 'yugioh', name, setName: set, setCode: code, number: code, rarity, releaseDate: date,
      image: `${YGO}/${kid}.jpg`, imageLarge: `${YGOL}/${kid}.jpg`, ext: { konamiId: kid } });
    quotes.push({ cardId: cid, variant: 'default', source: 'ygoprodeck', data: { market: raw } });
    const pcId = `pc:demo-ygo-${i}`;
    cards.push({ id: pcId, game: 'yugioh', name, setName: set, setCode: `YuGiOh ${set}`, number: code, releaseDate: date, ext: { category: 'yugioh-cards' } });
    quotes.push({ cardId: pcId, variant: 'default', source: 'pricecharting', data: { ungraded: jitter(raw, 0.06), g8: jitter(g9 * 0.5, 0.05), g9, g95: jitter(g9 * 1.4, 0.05), psa10: g10, volume: Math.round(10 + r() * 60) } });
    links.push([cid, 'default', pcId]);
    histories.push([cid, 'default', raw, g9, g10, (r() - 0.5) * 0.2]);
  });

  SPORTS.forEach(([id, name, set, number, date, raw, g8, g9, g10, volume]) => {
    const cid = `pc:${id}`;
    cards.push({ id: cid, game: 'sports', name, setName: set.replace(/^(Basketball|Baseball|Football) Cards /, ''), setCode: set, number, releaseDate: date, ext: { category: set.split(' ')[0].toLowerCase() + '-cards' } });
    quotes.push({ cardId: cid, variant: 'default', source: 'pricecharting', data: { ungraded: raw, g7: jitter(raw * 1.02, 0.03), g8, g9, g95: jitter(g9 * 1.3, 0.05), psa10: g10, bgs10: jitter(g10 * 1.4, 0.1), sgc10: jitter(g10 * 0.65, 0.05), volume } });
    histories.push([cid, 'default', raw, g9, g10, (r() - 0.4) * 0.3]);
  });

  upsertCards(db, cards);
  upsertQuotes(db, quotes);

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
      ['pkm:base1-4', 'holofoil', 'Charizard 4/102 Base Set Unlimited Holo Rare WOTC 1999 NM', 305, 5, null, null],
      ['pkm:base1-4', 'holofoil', 'PSA 9 Charizard 4/102 Base Set Holo Unlimited Pokemon 1999', 1080, 0, 'PSA', '9'],
      ['pkm:base1-58', 'normal', 'Pikachu 58/102 Base Set Yellow Cheeks Pokemon Card NM', 3.99, 1.25, null, null],
      ['pkm:swsh7-215', 'holofoil', 'Umbreon VMAX 215/203 Evolving Skies Alt Art Secret Rare Pokemon NM/M', 1095, 0, null, null],
      ['pkm:swsh7-215', 'holofoil', 'PSA 10 GEM MINT Umbreon VMAX 215/203 Evolving Skies Alternate Art', 2690, 0, 'PSA', '10'],
      ['pkm:sv3pt5-199', 'holofoil', 'Charizard ex 199/165 SIR Pokemon 151 Special Illustration Rare Pack Fresh', 159, 4.5, null, null],
      ['pkm:neo1-9', 'holofoil', 'Lugia 9/111 Neo Genesis Unlimited Holo Rare Pokemon Card', 228, 5, null, null],
      ['pkm:swsh11-186', 'holofoil', 'Giratina V 186/196 Lost Origin Alt Art Pokemon Card Near Mint', 362, 0, null, null],
      ['pkm:sv8-238', 'holofoil', 'CGC 10 Pristine Pikachu ex 238/191 Surging Sparks SIR', 610, 0, 'CGC', '10'],
      ['pkm:base1-2', 'holofoil', 'Blastoise 2/102 Base Set Holo Rare Unlimited 1999 WOTC', 99, 4.99, null, null],
      ['pkm:swsh12-186', 'holofoil', 'Lugia V Alternate Art 186/195 Silver Tempest Pokemon Card', 192, 1, null, null],
      ['ygo:LOB-EN001:UR', 'default', 'Blue-Eyes White Dragon LOB-EN001 Ultra Rare Unlimited Yugioh NM', 64, 4, null, null],
      ['mtg:demo-sheoldred', 'nonfoil', 'Sheoldred, the Apocalypse Dominaria United DMU Mythic NM MTG', 52, 1, null, null],
    ];
    L.forEach(([cid, variant, title, price, ship, grader, grade], i) => {
      db.run(`INSERT OR REPLACE INTO listings (item_id, card_id, variant, title, price, shipping, currency, buying, grader, grade, url, image, seller, feedback, fetched_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, `demo-${i}`, cid, variant, title, price, ship, 'USD', 'FIXED_PRICE', grader, grade,
        `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(title)}`, null, `seller_${(i * 7919) % 997}`, 99.2 + (i % 8) / 10, now);
    });

    // A starter collection.
    const H = [
      ['pkm:base1-4', 'holofoil', 'PSA', '9', 1, 980, 400],
      ['pkm:swsh7-215', 'holofoil', null, null, 1, 620, 380],
      ['pkm:swsh7-218', 'holofoil', 'PSA', '10', 1, 1100, 300],
      ['pkm:sv3pt5-199', 'holofoil', null, null, 2, 140, 200],
      ['pkm:sv8pt5-161', 'holofoil', null, null, 1, 1050, 90],
      ['pkm:sv8-238', 'holofoil', 'PSA', '10', 1, 640, 120],
      ['pkm:base1-58', 'normal', null, null, 4, 3, 500],
      ['pkm:sma-SV49', 'holofoil', 'PSA', '10', 1, 380, 600],
      ['pkm:swsh11-186', 'holofoil', null, null, 1, 290, 260],
      ['ygo:LOB-EN001:UR', 'default', null, null, 1, 70, 700],
      ['mtg:demo-sheoldred', 'nonfoil', null, null, 4, 60, 410],
      ['pc:demo-luka', 'default', 'PSA', '9', 1, 300, 520],
      ['pc:demo-ohtani', 'default', null, null, 2, 40, 330],
    ];
    H.forEach(([cid, variant, grader, grade, qty, cost, ageDays], i) => {
      const c = db.get('SELECT * FROM cards WHERE id = ?', cid);
      upsertHolding(db, {
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, cardId: cid, game: c.game, name: c.name, setName: c.set_name, number: c.number, image: c.image,
        variant, grader, grade, condition: 'NM', quantity: qty, costBasis: cost, acquiredAt: day(now - ageDays * 86_400_000),
        createdAt: now - ageDays * 86_400_000, updatedAt: now - i * 1000,
      }, { force: true });
    });

    for (const [cid, variant, target] of [['pkm:sv8pt5-161', 'holofoil', 1000], ['pkm:neo1-9', 'holofoil', 260], ['pkm:ex8-107', 'holofoil', null], ['pc:demo-wemby', 'default', 50]]) {
      db.run('INSERT OR REPLACE INTO watchlist (card_id, variant, target, created_at) VALUES (?,?,?,?)', cid, variant, target, now);
    }
  });

  settings.set({ _demo: '1', fxEurUsd: fx, _fxSource: 'sample' });
}
