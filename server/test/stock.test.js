import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// A stand-in for Best Buy's API, in the shapes its documentation gives.
const KEY = 'test-key-123';
let inStock = { 6606082: [{ storeID: 176, name: 'Main Street', address: '100 Main St', city: 'Springfield', state: 'TX', postalCode: '00001', lowStock: true, distance: 5.2 }, { storeID: 999, name: 'Far Away', city: 'Austin', state: 'TX', lowStock: false, distance: 180 }], 6600001: [] };
let down = false;
const calls = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  calls.push(decodeURIComponent(url.pathname));
  const send = (body, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
  if (down) return send({ error: 'down' }, 403);
  if (url.searchParams.get('apiKey') !== KEY) return send({ errorCode: '403', errorMessage: `The provided API Key ${url.searchParams.get('apiKey')} is invalid` }, 403);
  const path = decodeURIComponent(url.pathname);
  if (path.startsWith('/products(')) return send({ totalPages: 1, products: [
    { sku: 6606082, name: 'Pokémon - Trading Card Game: Mega Evolution - Delta Reign Booster Bundle', salePrice: 26.94, image: 'https://img/6606082.jpg', url: 'https://www.bestbuy.com/site/6606082.p', inStoreAvailability: true },
    { sku: 6600001, name: 'Pokémon - Trading Card Game: 30th Celebration Mini Tin', salePrice: 9.99, inStoreAvailability: true },
    { sku: 6600002, name: 'Pokémon TCG: Online-only Box', salePrice: 49.99, inStoreAvailability: false },
    { sku: 6500000, name: 'Pokémon Legends: Z-A - Nintendo Switch', salePrice: 59.99, inStoreAvailability: true },
  ] });
  if (path.startsWith('/stores(')) return send({ stores: [
    { storeId: 176, storeType: 'Big Box', name: 'Main Street', address: '100 Main St', city: 'Springfield', region: 'TX', postalCode: '00001', lat: 40.1, lng: -89.9, distance: 5.21, phone: '555-0100' },
    { storeId: 665, storeType: 'Big Box', name: 'Oak Avenue', city: 'Oak Avenue', region: 'TX', postalCode: '00002', lat: 40.2, lng: -89.8, distance: 5.3 },
    { storeId: 7000, storeType: 'Express Kiosk', name: 'Airport kiosk', distance: 20 },
  ] });
  const m = /^\/products\/(\d+)\/stores\.json$/.exec(path);
  if (m) return send({ ispuEligible: true, stores: inStock[m[1]] ?? [] });
  send({}, 404);
});
await new Promise((r) => server.listen(0, r));
process.env.BESTBUY_BASE = `http://127.0.0.1:${server.address().port}`;
const { checkStock, mergeChain, configuredChains, scrub, learnWrongCounts, findRestocks, restockMessage } = await import('../src/stock/index.js');
const { shortName, isPokemonCards } = await import('../src/stock/bestbuy.js');
const env = { BESTBUY_API_KEY: KEY };
const T0 = 1_763_000_000_000;

test('only chains with a key are checked', () => {
  assert.deepEqual(configuredChains({}), []);
  assert.deepEqual(configuredChains(env), ['bestbuy']);
  assert.deepEqual(configuredChains({ STOCK_BROWSER: '1' }), ['dg']);
});

test('Pokémon card products only, with short names', () => {
  assert.equal(shortName('Pokémon - Trading Card Game: Mega Evolution - Delta Reign Booster Bundle'), 'Mega Evolution - Delta Reign Booster Bundle');
  assert.equal(shortName('Pokémon TCG: Scarlet & Violet 151 Booster Bundle'), 'Scarlet & Violet 151 Booster Bundle');
  assert.ok(isPokemonCards({ name: 'Pokemon - Trading Card Game: Mini Tin' }));
  assert.ok(!isPokemonCards({ name: 'Pokémon Legends: Z-A - Nintendo Switch' }));
  assert.ok(!isPokemonCards({ name: 'Magic: The Gathering Trading Card Game Booster' }));
});

