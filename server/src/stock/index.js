// Nearby stock of Pokémon TCG product at store chains.
//
// Each chain module returns the Pokémon products the chain sells, its stores near a ZIP code and
// which store has which product right now. The result is one small file, stock.json, that the
// website and the iPhone app both read:
//
//   { v, updatedAt, radius,
//     chains:   { id: { name, checkedAt, ok, error, exact (true when the chain reports how many are on hand) } },
//     stores:   [{ id, chain, number, name, address, city, state, zip, distance, phone, url, lat, lng,
//                  suspect ('auto' = its counts were caught not moving, 'manual' = you listed it; else absent) }],
//     flags:    { store id: { at (first caught), seen (last caught), product } }  what the checker has learned,
//     products: [{ id, chain, sku, name, price, image, url }],
//     stock:    [{ s (store id), p (product id), in, low, qty, since (when it got to how it is now), log: [[time, in ? (qty ?? 1) : 0], …] }] }
//
// A chain goes in CHAINS; nothing else needs to know about it.

import { bestBuy } from './bestbuy.js';
import { dollarGeneral } from './dollargeneral.js';

export const CHAINS = {
  bestbuy: { name: 'Best Buy', check: bestBuy, key: 'BESTBUY_API_KEY', exact: false },
  // Needs Chrome on the machine (STOCK_BROWSER=1, set by the scheduled job).
  dg: { name: 'Dollar General', check: dollarGeneral, key: 'STOCK_BROWSER', exact: true },
};

const KEEP_SOLD_OUT = 7 * 86400_000;
const DAY = 86400_000;
// A count that hasn't moved for this long, on a product most stores are out of, is a count that's wrong.
const STUCK_AFTER = 3 * DAY;
const SCARCE_BELOW = 0.35;
// A store caught once stays marked this long after the last time it was caught.
const REMEMBER = 45 * DAY;
const LOG_LENGTH = 6;

/** The chains that can be checked with what's in the environment. */
export function configuredChains(env = process.env) {
  return Object.entries(CHAINS).filter(([, c]) => !c.key || env[c.key]).map(([id]) => id);
}

/** Folds one chain's fresh answer into what was known before: when each product got in or sold out. */
export function mergeChain(previous, chainId, fresh, now) {
  const before = new Map((previous?.stock ?? []).filter((e) => e.s.startsWith(`${chainId}:`)).map((e) => [`${e.s}|${e.p}`, e]));
  const stores = new Map(fresh.stores.map((s) => [s.id, s]));
  const out = [];
  const seen = new Set();
  for (const a of fresh.available) {
    if (!stores.has(a.store)) continue;
    const key = `${a.store}|${a.product}`;
    seen.add(key);
    const old = before.get(key);
    const qty = a.qty ?? null;
    const code = qty ?? 1;
    const changed = !old || !old.in || (old.qty ?? null) !== qty;
    out.push({
      s: a.store, p: a.product, in: true, low: Boolean(a.low), qty,
      since: old?.in ? old.since : now,
      log: changed ? [...(old?.log ?? []), [now, code]].slice(-LOG_LENGTH) : old.log,
    });
  }
  // Sold out since the last check, or still within a week of selling out: kept so the screen can say when.
  for (const [key, old] of before) {
    if (seen.has(key) || !stores.has(old.s)) continue;
    if (old.in) out.push({ s: old.s, p: old.p, in: false, low: false, qty: null, since: now, log: [...(old.log ?? []), [now, 0]].slice(-LOG_LENGTH) });
    else if (now - old.since < KEEP_SOLD_OUT) out.push(old);
  }
  return out;
}

/**
 * Checks every chain and returns the new stock.json. A chain that fails keeps what was known
 * about it, marked as not checked, so one outage never empties the screen.
 */
export async function checkStock({ zip, radius = 50, lat = null, lon = null, badStores = [], previous = null, env = process.env, now = Date.now(), chains = configuredChains(env), log = () => {} }) {
  const doc = { v: 1, updatedAt: now, radius, chains: {}, stores: [], products: [], stock: [] };
  for (const id of chains) {
    const chain = CHAINS[id];
    try {
      const fresh = await chain.check({ zip, radius, lat, lon, key: chain.key ? env[chain.key] : null });
      doc.chains[id] = { name: chain.name, checkedAt: now, ok: true, error: null, exact: chain.exact };
      doc.stores.push(...fresh.stores);
      doc.products.push(...fresh.products);
      doc.stock.push(...mergeChain(previous, id, fresh, now));
      log(`${chain.name}: ${fresh.stores.length} stores, ${fresh.products.length} products, ${fresh.available.length} in stock`);
    } catch (err) {
      const was = previous?.chains?.[id];
      doc.chains[id] = { name: chain.name, checkedAt: was?.checkedAt ?? null, ok: false, error: scrub(err.message, env), exact: chain.exact };
      doc.stores.push(...(previous?.stores ?? []).filter((s) => s.chain === id));
      doc.products.push(...(previous?.products ?? []).filter((p) => p.chain === id));
      doc.stock.push(...(previous?.stock ?? []).filter((e) => e.s.startsWith(`${id}:`)));
      log(`${chain.name}: not checked (${doc.chains[id].error})`);
    }
  }
  // Products nobody has (or had lately) aren't worth sending to the phone.
  const used = new Set(doc.stock.map((e) => e.p));
  doc.products = doc.products.filter((p) => used.has(p.id));
  doc.stores.sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9));
  learnWrongCounts(doc, previous, now, badStores);
  return doc;
}

