// Reads a product page and says whether it can be bought right now.
// Uses the structured data stores publish for search engines (schema.org JSON-LD,
// Open Graph product tags), and Best Buy's official API when you add a key.
// It only reads pages: no logins, no checkout, no getting around bot protection.

export const STORES = {
  target: { name: 'Target', host: /(^|\.)target\.com$/ },
  walmart: { name: 'Walmart', host: /(^|\.)walmart\.com$/ },
  bestbuy: { name: 'Best Buy', host: /(^|\.)bestbuy\.com$/ },
  pokemoncenter: { name: 'Pokémon Center', host: /(^|\.)pokemoncenter\.com$/ },
  gamestop: { name: 'GameStop', host: /(^|\.)gamestop\.com$/ },
  amazon: { name: 'Amazon', host: /(^|\.)amazon\.com$/ },
  samsclub: { name: "Sam's Club", host: /(^|\.)samsclub\.com$/ },
  costco: { name: 'Costco', host: /(^|\.)costco\.com$/ },
  tcgplayer: { name: 'TCGplayer', host: /(^|\.)tcgplayer\.com$/ },
};

export function storeOf(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const [id, s] of Object.entries(STORES)) if (s.host.test(host)) return id;
    return host.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

export const storeName = (id) => STORES[id]?.name ?? id;

// in_stock and preorder can be bought now; the rest can't (online).
export const BUYABLE = new Set(['in_stock', 'preorder']);

function availability(value) {
  const v = String(value ?? '').toLowerCase();
  if (!v) return null;
  if (/instoreonly/.test(v)) return 'in_store';
  if (/preorder|presale/.test(v)) return 'preorder';
  if (/instock|onlineonly|limitedavailability|in_stock|^in stock$/.test(v)) return 'in_stock';
  if (/outofstock|soldout|discontinued|backorder|out_of_stock|oos|out of stock/.test(v)) return 'out_of_stock';
  return null;
}

const decode = (s) => String(s ?? '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

function* walk(node) {
  if (Array.isArray(node)) { for (const n of node) yield* walk(n); return; }
  if (!node || typeof node !== 'object') return;
  yield node;
  for (const k of ['@graph', 'mainEntity', 'itemListElement', 'hasVariant', 'isVariantOf']) if (node[k]) yield* walk(node[k]);
}

const isProduct = (n) => [].concat(n['@type'] ?? []).some((t) => /Product|ProductGroup|IndividualProduct/i.test(String(t)));

function offersOf(o) {
  const out = [];
  for (const x of [].concat(o ?? [])) {
    if (!x || typeof x !== 'object') continue;
    out.push(x);
    if (x.offers) out.push(...offersOf(x.offers));
  }
  return out;
}

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Signs of a bot wall / captcha page instead of the product. */
export function looksBlocked(status, html) {
  if (status === 403 || status === 429 || status === 503) return true;
  return /px-captcha|captcha-delivery|g-recaptcha|_Incapsula_Resource|Access Denied|Robot or human\?|Pardon Our Interruption|are you a robot/i.test(html.slice(0, 20000));
}

/** Parses a product page. Returns { state, price, title, via }. */
export function parseProductPage(html) {
  const result = { state: 'unknown', price: null, title: null, via: null };
  const states = [];
  const prices = [];

  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    for (const node of walk(data)) {
      if (!isProduct(node)) continue;
      result.title ??= node.name ? decode(node.name) : null;
      for (const offer of offersOf(node.offers)) {
        const s = availability(offer.availability);
        const p = num(offer.price ?? offer.lowPrice ?? offer.priceSpecification?.price);
        if (s) states.push({ s, p });
        else if (p) prices.push(p);
      }
    }
  }
  if (states.length) result.via = 'structured data';

  if (!states.length) {
    const meta = (prop) => {
      const re = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${prop}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name|itemprop)=["']${prop}["']`, 'i');
      const m = html.match(re);
      return m ? decode(m[1] ?? m[2]) : null;
    };
    const s = availability(meta('product:availability') ?? meta('og:availability') ?? meta('availability'));
    const p = num(meta('product:price:amount') ?? meta('og:price:amount') ?? meta('price'));
    if (s) { states.push({ s, p }); result.via = 'product tags'; }
    else if (p) prices.push(p);
    result.title ??= meta('og:title');
  }

  if (states.length) {
    // Any buyable offer wins; report its lowest price.
    const order = ['in_stock', 'preorder', 'in_store', 'out_of_stock'];
    states.sort((a, b) => order.indexOf(a.s) - order.indexOf(b.s) || (a.p ?? Infinity) - (b.p ?? Infinity));
    result.state = states[0].s;
    result.price = states[0].p ?? prices[0] ?? null;
  } else {
    result.price = prices[0] ?? null;
  }
  if (!result.title) {
    const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (t) result.title = decode(t[1]).replace(/\s*[|:–-]\s*(Target|Walmart\.com|Best Buy|Pokémon Center.*|GameStop|Amazon\.com.*)$/i, '');
  }
  return result;
}

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** Best Buy's official Products API (free key from developer.bestbuy.com). */
async function checkBestBuy(url, key) {
  const sku = (url.match(/skuId=(\d+)/) ?? url.match(/\/(\d{6,8})\.p/))?.[1];
  if (!sku) return null;
  const api = `https://api.bestbuy.com/v1/products(sku=${sku})?apiKey=${encodeURIComponent(key)}&show=name,salePrice,onlineAvailability,orderable&format=json`;
  const res = await fetch(api, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return { state: res.status === 403 ? 'blocked' : 'error', price: null, title: null, via: 'Best Buy API', http: res.status };
  const p = (await res.json()).products?.[0];
  if (!p) return { state: 'unknown', price: null, title: null, via: 'Best Buy API', http: res.status };
  const orderable = String(p.orderable ?? '').toLowerCase();
  const state = orderable === 'preorder' ? 'preorder' : p.onlineAvailability ? 'in_stock' : 'out_of_stock';
  return { state, price: num(p.salePrice), title: p.name ?? null, via: 'Best Buy API', http: res.status };
}

/** Checks one product link. Never throws. */
export async function checkProduct(url, { bestBuyKey, fetchImpl = fetch } = {}) {
  const store = storeOf(url);
  try {
    if (store === 'bestbuy' && bestBuyKey) {
      const r = await checkBestBuy(url, bestBuyKey);
      if (r) return { ...r, store };
    }
    const res = await fetchImpl(url, { headers: BROWSER_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    const html = await res.text();
    if (looksBlocked(res.status, html)) {
      return { state: 'blocked', price: null, title: null, via: null, http: res.status, store, note: 'The store showed a bot check instead of the page' };
    }
    if (!res.ok) return { state: 'error', price: null, title: null, via: null, http: res.status, store, note: `HTTP ${res.status}` };
    const parsed = parseProductPage(html);
    return {
      ...parsed,
      http: res.status,
      store,
      note: parsed.state !== 'unknown' ? undefined
        : store === 'target' ? "Target doesn't put stock on its product pages, so the monitor can't read it"
        : "Couldn't find stock info on the page (the store may load it in the browser)",
    };
  } catch (e) {
    return { state: 'error', price: null, title: null, via: null, http: 0, store, note: e.name === 'TimeoutError' ? 'Timed out' : e.message };
  }
}