test('first check: stores in range, what each has, nothing from out of range', async () => {
  calls.length = 0;
  const doc = await checkStock({ zip: '76101', radius: 50, env, now: T0 });
  assert.deepEqual(doc.chains.bestbuy, { name: 'Best Buy', checkedAt: T0, ok: true, error: null, exact: false, checked: ['bestbuy:6606082', 'bestbuy:6600001', 'bestbuy:6600002'] });
  assert.deepEqual(doc.stores.map((s) => s.id), ['bestbuy:176', 'bestbuy:665'], 'closest first; no kiosk, nothing 180 miles away');
  assert.equal(doc.stores[0].distance, 5.2);
  assert.equal(doc.stores[0].url, 'https://stores.bestbuy.com/176');
  assert.deepEqual(doc.stock, [{ s: 'bestbuy:176', p: 'bestbuy:6606082', in: true, low: true, qty: null, since: T0, log: [[T0, 1]] }]);
  assert.deepEqual(doc.products.map((p) => [p.sku, p.name, p.price]), [['6606082', 'Mega Evolution - Delta Reign Booster Bundle', 26.94]], 'only products some store has');
  assert.ok(!calls.includes('/products/6600002/stores.json'), 'online-only products are not looked up');
  assert.ok(!calls.includes('/products/6500000/stores.json'), 'video games are not looked up');
});

test('later checks keep when it came in, and say when it sold out', async () => {
  const first = await checkStock({ zip: '76101', radius: 50, env, now: T0 });
  const second = await checkStock({ zip: '76101', radius: 50, env, now: T0 + 1800_000, previous: first });
  assert.equal(second.stock[0].since, T0, 'still in: same start');
  assert.deepEqual(second.stock[0].log, [[T0, 1]], 'no new line while nothing changed');

  const saved = inStock[6606082];
  inStock[6606082] = [];
  inStock[6600001] = [{ storeID: 665, name: 'Oak Avenue', lowStock: false, distance: 5.3 }];
  const third = await checkStock({ zip: '76101', radius: 50, env, now: T0 + 3600_000, previous: second });
  const mainSt = third.stock.find((e) => e.s === 'bestbuy:176');
  assert.deepEqual(mainSt, { s: 'bestbuy:176', p: 'bestbuy:6606082', in: false, low: false, qty: null, since: T0 + 3600_000, log: [[T0, 1], [T0 + 3600_000, 0]] });
  assert.ok(third.stock.some((e) => e.s === 'bestbuy:665' && e.p === 'bestbuy:6600001' && e.in && e.since === T0 + 3600_000));
  assert.equal(third.products.length, 2, 'a product that just sold out is still described');

  // A week later the sold-out line is dropped.
  const later = await checkStock({ zip: '76101', radius: 50, env, now: T0 + 9 * 86400_000, previous: third });
  assert.ok(!later.stock.some((e) => e.s === 'bestbuy:176'));
  inStock[6606082] = saved;
  inStock[6600001] = [];
});

test('a failed check keeps the last answer and never shows the key', async () => {
  const first = await checkStock({ zip: '76101', radius: 50, env, now: T0 });
  down = true;
  const second = await checkStock({ zip: '76101', radius: 50, env, now: T0 + 1800_000, previous: first });
  down = false;
  assert.equal(second.chains.bestbuy.ok, false);
  assert.equal(second.chains.bestbuy.checkedAt, T0, 'still says when it was last really checked');
  assert.deepEqual(second.stock, first.stock);
  assert.deepEqual(second.stores, first.stores);

  const bad = await checkStock({ zip: '76101', radius: 50, env: { BESTBUY_API_KEY: 'wrong-secret-key' }, now: T0 });
  assert.equal(bad.chains.bestbuy.ok, false);
  assert.ok(!JSON.stringify(bad).includes('wrong-secret-key'), 'key is not in the published file');
  assert.equal(scrub('GET https://api.bestbuy.com/v1/products?apiKey=abc123&x=1 failed', {}), 'GET https://api.bestbuy.com/v1/products?apiKey=••• failed'.replace('?apiKey=•••', '?apiKey=•••&x=1'));
});

