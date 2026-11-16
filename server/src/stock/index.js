// Nearby stock of Pokémon TCG product at store chains.
//
// Each chain module returns the Pokémon products the chain sells, its stores near a ZIP code and
// which store has which product right now. The result is one small file, stock.json, that the
// website and the iPhone app both read:
//
//   { v, updatedAt, radius,
//     chains:   { id: { name, checkedAt, ok, error, exact (true when the chain reports how many are on hand) } },
//     stores:   [{ id, chain, number, name, address, city, state, zip, distance, phone, url, lat, lng }],
//     products: [{ id, chain, sku, name, price, image, url }],
//     stock:    [{ s (store id), p (product id), in, low, qty, since (when it got to how it is now), log: [[time, in ? (qty ?? 1) : 0], …] }] }
//
// Only chains with a lookup the chain itself offers to the public are here. A chain goes in
// CHAINS; nothing else needs to know about it.

import { bestBuy } from './bestbuy.js';

export const CHAINS = {
  bestbuy: { name: 'Best Buy', check: bestBuy, key: 'BESTBUY_API_KEY', exact: false },
};

const KEEP_SOLD_OUT = 7 * 86400_000;
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
export async function checkStock({ zip, radius = 50, previous = null, env = process.env, now = Date.now(), chains = configuredChains(env), log = () => {} }) {
  const doc = { v: 1, updatedAt: now, radius, chains: {}, stores: [], products: [], stock: [] };
  for (const id of chains) {
    const chain = CHAINS[id];
    try {
      const fresh = await chain.check({ zip, radius, key: chain.key ? env[chain.key] : null });
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
  return doc;
}

/** Error text safe to publish: no keys, one line. */
export function scrub(message, env = process.env) {
  let s = String(message ?? 'failed');
  for (const c of Object.values(CHAINS)) if (c.key && env[c.key]) s = s.split(env[c.key]).join('•••');
  return s.replace(/apiKey=[^&\s]+/gi, 'apiKey=•••').replace(/\s+/g, ' ').slice(0, 160);
}
