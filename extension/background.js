// The extension's brain: loads Comps prices, prices the listings Facebook pages
// send over, runs searches (on demand, or on a timer in a background tab), alerts
// you to new deals, shares what it finds with Comps, and keeps itself up to date.

import { buildLookup, matchListing } from './matcher.js';

const SITE = 'https://nicdeleon00.github.io/comps/';
const HOUR = 3600_000;
const MAX_FINDS = 1500;
const MAX_SEARCHES = 10;

const PRESETS = [
  { id: 'cards', label: 'Pokémon cards', queries: ['pokemon cards', 'pokemon card'] },
  { id: 'graded', label: 'Graded slabs', queries: ['psa pokemon', 'cgc pokemon', 'pokemon slab'] },
  { id: 'chase', label: 'Alt arts & SIRs', queries: ['pokemon alt art', 'pokemon sir', 'pokemon illustration rare'] },
  { id: 'charizard', label: 'Charizard', queries: ['charizard card'] },
  { id: 'eevee', label: 'Eeveelutions', queries: ['umbreon card', 'eevee card', 'espeon card', 'sylveon card'] },
  { id: 'pikachu', label: 'Pikachu', queries: ['pikachu card'] },
  { id: 'vintage', label: 'Vintage', queries: ['base set pokemon', '1st edition pokemon', 'vintage pokemon card'] },
];
const DEFAULTS = { enabled: true, share: true, presets: ['cards', 'graded'], custom: '', minPrice: '', maxPrice: '', days: '7', monitor: false, every: 30 };

const settings = async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) });

/** The Marketplace searches the settings describe: newest listings first, with the price and age filters. */
function searches(s) {
  const custom = String(s.custom ?? '').split(',').map((q) => q.trim()).filter(Boolean);
  const queries = [...new Set([...custom, ...s.presets.flatMap((id) => PRESETS.find((p) => p.id === id)?.queries ?? [])])].slice(0, MAX_SEARCHES);
  return queries.map((q) => {
    const u = new URL('https://www.facebook.com/marketplace/search/');
    u.searchParams.set('query', q);
    u.searchParams.set('sortBy', 'creation_time_descend');
    u.searchParams.set('exact', 'false');
    if (Number(s.minPrice) > 0) u.searchParams.set('minPrice', String(Math.round(s.minPrice)));
    if (Number(s.maxPrice) > 0) u.searchParams.set('maxPrice', String(Math.round(s.maxPrice)));
    if (s.days) u.searchParams.set('daysSinceListed', String(s.days));
    return { q, url: u.href };
  });
}

// ---------------------------------------------------------------- status (shown in the popup)

/** Adds to the running counters (numbers) and replaces the rest (last error, last seen). */
async function bump(patch) {
  const { stats = {} } = await chrome.storage.local.get('stats');
  const next = { ...stats };
  for (const [k, v] of Object.entries(patch)) next[k] = typeof v === 'number' && k !== 'lastSeen' ? (stats[k] ?? 0) + v : v;
  await chrome.storage.local.set({ stats: next });
}

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
  })().catch(async (e) => { await bump({ lastError: e.message }); throw e; }).finally(() => { loading = null; });
  return loading;
}

// ---------------------------------------------------------------- finds + sharing

