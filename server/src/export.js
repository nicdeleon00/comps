// Static export: writes the API's answers as JSON files so the website and the
// iPhone app can run from plain static hosting (GitHub Pages) with no server.
//
//   data/status.json, market.json, deals.json, spreads.json, sets.json
//   data/sets/<groupId>.json      every card in a set, priced
//   data/cards/<shard>.json       full card detail (history, grading, signals) for cards worth ≥ $1
//   data/index.json               compact catalog for search, scanning and pricing on the phone

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setImageMode } from './store.js';
import { safeJSON, log } from './lib/util.js';
import { reprintGroups } from './engine/printings.js';

export const SHARDS = 128;
export const shardOf = (id) => {
  const n = Number(String(id).replace(/^\D+/, ''));
  if (Number.isFinite(n)) return n % SHARDS;
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % SHARDS;
};

const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

function write(dir, file, data) {
  const path = join(dir, file);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
}

export async function exportStatic({ db, api, outDir, minDetailUsd = 1 }) {
  setImageMode('direct');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const get = (path, query = {}) => api('GET', path, query);

  const status = await get('/api/status');
  delete status.lanUrls;
  status.static = true;
  status.exportedAt = Date.now();
  write(outDir, 'status.json', status);
  write(outDir, 'market.json', await get('/api/market'));
  write(outDir, 'deals.json', await get('/api/deals', { limit: '2000' }));
  // Every spread (the website filters and re-ranks them with your own costs).
  const spreads = await get('/api/spreads', { limit: '200', sort: 'profit' });
  const all = [];
  for (let off = 0; off < spreads.total && off < 4000; off += 200) all.push(...(await get('/api/spreads', { limit: '200', sort: 'profit', offset: String(off) })).items);
  write(outDir, 'spreads.json', { items: all, total: all.length });

  const sets = await get('/api/sets');
  write(outDir, 'sets.json', sets);
  for (const s of sets.items) write(outDir, `sets/${s.id}.json`, await get(`/api/sets/${s.id}`));

  // Card detail, sharded so one card page loads one small file.
  const ids = db.all(`SELECT DISTINCT card_id FROM valuations WHERE (raw >= ? OR psa10 IS NOT NULL) AND card_id NOT LIKE 'pc:%'`, minDetailUsd).map((r) => r.card_id);
  const shards = Array.from({ length: SHARDS }, () => ({}));
  for (const id of ids) {
    const d = await get(`/api/cards/${encodeURIComponent(id)}`);
    if (!d || d.error) continue;
    // Keep files small: 120 days of history, and no holdings (those live on your devices).
    for (const v of Object.keys(d.history)) d.history[v] = d.history[v].slice(-120);
    delete d.holdings;
    delete d.watch;
    shards[shardOf(id)][id] = d;
  }
  shards.forEach((cards, i) => write(outDir, `cards/${i}.json`, { cards }));

  // Compact catalog: [productId, name, setId, number, total, rarity, [[variant, raw, g9, psa10, change7d], ...]]
  // Sets: [name, code, series, released, reprint (1 = reprint product; the scanner prefers originals)]
  const setRows = db.all('SELECT * FROM sets WHERE cards > 0');
  const reprints = reprintGroups(db);
  const setsMap = Object.fromEntries(setRows.map((s) => [s.id, [s.name, s.code, s.series, s.released, reprints.has(String(s.id)) ? 1 : 0]]));
  const vals = new Map();
  for (const v of db.all(`SELECT card_id, variant, raw, g9, psa10, change_7d FROM valuations WHERE card_id LIKE 'tcg:%'`)) {
    if (!vals.has(v.card_id)) vals.set(v.card_id, []);
    vals.get(v.card_id).push([v.variant, r2(v.raw), r2(v.g9), r2(v.psa10), v.change_7d == null ? null : Math.round(v.change_7d * 1000) / 1000]);
  }
  const cards = [];
  for (const c of db.all(`SELECT id, name, group_id, number, printed_total, rarity FROM cards WHERE id LIKE 'tcg:%'`)) {
    const pv = vals.get(c.id);
    if (!pv) continue;
    pv.sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
    cards.push([Number(c.id.slice(4)), c.name, String(c.group_id ?? ''), c.number, c.printed_total, c.rarity, pv]);
  }
  write(outDir, 'index.json', { v: 1, updatedAt: Date.now(), imageBase: 'https://tcgplayer-cdn.tcgplayer.com/product/', sets: setsMap, cards });

  log.info(`export: ${cards.length} cards in index, ${ids.length} detail pages, ${sets.items.length} sets → ${outDir}`);
  return { cards: cards.length, details: ids.length, sets: sets.items.length };
}

export { safeJSON };
