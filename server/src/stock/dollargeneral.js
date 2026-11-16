// Dollar General. It has no public API, so this reads the same answers its own website shows a
// shopper: a normal Chrome opens a product page (which gives every visitor a guest session), then
// asks the site's store lookup which stores near a point have each Pokémon card product, and how many.
// The lookup returns the 25 nearest stores to a point, so a wider radius is covered from a few points.
// No login, no checkout, nothing done to get past a block: if the site says no, the check fails.

const SITE = 'https://www.dollargeneral.com';
const API = 'https://dggo.dollargeneral.com/omni/api';
const START = `${SITE}/p/pokemon-trading-card-game-15-card-pack-1-ct/728192558375`;

// Products the site's search doesn't always list (seasonal boxes and tins), by UPC.
export const SEED_UPCS = ['728192558375', '820650801563', '820650806568', '820650809859', '820650105838', '196214158801', '196214158757', '196214158726', '196214152397', '196214150669', '196214141308', '196214152076'];

/** Card product (packs, tins, boxes); not plush, plates or candy. */
export function isPokemonCards(description) {
  const d = String(description ?? '');
  if (!/pok[eé]mon/i.test(d)) return false;
  if (/plush|plate|napkin|cup|candy|chocolate|wrap|blanket|sticker|figure|toy|shirt|sock|balloon|party|costume/i.test(d)) return false;
  return /trading card|tcg|card pack|booster|tin\b|elite trainer|collection|blister|deck|poster|binder|ex box|knock ?out/i.test(d);
}

const RAD = Math.PI / 180;
export function milesBetween(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * RAD, dLon = (bLon - aLon) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

/** The points to look around: the middle, plus a ring (or two) when the radius is wide. */
export function lookupPoints(lat, lon, radius) {
  const out = [[lat, lon]];
  const ring = (miles, n) => {
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      out.push([lat + (miles / 69) * Math.cos(a), lon + (miles / (69 * Math.cos(lat * RAD))) * Math.sin(a)]);
    }
  };
  if (radius > 8) ring(Math.min(radius * 0.55, 14), 6);
  if (radius > 30) ring(radius * 0.8, 8);
  return out;
}

const title = (s) => String(s ?? '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const pad = (upc) => String(upc).padStart(12, '0');

/** Opens the site in Chrome and returns a way to ask its API with the visitor session the page was given. */
async function openSite() {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'en-US' })).newPage();
  let session = null;
  page.on('request', (req) => {
    const h = req.headers();
    if (/dggo\.dollargeneral\.com/.test(req.url()) && h.authorization) session = Object.fromEntries(Object.entries(h).filter(([k]) => /^(authorization|x-dg)/.test(k)));
  });
  await page.goto(START, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  for (let i = 0; i < 30 && !session; i++) await page.waitForTimeout(500);
  if (!session) { await browser.close(); throw new Error('Dollar General gave no visitor session'); }
  const post = async (path, body, json) => {
    const r = await page.evaluate(async ([url, h, body, json]) => {
      const res = await fetch(url, { method: 'POST', headers: { ...h, accept: 'application/json', 'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded; charset=UTF-8' }, body });
      return { status: res.status, text: await res.text() };
    }, [`${API}/${path}`, session, body, json]);
    if (r.status !== 200) throw new Error(`Dollar General answered ${r.status}`);
    return r.text ? JSON.parse(r.text) : {};
  };
  return { post, close: () => browser.close() };
}