/** Saves priced listings; returns the ids of deals that weren't known before. */
async function saveFinds(found) {
  if (!found.length) return [];
  const { finds = [] } = await chrome.storage.local.get('finds');
  const byId = new Map(finds.map((f) => [f.id, f]));
  const fresh = found.filter((f) => f.deal && !byId.get(f.id)?.deal).map((f) => f.id);
  for (const f of found) byId.set(f.id, { ...f, firstSeen: byId.get(f.id)?.firstSeen ?? f.seenAt });
  await chrome.storage.local.set({ finds: [...byId.values()].sort((a, b) => b.seenAt - a.seenAt).slice(0, MAX_FINDS) });
  return fresh;
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
    const res = await fetch(`${config.supabaseUrl}/rest/v1/rpc/report_listings`, {
      method: 'POST',
      headers: { apikey: config.supabaseAnonKey, Authorization: `Bearer ${config.supabaseAnonKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: rows.slice(i, i + 100) }),
    }).catch(() => null);
    if (res?.ok) await bump({ shared: Math.min(100, rows.length - i) });
  }
}

async function price(listings, sender) {
  const lk = await getLookup();
  const now = Date.now();
  const results = listings.map((l) => {
    let match = matchListing(lk, l);
    // The card number is often only in the description.
    if (l.hint && !match?.confident) match = matchListing(lk, { ...l, title: `${l.title} ${l.hint}` }) ?? match;
    return { id: l.id, match };
  });
  const found = [];
  for (const r of results) {
    const l = listings.find((x) => x.id === r.id);
    if (r.match && !r.match.fake && l.price) found.push({ ...l, ...r.match, seenAt: now });
  }
  const newDeals = await saveFinds(found);
  share(found);
  await bump({ seen: listings.length, fromFacebook: listings.filter((l) => l.structured).length, priced: found.length, lastSeen: now });
  const scan = await getScan();
  if (scan?.running && scan.tabId === sender.tab?.id && newDeals.length) await setScan({ ...scan, newDeals: [...new Set([...scan.newDeals, ...newDeals])] });
  return results;
}

// ---------------------------------------------------------------- searches
// A run opens each search in turn: "search" in a tab you watch (it scrolls deep),
// "monitor" in a background tab on a timer (just the newest listings), then alerts.

const getScan = async () => (await chrome.storage.session.get('scan')).scan ?? null;
const setScan = (scan) => chrome.storage.session.set({ scan });

async function startScan({ mode = 'search', tabId } = {}) {
  const list = searches(await settings());
  if (!list.length) return null;
  tabId ??= (await chrome.tabs.create({ url: 'about:blank', active: mode === 'search' })).id;
  const scan = { mode, tabId, list, i: 0, running: true, priced: 0, deals: 0, ids: [], dealIds: [], newDeals: [], startedAt: Date.now(), note: null };
  // Saved before the page loads, so the page knows it's part of this run.
  await setScan(scan);
  await chrome.tabs.update(tabId, { url: list[0].url, ...(mode === 'search' ? { active: true } : {}) });
  return scan;
}

async function finish(scan, note = null) {
  Object.assign(scan, { running: false, endedAt: Date.now(), note });
  await setScan(scan);
  await chrome.storage.local.set({ lastScan: { at: Date.now(), mode: scan.mode, priced: scan.priced, deals: scan.deals, newDeals: scan.newDeals.length } });
  if (scan.mode === 'monitor') {
    if (note !== 'closed') chrome.tabs.remove(scan.tabId).catch(() => {});
    notify(scan.newDeals);
  }
  return scan;
}

async function nextSearch() {
  const scan = await getScan();
  if (!scan?.running) return scan;
  scan.i += 1;
  if (scan.i >= scan.list.length) return finish(scan);
  await setScan(scan);
  await chrome.tabs.update(scan.tabId, { url: scan.list[scan.i].url });
  return scan;
}

async function stopScan(note) {
  const scan = await getScan();
  return scan?.running ? finish(scan, note) : scan;
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const scan = await getScan();
  if (scan?.running && scan.tabId === tabId) finish(scan, 'closed');
});

// ---------------------------------------------------------------- alerts

const money = (v) => (v >= 100 ? `$${Math.round(v).toLocaleString()}` : `$${Number(v).toFixed(2)}`);

async function notify(ids) {
  if (!ids.length) return;
  const { finds = [] } = await chrome.storage.local.get('finds');
  const deals = finds.filter((f) => ids.includes(f.id)).sort((a, b) => ((b.value ?? b.low) - b.price) - ((a.value ?? a.low) - a.price));
  if (!deals.length) return;
  const top = deals[0];
  await chrome.notifications.create(`deal:${top.id}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: deals.length === 1 ? `Marketplace deal: ${top.card.name}` : `${deals.length} new Marketplace deals`,
    message: `${top.card.name}${top.grade ? ` ${top.grade}` : ''} for ${money(top.price)} (worth ${money(top.value ?? top.low)}, ${Math.round(top.discount * 100)}% under)${top.location ? ` · ${top.location}` : ''}`,
    priority: 2,
  });
  const { unseen = 0 } = await chrome.storage.local.get('unseen');
  await chrome.storage.local.set({ unseen: unseen + deals.length });
  badge();
}

chrome.notifications.onClicked.addListener((id) => {
  const listing = /^deal:(\d+)$/.exec(id)?.[1];
  chrome.tabs.create({ url: listing ? `https://www.facebook.com/marketplace/item/${listing}/` : new URL('deals?kind=marketplace', SITE).href });
  chrome.notifications.clear(id);
});

async function badge() {
  const { unseen = 0, update = null } = await chrome.storage.local.get(['unseen', 'update']);
  chrome.action.setBadgeBackgroundColor({ color: update ? '#0071e3' : '#34c759' });
  chrome.action.setBadgeText({ text: update ? 'NEW' : unseen ? String(Math.min(unseen, 99)) : '' });
}

// ---------------------------------------------------------------- timers: automatic checks + updates

async function schedule() {
  const s = await settings();
  await chrome.alarms.clear('monitor');
  if (s.monitor) chrome.alarms.create('monitor', { delayInMinutes: 1, periodInMinutes: Math.max(10, Number(s.every) || 30) });
  if (!(await chrome.alarms.get('update'))) chrome.alarms.create('update', { delayInMinutes: 1, periodInMinutes: 360 });
}

const newer = (a, b) => {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
};

/** Looks for a new version on the Comps site; the update page installs it (by itself once set up). */
async function checkUpdate({ quiet = false } = {}) {
  const remote = await fetch(new URL('extension/version.json', SITE), { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const version = remote?.version && newer(remote.version, chrome.runtime.getManifest().version) ? remote.version : null;
  await chrome.storage.local.set({ update: version });
  badge();
  if (!version || quiet) return version;
  const { offered } = await chrome.storage.local.get('offered');
  if (offered !== version) {
    await chrome.storage.local.set({ offered: version });
    chrome.tabs.create({ url: chrome.runtime.getURL('update.html?auto=1'), active: false });
  }
  return version;
}

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === 'update') checkUpdate();
  if (a.name === 'monitor') {
    const s = await settings();
    if (s.monitor && s.enabled && !(await getScan())?.running) startScan({ mode: 'monitor' });
  }
});

chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && (c.monitor || c.every)) schedule();
});

// ---------------------------------------------------------------- messages

const handlers = {
  async match({ listings }, sender) {
    if (!(await settings()).enabled) return { off: true, results: [] };
    return { results: await price(listings, sender) };
  },
  async 'scan:get'(_msg, sender) {
    const scan = await getScan();
    return { scan, mine: Boolean(scan?.running && sender.tab && scan.tabId === sender.tab.id) };
  },
  'scan:start': (msg, sender) => startScan({ mode: 'search', tabId: msg.here ? sender.tab?.id : undefined }),
  'scan:check': () => startScan({ mode: 'monitor' }),
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
  'scan:next': () => nextSearch(),
  'scan:stop': (msg) => stopScan(msg.note ?? 'stopped'),
  async summary() {
    const [stored, s, scan] = await Promise.all([chrome.storage.local.get(['finds', 'lastScan', 'stats', 'update']), settings(), getScan()]);
    return { ...stored, finds: stored.finds ?? [], stats: stored.stats ?? {}, settings: s, presets: PRESETS, scan, site: SITE, version: chrome.runtime.getManifest().version, searches: searches(s) };
  },
  async 'settings:set'({ patch }) {
    await chrome.storage.local.set(patch);
    return settings();
  },
  async seen() {
    await chrome.storage.local.set({ unseen: 0 });
    badge();
  },
  async 'finds:remove'({ id }) {
    const { finds = [] } = await chrome.storage.local.get('finds');
    await chrome.storage.local.set({ finds: finds.filter((f) => f.id !== id) });
  },
  'finds:clear': () => chrome.storage.local.set({ finds: [] }),
  'update:check': () => checkUpdate({ quiet: true }),
  'open:update': () => chrome.tabs.create({ url: chrome.runtime.getURL('update.html') }),
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const fn = handlers[msg?.type];
  if (!fn) return false;
  Promise.resolve(fn(msg, sender)).then(reply, (e) => reply({ error: e.message }));
  return true; // answers asynchronously
});

chrome.runtime.onStartup.addListener(() => { schedule(); badge(); });
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  schedule();
  badge();
  // Facebook tabs that were already open start working without a reload.
  for (const tab of await chrome.tabs.query({ url: ['https://www.facebook.com/*', 'https://web.facebook.com/*'] })) {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['fb-hook.js'], world: 'MAIN' }).catch(() => {});
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['marketplace.js'] }).catch(() => {});
  }
  // First install: a one-time welcome that also turns on automatic updates.
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('update.html?welcome=1') });
  if (reason === 'update') {
    await chrome.storage.local.set({ update: null });
    badge();
    chrome.notifications.create('updated', { type: 'basic', iconUrl: 'icons/icon128.png', title: 'Comps for Marketplace updated', message: `Now on version ${chrome.runtime.getManifest().version}.` });
  }
});
