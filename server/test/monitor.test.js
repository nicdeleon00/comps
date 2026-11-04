import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createECDH, randomBytes, createPublicKey, verify } from 'node:crypto';
import { encrypt, decrypt, vapidAuth, generateVapidKeys, b64u, fromB64u } from '../../monitor/webpush.mjs';
import { parseProductPage, looksBlocked, storeOf } from '../../monitor/stores.mjs';
import { Monitor } from '../../monitor/monitor.mjs';

test('web push encryption matches the RFC 8291 example byte for byte', () => {
  const out = encrypt('When I grow up, I want to be a watermelon', {
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  }, { salt: fromB64u('DGv6ra1nlYgDCS1FRnbzlw'), serverPrivateKey: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw' });
  assert.equal(b64u(out), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('VAPID token is a valid ES256 signature for the push service origin', () => {
  const vapid = generateVapidKeys();
  const header = vapidAuth('https://web.push.apple.com/abc', vapid, 'https://example.com/', Date.UTC(2026, 0, 1));
  const [, jwt, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, vapid.publicKey);
  const [h, c, s] = jwt.split('.');
  const claims = JSON.parse(fromB64u(c).toString());
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.sub, 'https://example.com/');
  const pub = fromB64u(vapid.publicKey);
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, fromB64u(s)));
});

const ld = (obj) => `<html><head><title>X</title><script type="application/ld+json">${JSON.stringify(obj)}</script></head></html>`;

test('product pages: stock and price from structured data', () => {
  const inStock = parseProductPage(ld({ '@type': 'Product', name: 'Prismatic Evolutions Elite Trainer Box', offers: { '@type': 'Offer', price: '49.99', availability: 'https://schema.org/InStock' } }));
  assert.deepEqual([inStock.state, inStock.price, inStock.title], ['in_stock', 49.99, 'Prismatic Evolutions Elite Trainer Box']);
  assert.equal(parseProductPage(ld({ '@type': 'Product', offers: [{ availability: 'http://schema.org/OutOfStock', price: 59.99 }] })).state, 'out_of_stock');
  assert.equal(parseProductPage(ld({ '@type': 'Product', offers: { availability: 'https://schema.org/PreOrder' } })).state, 'preorder');
  // Any buyable offer wins (marketplace pages list several sellers).
  const mixed = parseProductPage(ld({ '@graph': [{ '@type': 'Product', name: 'Box', offers: { '@type': 'AggregateOffer', offers: [{ availability: 'OutOfStock', price: 40 }, { availability: 'InStock', price: 89 }] } }] }));
  assert.deepEqual([mixed.state, mixed.price], ['in_stock', 89]);
  const tags = parseProductPage('<meta property="product:availability" content="out of stock"><meta property="og:title" content="Booster Bundle">');
  assert.deepEqual([tags.state, tags.title], ['out_of_stock', 'Booster Bundle']);
  assert.equal(parseProductPage('<html><body>Add to cart</body></html>').state, 'unknown');
});

test('product pages: bot walls are recognised, not mistaken for stock', () => {
  assert.ok(looksBlocked(403, ''));
  assert.ok(looksBlocked(200, '<div id="px-captcha"></div>'));
  assert.ok(!looksBlocked(200, ld({ '@type': 'Product' })));
  assert.equal(storeOf('https://www.target.com/p/x/-/A-1'), 'target');
  assert.equal(storeOf('https://www.pokemoncenter.com/product/1'), 'pokemoncenter');
});

test('monitor: checks a shared link once and alerts each person on their own devices', async () => {
  // A fake store page and a fake push service, both local.
  let stock = 'OutOfStock';
  let pageHits = 0;
  const pushes = [];
  const phone = () => { const k = createECDH('prime256v1'); k.generateKeys(); return { k, auth: randomBytes(16) }; };
  const ash = phone(), misty = phone();
  const server = createServer((req, res) => {
    if (req.url === '/product') {
      pageHits++;
      res.setHeader('Content-Type', 'text/html');
      return res.end(ld({ '@type': 'Product', name: 'Surging Sparks Booster Box', offers: { price: 159.99, availability: `https://schema.org/${stock}` } }));
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { pushes.push({ to: req.url, headers: req.headers, body: Buffer.concat(chunks) }); res.statusCode = 201; res.end(); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const url = `${base}/product`;
  // Two accounts watch the same link; Misty only wants it at $100 or less.
  const db = {
    watch: [{ id: 'w-ash', user_id: 'ash', url, name: null, max_price: 170 }, { id: 'w-misty', user_id: 'misty', url, name: 'Booster box', max_price: 100 }],
    devices: [
      { id: 'd-ash', user_id: 'ash', name: 'iPhone', endpoint: `${base}/push/ash`, p256dh: b64u(ash.k.getPublicKey()), auth: b64u(ash.auth) },
      { id: 'd-misty', user_id: 'misty', name: 'iPhone', endpoint: `${base}/push/misty`, p256dh: b64u(misty.k.getPublicKey()), auth: b64u(misty.auth) },
    ],
    status: [], events: [], heartbeat: null,
  };
  const accounts = {
    watchItems: async () => structuredClone(db.watch), devices: async () => structuredClone(db.devices), statuses: async () => structuredClone(db.status),
    upsertStatus: async (rows) => { for (const r of rows) db.status = [...db.status.filter((x) => x.watch_id !== r.watch_id), r]; },
    addEvents: async (rows) => { db.events.push(...rows); }, deleteDevice: async () => {}, heartbeat: async (h) => { db.heartbeat = h; }, pruneEvents: async () => {},
  };
  const config = { vapid: generateVapidKeys(), interval: 15, subject: 'https://example.com/', greeted: [] };
  const m = new Monitor(config, accounts, { save: () => {} });
  const open = (p, who) => JSON.parse(decrypt(p.body, { privateKey: b64u(who.k.getPrivateKey()), auth: b64u(who.auth) }));
  try {
    await m.load();
    assert.equal(pushes.length, 2, 'each new device gets a test alert');
    assert.equal(open(pushes.find((p) => p.to === '/push/ash'), ash).title, 'Drop alerts are on');
    assert.equal(m.links.size, 1, 'one link, even with two people watching');

    await m.check(url);
    assert.equal(pageHits, 1);
    assert.equal(pushes.length, 2, 'no alert while out of stock');

    stock = 'InStock';
    await m.check(url);
    assert.equal(pageHits, 2, 'still one request per check');
    const alerts = pushes.slice(2);
    assert.deepEqual(alerts.map((p) => p.to), ['/push/ash'], 'only the person whose price limit is met');
    const alert = open(alerts[0], ash);
    assert.match(alert.title, /in stock/);
    assert.match(alert.body, /Surging Sparks Booster Box · \$159\.99/);
    assert.equal(alert.url, url);
    assert.match(alerts[0].headers.authorization, /^vapid t=/);

    await m.check(url);
    assert.equal(pushes.length, 3, 'no repeat while it stays in stock');

    await m.write();
    assert.deepEqual(db.status.map((r) => [r.watch_id, r.state]).sort(), [['w-ash', 'in_stock'], ['w-misty', 'in_stock']]);
    assert.deepEqual(db.events.map((e) => [e.user_id, e.watch_id, e.price]), [['ash', 'w-ash', 159.99]]);
    assert.equal(db.heartbeat.vapid_public_key, config.vapid.publicKey, 'publishes the key devices subscribe with');

    // A restart remembers status, so nobody gets a duplicate alert.
    const again = new Monitor(config, accounts, { save: () => {} });
    await again.load();
    await again.check(url);
    assert.equal(pushes.length, 3);
  } finally {
    server.close();
  }
});