/**
 * Stores whose counts can't be trusted. Learned: a store showing the same count for days on a product
 * that most stores are out of (real stock of a scarce product sells; a count that never moves is a
 * count nobody corrected). Remembered between runs in doc.flags. Listed by hand: `badStores`
 * (store numbers, or ids like "dg:12629").
 */
export function learnWrongCounts(doc, previous, now, badStores = []) {
  const flags = {};
  for (const [id, f] of Object.entries(previous?.flags ?? {})) if (now - f.seen < REMEMBER) flags[id] = f;
  const storesOf = new Map();
  for (const s of doc.stores) storesOf.set(s.chain, (storesOf.get(s.chain) ?? 0) + 1);
  const carrying = new Map();
  for (const e of doc.stock) if (e.in) carrying.set(e.p, (carrying.get(e.p) ?? 0) + 1);
  for (const e of doc.stock) {
    const chain = e.s.split(':')[0];
    if (!e.in || !doc.chains[chain]?.exact || !doc.chains[chain]?.ok) continue;
    const total = storesOf.get(chain) ?? 0;
    if (total < 8 || (carrying.get(e.p) ?? 0) / total >= SCARCE_BELOW) continue;
    const changed = e.log?.at(-1)?.[0] ?? e.since;
    if (now - changed < STUCK_AFTER) continue;
    flags[e.s] = { at: flags[e.s]?.at ?? now, seen: now, product: e.p };
  }
  doc.flags = flags;
  const listed = new Set(badStores.map((x) => String(x).trim()).filter(Boolean));
  for (const s of doc.stores) {
    if (listed.has(s.id) || listed.has(s.number)) s.suspect = 'manual';
    else if (flags[s.id]) s.suspect = 'auto';
    else delete s.suspect;
  }
  return doc;
}

/**
 * What came into stock since the last check, worth a push alert: a product a store didn't have last
 * time, at a store that was already being watched, within `miles`, and not a store whose counts are wrong.
 * Nothing on the first check of a chain (everything would look new).
 */
export function findRestocks(previous, doc, { miles = 15 } = {}) {
  if (!previous) return [];
  const known = new Set((previous.stores ?? []).map((s) => s.id));
  const stores = new Map(doc.stores.map((s) => [s.id, s]));
  const products = new Map(doc.products.map((p) => [p.id, p]));
  const out = [];
  for (const e of doc.stock) {
    const chain = e.s.split(':')[0];
    if (!e.in || e.since !== doc.updatedAt || !doc.chains[chain]?.ok || !previous.chains?.[chain]?.checkedAt) continue;
    const store = stores.get(e.s), product = products.get(e.p);
    if (!store || !product || !known.has(e.s) || store.suspect || (store.distance ?? 1e9) > miles) continue;
    out.push({ store, product, qty: e.qty, chain: doc.chains[chain].name });
  }
  return out.sort((a, b) => (a.store.distance ?? 0) - (b.store.distance ?? 0));
}

/** The alert for a set of restocks: { title, body }. */
export function restockMessage(restocks) {
  const stores = new Set(restocks.map((r) => r.store.id)).size;
  const first = restocks[0];
  const title = restocks.length === 1
    ? `${first.chain} restock: ${first.product.name}`
    : `${restocks.length} restocks at ${stores} store${stores === 1 ? '' : 's'}`;
  const line = (r) => `${r.store.distance != null ? `${r.store.distance} mi · ` : ''}${r.chain} ${r.store.name}${r.store.city ? `, ${r.store.city}` : ''}: ${r.product.name}${r.qty != null ? ` (${r.qty} on hand)` : ''}`;
  const lines = restocks.slice(0, 10).map(line);
  if (restocks.length > 10) lines.push(`…and ${restocks.length - 10} more`);
  return { title, body: lines.join('\n') };
}

/** Error text safe to publish: no keys, one line. */
export function scrub(message, env = process.env) {
  let s = String(message ?? 'failed');
  for (const c of Object.values(CHAINS)) if (c.key && env[c.key]) s = s.split(env[c.key]).join('•••');
  return s.replace(/apiKey=[^&\s]+/gi, 'apiKey=•••').replace(/\s+/g, ' ').slice(0, 160);
}
