import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createECDH, randomBytes, createPublicKey, verify } from 'node:crypto';
import { encrypt, decrypt, vapidAuth, generateVapidKeys, b64u, fromB64u } from '../../monitor/webpush.mjs';
import { parseProductPage, looksBlocked, storeOf } from '../../monitor/stores.mjs';
import { Monitor } from '../../monitor/monitor.mjs';
import { DROPS_FILE, MONITOR_FILE } from '../../monitor/gist.mjs';

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

test('monitor: alerts once when a watched product comes in stock, with a working encrypted push', async () => {
  // A fake store page and a fake push service, both local.
  let stock = 'OutOfStock';
  const pushes = [];
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = randomBytes(16);
  const server = createServer((req, res) => {
    if (req.url === '/product') {
      res.setHeader('Content-Type', 'text/html');
      return res.end(ld({ '@type': 'Product', name: 'Surging Sparks Booster Box', offers: { price: 159.99, availability: `https://schema.org/${stock}` } }));
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      pushes.push({ headers: req.headers, body: Buffer.concat(chunks) });
      res.statusCode = 201;
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const files = {
    [DROPS_FILE]: {
      v: 1,
      watch: [{ id: 'w1', url: `${base}/product`, name: '', maxPrice: 170 }],
      devices: [{ id: 'd1', name: 'iPhone', endpoint: `${base}/push`, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } }],
    },
  };
  const m = new Monitor({ token: 't', gist: 'g', vapid: generateVapidKeys(), interval: 15, subject: 'https://example.com/' });
  m.gist = { read: async () => structuredClone(files), write: async (f) => Object.assign(files, structuredClone(f)) };
  const open = (p) => JSON.parse(decrypt(p.body, { privateKey: b64u(ua.getPrivateKey()), auth: b64u(auth) }));
  try {
    await m.load();
    await m.greetNewDevices();
    assert.equal(pushes.length, 1, 'new phone gets a test alert');
    assert.equal(open(pushes[0]).title, 'Drop alerts are on');
    assert.match(pushes[0].headers.authorization, /^vapid t=/);
    assert.equal(pushes[0].headers['content-encoding'], 'aes128gcm');

    const w = m.watch[0];
    await m.check(w);
    assert.equal(m.status.w1.state, 'out_of_stock');
    assert.equal(pushes.length, 1, 'no alert while out of stock');

    stock = 'InStock';
    await m.check(w);
    assert.equal(pushes.length, 2, 'alert when it comes in stock');
    const alert = open(pushes[1]);
    assert.equal(alert.title, '127.0.0.1: in stock');
    assert.match(alert.body, /Surging Sparks Booster Box · \$159\.99/);
    assert.equal(alert.url, `${base}/product`);

    await m.check(w);
    assert.equal(pushes.length, 2, 'no repeat while it stays in stock');
    assert.equal(m.events.length, 1);

    await m.save();
    assert.equal(files[MONITOR_FILE].status.w1.state, 'in_stock');
    assert.ok(files[MONITOR_FILE].vapidPublicKey, 'publishes the key phones subscribe with');
  } finally {
    server.close();
  }
});
