// The extension's brain: loads Comps prices, prices the listings Marketplace
// pages send over, runs one-click scans, and shares what it finds with Comps.

import { buildLookup, matchListing } from './matcher.js';

const SITE = 'https://nicdeleon00.github.io/comps/';
const DEFAULTS = { enabled: true, share: true, queries: ['pokemon cards', 'pokemon psa'] };
const MAX_FINDS = 1000;
const HOUR = 3600_000;

const settings = async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) });
const searchUrl = (q) => `https://www.facebook.com/marketplace/search/?query=${encodeURIComponent(q)}&sortBy=creation_time_descend&exact=false`;

// ---------------------------------------------------------------- prices

let lookup = null;
let lookupAt = 0;
let loading = null;

/** The price index, cached so a sleeping/waking worker doesn't download it again. */
async function getLookup() {
  if (lookup && Date.now() - lookupAt < 6 * HOUR) return lookup;
  loading ??= (async () => {
    const url = new URL('data/index.json', SITE).href;
    const cache = await caches.open('comps');
    const { indexAt = 0 } = await chrome.storage.local.get('indexAt');
    let res = await cache.match(url);
    if (!res || Date.now() - indexAt > 6 * HOUR) {
      const fresh = await fetch(url, { cache: 'no-cache' }).catch(() => null);
      if (fresh?.ok) {
        await cache.put(url, fresh.clone());
        await chrome.storage.local.set({ indexAt: Date.now() });
        res = fresh;
      }
    }
    if (!res) throw new Error("Couldn't load Comps prices. Check your connection.");
    lookup = buildLookup(await res.json());
    lookupAt = Date.now();
    return lookup;
  })().finally(() => { loading = null; });
  return loading;
}

// ---------------------------------------------------------------- finds + sharing

async function saveFinds(found) {
  if (!found.length) return;
  const { finds = [] } = await chrome.storage.local.get('finds');
  const byId = new Map(finds.map((f) => [f.id, f]));
  for (const f of found) byId.set(f.id, { ...f, firstSeen: byId.get(f.id)?.firstSeen ?? f.seenAt });
  await chrome.storage.local.set({ finds: [...byId.values()].sort((a, b) => b.seenAt - a.seenAt).slice(0, MAX_FINDS) });
}

let config = null;
async function share(found) {
  if (!found.length || !(await settings()).share) return;
  config ??= await fetch(new URL('config.json', SITE), { cache: 'no-cache' }).then((r) => r.json()).catch(() => null);
  if (!config?.supabaseUrl || !config?.supabaseAnonKey) return;
  const rows = found.map((f) => ({
    id: `fb:${f.id}`, card_id: f.card.id, variant: f.variant, grade: f.grade, title: f.title, price: f.price,
    location: f.location, confident: f.confident, status: f.status,
  }));
  for (let i = 0; i < rows.length; i += 100) {
    await fetch(`${config.supabaseUrl}/rest/v1/rpc/report_listings`, {
      method: 'POST',
      headers: { apikey: config.supabaseAnonKey, Authorization: `Bearer ${config.supabaseAnonKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: rows.slice(i, i + 100) }),
    }).catch(() => {});
  }
}

async function price(listings) {
  const lk = await getLookup();
  const now = Date.now();
  const results = listings.map((l) => {
    let match = matchListing(lk, l);
    // An open listing can add the card number from its description.
    if (l.hint && !match?.confident) match = matchListing(lk, { ...l, title: `${l.title} ${l.hint}` }) ?? match;
    return { id: l.id, match };
  });
  const found = [];
  for (const r of results) {
    const l = listings.find((x) => x.id === r.id);
    if (r.match && l.price) found.push({ ...l, ...r.match, seenAt: now });
  }
  await saveFinds(found);
  share(found);
  return results;
}

// ---------------------------------------------------------------- one-click scans
// A scan opens Marketplace searches (newest listings first) one after another;
// the page scrolls itself and prices everything. State lives in session storage
// so it survives the worker going to sleep.

const getScan = async () => (await chrome.storage.session.get('scan')).scan ?? null;
const setScan = (scan) => chrome.storage.session.set({ scan });

async function startScan(tabId) {
  const { queries } = await settings();
  const list = queries.map((q) => q.trim()).filter(Boolean);
  if (!list.length) return null;
  const url = searchUrl(list[0]);
  if (tabId) await chrome.tabs.update(tabId, { url, active: true });
  else tabId = (await chrome.tabs.create({ url, active: true })).id;
  const scan = { tabId, queries: list, qi: 0, running: true, priced: 0, deals: 0, ids: [], dealIds: [], startedAt: Date.now(), note: null };
  await setScan(scan);
  return scan;
}

async function nextQuery() {
  const scan = await getScan();
  if (!scan?.running) return scan;
  scan.qi += 1;
  if (scan.qi >= scan.queries.length) {
    Object.assign(scan, { running: false, endedAt: Date.now() });
    await chrome.storage.local.set({ lastScan: { at: Date.now(), priced: scan.priced, deals: scan.deals } });
  } else {
    await chrome.tabs.update(scan.tabId, { url: searchUrl(scan.queries[scan.qi]) });
  }
  await setScan(scan);
  return scan;
}

async function stopScan(note = null) {
  const scan = await getScan();
  if (scan) await setScan({ ...scan, running: false, endedAt: Date.now(), note });
  return getScan();
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const scan = await getScan();
  if (scan?.running && scan.tabId === tabId) stopScan();
});

// ---------------------------------------------------------------- messages

const handlers = {
  async match({ listings }) {
    if (!(await settings()).enabled) return { off: true, results: [] };
    return { results: await price(listings) };
  },
  async 'scan:get'(_msg, sender) {
    const scan = await getScan();
    return { scan, mine: Boolean(scan?.running && sender.tab && scan.tabId === sender.tab.id) };
  },
  'scan:start': (msg, sender) => startScan(msg.here ? sender.tab?.id : undefined),
  async 'scan:progress'({ priced, deals }, sender) {
    const scan = await getScan();
    if (scan?.running && scan.tabId === sender.tab?.id) {
      // Searches overlap; count each listing once.
      const ids = [...new Set([...scan.ids, ...priced])];
      const dealIds = [...new Set([...scan.dealIds, ...deals])];
      await setScan({ ...scan, ids, dealIds, priced: ids.length, deals: dealIds.length });
    }
    return getScan();
  },
  'scan:next': () => nextQuery(),
  'scan:stop': (msg) => stopScan(msg.note ?? null),
  async summary() {
    const [{ finds = [], lastScan = null }, s, scan] = await Promise.all([chrome.storage.local.get(['finds', 'lastScan']), settings(), getScan()]);
    return { finds, lastScan, settings: s, scan, site: SITE };
  },
  async 'settings:set'({ patch }) {
    await chrome.storage.local.set(patch);
    return settings();
  },
  async 'finds:remove'({ id }) {
    const { finds = [] } = await chrome.storage.local.get('finds');
    await chrome.storage.local.set({ finds: finds.filter((f) => f.id !== id) });
  },
  'finds:clear': () => chrome.storage.local.set({ finds: [] }),
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const fn = handlers[msg?.type];
  if (!fn) return false;
  Promise.resolve(fn(msg, sender)).then(reply, (e) => reply({ error: e.message }));
  return true; // answers asynchronously
});

// Price tags show up on Facebook tabs that were already open when the extension was installed.
chrome.runtime.onInstalled.addListener(async () => {
  for (const tab of await chrome.tabs.query({ url: ['https://www.facebook.com/*', 'https://web.facebook.com/*'] })) {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['marketplace.js'] }).catch(() => {});
  }
});
