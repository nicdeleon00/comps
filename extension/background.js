// Loads the Comps price index and matches the listings the Marketplace page
// sends over. Matched listings are kept in this browser (chrome.storage) and
// shown on the Comps Deals page.

import { buildLookup, matchListing } from './matcher.js';

const DEFAULT_SITE = 'https://nicdeleon00.github.io/comps/';
const MAX_FINDS = 500;
const SIX_HOURS = 6 * 3600 * 1000;

let lookup = null;
let loadedAt = 0;
let loading = null;

async function site() {
  const { site } = await chrome.storage.local.get('site');
  return site || DEFAULT_SITE;
}

async function getLookup() {
  if (lookup && Date.now() - loadedAt < SIX_HOURS) return lookup;
  if (!loading) {
    loading = (async () => {
      const res = await fetch(new URL('data/index.json', await site()));
      if (!res.ok) throw new Error(`Couldn't load Comps prices (HTTP ${res.status})`);
      lookup = buildLookup(await res.json());
      loadedAt = Date.now();
      return lookup;
    })().finally(() => { loading = null; });
  }
  return loading;
}

async function saveFinds(found) {
  if (!found.length) return;
  const { finds = [] } = await chrome.storage.local.get('finds');
  const byId = new Map(finds.map((f) => [f.id, f]));
  for (const f of found) byId.set(f.id, { ...byId.get(f.id), ...f, firstSeen: byId.get(f.id)?.firstSeen ?? f.seenAt });
  const list = [...byId.values()].sort((a, b) => b.seenAt - a.seenAt).slice(0, MAX_FINDS);
  await chrome.storage.local.set({ finds: list });
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'match') {
    (async () => {
      const { enabled = true } = await chrome.storage.local.get('enabled');
      if (!enabled) return reply({ off: true, results: [] });
      const lk = await getLookup();
      const now = Date.now();
      const results = msg.listings.map((l) => ({ id: l.id, match: matchListing(lk, l) }));
      await saveFinds(results.filter((r) => r.match?.confident).map((r) => {
        const l = msg.listings.find((x) => x.id === r.id);
        return { id: l.id, url: l.url, title: l.title, price: l.price, location: l.location ?? null, image: l.image ?? null, seenAt: now, ...r.match };
      }));
      reply({ results });
    })().catch((e) => reply({ error: e.message, results: [] }));
    return true; // answers asynchronously
  }
  return false;
});