test('a chain that reports counts: the count and its changes are kept', () => {
  const stores = [{ id: 'x:1' }];
  const a = mergeChain(null, 'x', { stores, available: [{ store: 'x:1', product: 'x:p', qty: 3 }] }, 100);
  assert.deepEqual(a, [{ s: 'x:1', p: 'x:p', in: true, low: false, qty: 3, since: 100, log: [[100, 3]] }]);
  const b = mergeChain({ stock: a }, 'x', { stores, available: [{ store: 'x:1', product: 'x:p', qty: 1 }] }, 200);
  assert.deepEqual(b, [{ s: 'x:1', p: 'x:p', in: true, low: false, qty: 1, since: 100, log: [[100, 3], [200, 1]] }]);
});

test('Dollar General: card products only, stores from several points merged, exact counts', async () => {
  const { dollarGeneral, isPokemonCards: cards, lookupPoints, milesBetween } = await import('../src/stock/dollargeneral.js');
  assert.ok(cards('Pokémon Trading Card Game, 15 Card Pack, 1 ct') && cards('Pokemon TCG Mini Tin'));
  assert.ok(!cards('Pokémon Pikachu Plush, 8 in') && !cards('Pokémon Plastic Cup, 1ct') && !cards('Trading Card Binder'));
  assert.equal(lookupPoints(32.7, -97.3, 5).length, 1);
  assert.equal(lookupPoints(32.7, -97.3, 25).length, 7);
  assert.equal(lookupPoints(32.7, -97.3, 50).length, 15);
  assert.ok(Math.abs(milesBetween(32.7, -97.3, 32.7 + 10 / 69, -97.3) - 10) < 0.1);

  const lookups = [];
  const open = async () => ({
    close: async () => {},
    post: async (path, body) => {
      if (path.startsWith('v5/search')) return JSON.parse(body).PageStartRecordIndex ? { Items: [] } : { PaginationInfo: { TotalRecords: 2 }, Items: [
        { UPC: 728192558375, Description: 'Pokémon Trading Card Game, 15 Card Pack, 1 ct', Price: 8, Image: 'https://img/pack.jpg' },
        { UPC: 191726481539, Description: 'Pokémon Pikachu Plush, 8 in', Price: 10 }] };
      if (path === 'store/search/inventory') {
        const q = new URLSearchParams(body); lookups.push(q.get('upc'));
        const near = { storeNumber: 12629, address: '2919 CEDAR CREST BLVD', city: 'DALLAS', state: 'TX', zipCode: '75203-4011', latitude: 32.74, longitude: -96.79, productQTY: q.get('upc') === '728192558375' ? 3 : 0 };
        const tin = { storeNumber: 500, address: '1 MAIN ST', city: 'IRVING', state: 'TX', zipCode: '75060', latitude: 32.81, longitude: -96.95, productQTY: q.get('upc') === '820650105838' ? 1 : 0 };
        const far = { storeNumber: 9, address: 'FAR', city: 'WACO', state: 'TX', zipCode: '76701', latitude: 31.55, longitude: -97.15, productQTY: 5 };
        return { stores: [near, tin, far] };
      }
      if (path.startsWith('v2/product')) return { description: 'Pokémon TCG Mini Tin', finalPrice: 9.5, images: ['https://img/tin.jpg'] };
      throw new Error('unexpected ' + path);
    },
  });
  const r = await dollarGeneral({ radius: 25, lat: 32.7876, lon: -96.7994, open, pace: 0 });
  assert.deepEqual(r.stores.map((s) => [s.id, s.name, s.city, s.zip]), [['dg:12629', '2919 Cedar Crest Blvd', 'Dallas', '75203'], ['dg:500', '1 Main St', 'Irving', '75060']], 'no store outside the radius');
  assert.ok(r.stores[0].distance > 3 && r.stores[0].distance < 4);
  assert.deepEqual(r.available.sort((a, b) => a.store.localeCompare(b.store)), [{ store: 'dg:12629', product: 'dg:728192558375', qty: 3, low: false }, { store: 'dg:500', product: 'dg:820650105838', qty: 1, low: true }]);
  assert.deepEqual(r.products.map((p) => [p.sku, p.name, p.price]), [['728192558375', 'Pokémon Trading Card Game, 15 Card Pack, 1 ct', 8], ['820650105838', 'Pokémon TCG Mini Tin', 9.5]], 'the plush is left out; a seeded tin shows once a store has it');
  assert.ok(!lookups.includes('191726481539'));
  await assert.rejects(() => dollarGeneral({ radius: 25, lat: null, lon: null, open }), /ZIP/);
});