/** { zip, radius, lat, lon } -> { products, stores, available }. `open` is replaced in tests. */
export async function dollarGeneral({ radius, lat, lon, open = openSite, pace = 250 }) {
  if (!(Number.isFinite(lat) && Number.isFinite(lon))) throw new Error("couldn't place the ZIP code on the map");
  const site = await open();
  const wait = () => new Promise((r) => setTimeout(r, pace));
  try {
    // The site's search and product data are asked for one store: the nearest one.
    const nearest = await site.post('store/search/inventory', new URLSearchParams({ latitude: lat.toFixed(5), longitude: lon.toFixed(5), radius: String(Math.min(radius, 50)), upc: SEED_UPCS[0], offerSourceType: '0' }).toString(), false).catch(() => null);
    const home = nearest?.stores?.[0]?.storeNumber ?? 0;
    await wait();
    // 1. The Pokémon card products: the site's search, plus known UPCs it doesn't always list.
    const products = new Map();
    for (const term of ['pokemon trading card', 'pokemon']) {
      for (let start = 0; start < 96; start += 24) {
        const res = await site.post('v5/search/shoppinglist/product/Provider', JSON.stringify({
          StoreNbr: home, SearchTerm: term, PageSize: 24, PageStartRecordIndex: start,
          Filters: { category: [], brand: [], dgDelivery: false, dgPickUp: false, dgShipTohome: false, soldAtStore: false, inStock: false },
          IncludeSponsored: false, IncludeShipToHome: true, IncludeDeals: false, offerSourceType: 0, SearchType: 0 }), true).catch(() => null);
        await wait();
        const items = res?.Items ?? [];
        for (const it of items) {
          if (!isPokemonCards(it.Description)) continue;
          const upc = pad(it.UPC);
          products.set(upc, { id: `dg:${upc}`, chain: 'dg', sku: upc, name: it.Description, price: it.Price ?? null, image: it.Image ?? null, url: `${SITE}/p/pokemon/${upc}` });
        }
        if (start + 24 >= (res?.PaginationInfo?.TotalRecords ?? 0)) break;
      }
    }
    const seeds = SEED_UPCS.filter((u) => !products.has(u));

    // 2. For each product, the stores around each point and how many each has.
    const stores = new Map();
    const best = new Map(); // "store|upc" -> qty
    const points = lookupPoints(lat, lon, radius);
    let answered = 0;
    for (const upc of [...products.keys(), ...seeds]) {
      for (const [pLat, pLon] of points) {
        let res;
        try {
          res = await site.post('store/search/inventory', new URLSearchParams({ latitude: pLat.toFixed(5), longitude: pLon.toFixed(5), radius: String(Math.min(radius, 50)), upc, offerSourceType: '0' }).toString(), false);
          answered++;
        } catch { await wait(); continue; }
        await wait();
        for (const s of res.stores ?? []) {
          const distance = milesBetween(lat, lon, s.latitude, s.longitude);
          if (!(distance <= radius)) continue;
          const id = `dg:${s.storeNumber}`;
          if (!stores.has(id)) stores.set(id, {
            id, chain: 'dg', number: String(s.storeNumber), name: title(s.address) || `Store ${s.storeNumber}`, address: title(s.address) || null, city: title(s.city) || null, state: s.state ?? null,
            zip: String(s.zipCode ?? '').slice(0, 5) || null, distance: Math.round(distance * 10) / 10, phone: s.phoneNumber ?? null, url: `${SITE}/store-directory/${s.storeNumber}`, lat: s.latitude, lng: s.longitude });
          const qty = Number(s.productQTY);
          if (qty > 0) best.set(`${id}|${upc}`, qty);
        }
      }
    }
    if (!answered) throw new Error('Dollar General answered none of the store lookups');

    // A seeded product only appears once some store has it; its name comes from the product page data.
    for (const upc of seeds) {
      if (![...best.keys()].some((k) => k.endsWith(`|${upc}`))) continue;
      const d = await site.post('v2/product/item/details/provider', JSON.stringify({ upc, store: home, getNearByStoresCount: false, isPickup: false, limitImagesToFour: true, includeShipToHome: false, offerSourceType: 0 }), true).catch(() => null);
      await wait();
      products.set(upc, { id: `dg:${upc}`, chain: 'dg', sku: upc, name: d?.description ?? `Pokémon cards (UPC ${upc})`, price: d?.finalPrice ?? null, image: d?.images?.[0] ?? null, url: `${SITE}/p/pokemon/${upc}` });
    }
    const available = [...best].map(([key, qty]) => { const [store, upc] = key.split('|'); return { store, product: `dg:${upc}`, qty, low: qty <= 2 }; }).filter((a) => products.has(a.product.slice(3)));
    return { products: [...products.values()], stores: [...stores.values()], available };
  } finally {
    await site.close();
  }
}
