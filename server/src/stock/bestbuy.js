// Best Buy, through its official developer API (developer.bestbuy.com, free key):
//   Products API   the Pokémon Trading Card Game products it sells
//   Stores API     the stores near a ZIP code
//   Availability   /products/{sku}/stores.json: the stores near a ZIP that have a product to pick up now
// The API says which stores have a product and whether stock is low, not how many are on hand.

import { request } from '../lib/http.js';

const BASE = () => process.env.BESTBUY_BASE ?? 'https://api.bestbuy.com/v1';
// The key allows 5 requests a second.
const PACE = { minInterval: 260, timeout: 25_000, retries: 3 };

async function api(path, params, key) {
  const q = new URLSearchParams({ format: 'json', ...params, apiKey: key });
  try {
    return await (await request(`${BASE()}/${path}?${q}`, PACE)).json();
  } catch (err) {
    // Never let the key into an error message.
    const e = new Error(String(err.message).split(key).join('•••'));
    e.status = err.status;
    throw e;
  }
}

/** Booster packs, boxes, tins and collections; not video games, plush or sleeves sold next to them. */
export function isPokemonCards(p) {
  const name = String(p.name ?? '');
  return /pok[eé]mon/i.test(name) && /trading card|tcg/i.test(name);
}

/** "Pokémon - Trading Card Game: Mega Evolution - Delta Reign Booster Bundle" -> "Mega Evolution - Delta Reign Booster Bundle" */
export function shortName(name) {
  return String(name ?? '').replace(/^pok[eé]mon\s*(?:tcg|-\s*trading card game)\s*[:\-–]\s*/i, '').replace(/\s+/g, ' ').trim() || String(name ?? '');
}

async function products(key) {
  const out = new Map();
  for (let page = 1; page <= 6; page++) {
    const res = await api('products(search=pokemon&search=trading&search=card)', {
      show: 'sku,name,salePrice,image,url,inStoreAvailability,active', pageSize: '100', page: String(page),
    }, key);
    for (const p of res.products ?? []) {
      if (!isPokemonCards(p) || p.active === false) continue;
      out.set(String(p.sku), { id: `bestbuy:${p.sku}`, chain: 'bestbuy', sku: String(p.sku), name: shortName(p.name), price: p.salePrice ?? null, image: p.image ?? null, url: p.url ?? `https://www.bestbuy.com/site/${p.sku}.p?skuId=${p.sku}`, inStores: p.inStoreAvailability !== false });
    }
    if (page >= (res.totalPages ?? 1)) break;
  }
  return [...out.values()];
}

const storeOf = (s, distance) => ({
  id: `bestbuy:${s.storeId ?? s.storeID}`, chain: 'bestbuy', number: String(s.storeId ?? s.storeID), name: s.name ?? s.longName ?? 'Best Buy',
  address: s.address ?? null, city: s.city ?? null, state: s.region ?? s.state ?? null, zip: s.postalCode ?? s.fullPostalCode ?? null,
  distance: distance != null ? Math.round(distance * 10) / 10 : null, phone: s.phone ?? null,
  url: `https://stores.bestbuy.com/${s.storeId ?? s.storeID}`, lat: s.lat ?? null, lng: s.lng ?? null,
});

export async function bestBuy({ zip, radius, key }) {
  if (!key) throw new Error('no Best Buy API key');
  const list = await products(key);
  // Every full-size store in range (so the screen can also list stores with nothing in).
  const stores = new Map();
  try {
    const res = await api(`stores(area(${zip},${radius}))`, { show: 'storeId,storeType,name,longName,address,city,region,postalCode,lat,lng,distance,phone', pageSize: '100' }, key);
    for (const s of res.stores ?? []) if (!s.storeType || /big\s*box|outlet/i.test(s.storeType)) stores.set(`bestbuy:${s.storeId}`, storeOf(s, s.distance));
  } catch { /* the availability answers below also name their stores */ }

  const available = [];
  for (const p of list) {
    if (!p.inStores) continue;
    const res = await api(`products/${p.sku}/stores.json`, { postalCode: zip }, key);
    for (const s of res.stores ?? []) {
      if (s.distance != null && s.distance > radius) continue;
      const id = `bestbuy:${s.storeID ?? s.storeId}`;
      if (!stores.has(id)) stores.set(id, storeOf(s, s.distance));
      available.push({ store: id, product: p.id, low: Boolean(s.lowStock), qty: null });
    }
  }
  return { products: list.map(({ inStores, ...p }) => p), stores: [...stores.values()], available };
}