test('restock alerts: only what just came in, nearby, at stores already watched, never on the first check', () => {
  const chains = { dg: { name: 'Dollar General', ok: true, exact: true, checkedAt: 1 } };
  const stores = [{ id: 'dg:1', chain: 'dg', number: '1', name: '1 Main St', city: 'Dallas', distance: 3.3 }, { id: 'dg:2', chain: 'dg', number: '2', name: 'Far Rd', distance: 40 }, { id: 'dg:3', chain: 'dg', number: '3', name: 'New St', distance: 2 }];
  const products = [{ id: 'dg:a', name: 'Mini Tin' }, { id: 'dg:b', name: 'Elite Trainer Box' }];
  const before = { chains, stores: stores.slice(0, 2), stock: [{ s: 'dg:1', p: 'dg:a', in: true, qty: 2, since: 100, log: [[100, 2]] }] };
  const doc = { updatedAt: 500, chains, stores, products, stock: [
    { s: 'dg:1', p: 'dg:a', in: true, qty: 2, since: 100, log: [[100, 2]] },   // was already there
    { s: 'dg:1', p: 'dg:b', in: true, qty: 4, since: 500, log: [[500, 4]] },   // new: alert
    { s: 'dg:2', p: 'dg:b', in: true, qty: 1, since: 500, log: [[500, 1]] },   // too far
    { s: 'dg:3', p: 'dg:b', in: true, qty: 1, since: 500, log: [[500, 1]] },   // store seen for the first time
  ] };
  const r = findRestocks(before, doc, { miles: 15 });
  assert.deepEqual(r.map((x) => [x.store.id, x.product.id, x.qty]), [['dg:1', 'dg:b', 4]]);
  assert.deepEqual(restockMessage(r), { title: 'Dollar General restock: Elite Trainer Box', body: '3.3 mi · Dollar General 1 Main St, Dallas: Elite Trainer Box (4 on hand)' });
  assert.deepEqual(findRestocks(null, doc), [], 'first check: nothing');
  doc.stores[0].suspect = 'auto';
  assert.deepEqual(findRestocks(before, doc), [], 'a store with wrong counts never alerts');
  assert.equal(restockMessage([...r, ...r, ...r]).title, '3 restocks at 1 store');
});

test('wrong-count stores: learned from a count that never moves on a scarce product, and remembered', () => {
  const D = 86400_000, now = 100 * D;
  const stores = Array.from({ length: 10 }, (_, i) => ({ id: `dg:${i}`, chain: 'dg', number: String(i) }));
  const chains = { dg: { name: 'Dollar General', ok: true, exact: true } };
  const everywhere = stores.map((s) => ({ s: s.id, p: 'dg:packs', in: true, qty: 5, since: now - 30 * D, log: [[now - 30 * D, 5]] }));
  const doc = { chains, stores: stores.map((s) => ({ ...s })), stock: [
    ...everywhere,                                                                              // common product: never a sign
    { s: 'dg:1', p: 'dg:etb', in: true, qty: 3, since: now - 6 * D, log: [[now - 6 * D, 3]] },  // scarce, stuck 6 days
    { s: 'dg:2', p: 'dg:etb', in: true, qty: 2, since: now - 5 * D, log: [[now - 5 * D, 4], [now - D, 2]] }, // scarce but selling
  ] };
  learnWrongCounts(doc, null, now, ['7']);
  assert.deepEqual(doc.stores.filter((s) => s.suspect).map((s) => [s.id, s.suspect]), [['dg:1', 'auto'], ['dg:7', 'manual']]);
  assert.deepEqual(doc.flags, { 'dg:1': { at: now, seen: now, product: 'dg:etb' } });

  // Later the stuck count is gone: the store is still remembered, until 45 days pass.
  const later = { chains, stores: stores.map((s) => ({ ...s })), stock: everywhere };
  learnWrongCounts(later, doc, now + 10 * D);
  assert.equal(later.stores[1].suspect, 'auto');
  assert.equal(later.flags['dg:1'].at, now);
  const muchLater = { chains, stores: stores.map((s) => ({ ...s })), stock: everywhere };
  learnWrongCounts(muchLater, later, now + 50 * D);
  assert.equal(muchLater.stores[1].suspect, undefined);
});

test('a product that was not read this time keeps its stock (no false sold-out)', () => {
  const stores = [{ id: 'x:1' }, { id: 'x:2' }];
  const before = { stock: [
    { s: 'x:1', p: 'x:a', in: true, low: false, qty: 5, since: 100, log: [[100, 5]] },
    { s: 'x:2', p: 'x:b', in: true, low: false, qty: 2, since: 100, log: [[100, 2]] },
  ] };
  // This time only product b was read, and store 2 has none of it now.
  const out = mergeChain(before, 'x', { stores, products: [], checked: ['x:b'], available: [] }, 200);
  assert.deepEqual(out.find((e) => e.p === 'x:a'), before.stock[0], 'a was not read: unchanged');
  assert.equal(out.find((e) => e.p === 'x:b').in, false, 'b was read: sold out');
});

test('Dollar General: products found before are looked up again, and one item listed twice is shown once', async () => {
  const { dollarGeneral } = await import('../src/stock/dollargeneral.js');
  const asked = [];
  const open = async () => ({
    close: async () => {},
    post: async (path, body) => {
      if (path.startsWith('v5/search')) return { Items: [] }; // the search skips everything this time
      if (path === 'store/search/inventory') {
        const upc = new URLSearchParams(body).get('upc'); asked.push(upc);
        const qty = upc === '820650105838' || upc === '196214141308' ? 4 : 0; // two UPCs, same tins
        return { stores: [1, 2].map((n) => ({ storeNumber: n, address: `${n} Main`, city: 'X', state: 'TX', zipCode: '00001', latitude: 32.79 + n / 1000, longitude: -96.8, productQTY: n === 1 ? qty : (qty ? qty + 1 : 0) })) };
      }
      if (path.startsWith('v2/product')) return { description: 'Pokémon Mini Tin', finalPrice: 9 };
      throw new Error(path);
    },
  });
  const known = [{ id: 'dg:000000000111', chain: 'dg', sku: '000000000111', name: 'Booster Bundle', price: 25, image: null, url: null }];
  const r = await dollarGeneral({ radius: 5, lat: 32.79, lon: -96.8, known, open, pace: 0 });
  assert.ok(asked.includes('000000000111'), 'a product from before is checked even when the search skips it');
  assert.ok(r.checked.includes('dg:000000000111'));
  assert.ok(r.products.some((p) => p.sku === '000000000111'), 'and keeps its name');
  const tins = r.products.filter((p) => /Mini Tin/.test(p.name));
  assert.equal(tins.length, 1, 'the same tins under two UPCs are shown once');
  assert.equal(r.available.filter((a) => a.product === tins[0].id).length, 2);
});

test.after(() => server.close());
