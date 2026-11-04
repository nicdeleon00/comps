// Price history backfill from TCGCSV's public daily archives of TCGplayer prices
// (https://tcgcsv.com/faq — free to download, back to 2024-02-08).
//
// So the site has real history from day one: daily for the last 90 days, weekly
// for the past year, and monthly before that. A batch of archives is imported on
// each refresh, newest first, and every imported day is remembered, so each
// archive is downloaded once. Points the daily refresh recorded itself are never
// overwritten.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { variantKey } from './tcgcsv.js';
import { safeJSON, log, day as isoDay } from '../lib/util.js';

const BASE = process.env.TCGCSV_ARCHIVE ?? 'https://tcgcsv.com/archive/tcgplayer';
export const FIRST_DAY = '2024-02-08';
const POKEMON = '3';
const DAY_MS = 86_400_000;

/** The history worth having, newest first: daily for 90 days, Mondays for a year, then each month's first Monday. */
export function wantedDays(now = Date.now()) {
  const out = [];
  for (let i = 1; ; i++) {
    const t = now - i * DAY_MS;
    const d = isoDay(t);
    if (d < FIRST_DAY) break;
    const date = new Date(t);
    const monday = date.getUTCDay() === 1;
    if (i <= 90 || (monday && i <= 365) || (monday && date.getUTCDate() <= 7)) out.push(d);
  }
  return out;
}

function sevenZip() {
  for (const bin of ['7z', '7za', '7zz']) {
    try { execFileSync(bin, ['i'], { stdio: 'ignore' }); return bin; } catch {}
  }
  return null;
}

/** Extracts one archive and returns the Pokémon price lists in it (one per set). */
function extractWith(bin) {
  return (file, day, dir) => {
    // Pokémon only; if the filter matches nothing (layout change), extract everything.
    try { execFileSync(bin, ['x', '-y', `-o${dir}`, file, `${day}/${POKEMON}/*`, '-r'], { stdio: 'ignore' }); } catch {}
    let root = join(dir, day, POKEMON);
    if (!existsSync(root)) {
      execFileSync(bin, ['x', '-y', `-o${dir}`, file], { stdio: 'ignore' });
      root = join(dir, day, POKEMON);
    }
    if (!existsSync(root)) return [];
    const lists = [];
    for (const group of readdirSync(root)) {
      const f = join(root, group, 'prices');
      if (existsSync(f)) lists.push(safeJSON(readFileSync(f, 'utf8'), {}).results ?? []);
    }
    return lists;
  };
}

/** Imports up to `limit` archives. Returns the number of days added. */
export async function backfillHistory(db, settings, progress = () => {}, { fetchImpl = fetch, extract, limit, now = Date.now() } = {}) {
  const max = Number(limit ?? settings.historyBackfillPerRun ?? 20);
  if (!max) return 0;
  let unpack = extract;
  if (!unpack) {
    const bin = sevenZip();
    if (!bin) { log.warn('history: 7-Zip not installed, skipping the backfill'); return 0; }
    unpack = extractWith(bin);
  }
  const done = new Set(safeJSON(db.get(`SELECT value FROM settings WHERE key = '_historyDays'`)?.value, []));
  // Days the daily refresh already recorded don't need an archive.
  for (const r of db.all(`SELECT day FROM history GROUP BY day HAVING COUNT(*) > 2000`)) done.add(r.day);
  const todo = wantedDays(now).filter((d) => !done.has(d)).slice(0, max);
  if (!todo.length) return 0;

  // Printings worth a history (the same rule as the daily refresh).
  const minUsd = Number(settings.historyMinUsd ?? 1);
  const keep = new Set(db.all(`SELECT card_id || '|' || variant AS k FROM valuations WHERE raw >= ? OR psa10 IS NOT NULL`, minUsd).map((r) => r.k));
  const sql = `INSERT OR IGNORE INTO history (card_id, variant, day, raw) VALUES (?, ?, ?, ?)`;
  let added = 0;
  for (const [i, day] of todo.entries()) {
    const dir = mkdtempSync(join(tmpdir(), 'comps-history-'));
    try {
      const res = await fetchImpl(`${BASE}/prices-${day}.ppmd.7z`, { signal: AbortSignal.timeout(120_000) });
      if (res.status === 404) { done.add(day); continue; } // no archive that day
      if (!res.ok) { log.warn(`history: ${day} answered ${res.status}; trying again next run`); break; }
      const file = join(dir, `prices-${day}.ppmd.7z`);
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      const lists = unpack(file, day, dir);
      let rows = 0;
      db.tx(() => {
        for (const list of lists) {
          for (const p of list) {
            const raw = p.marketPrice ?? p.midPrice;
            if (!(raw > 0)) continue;
            const id = `tcg:${p.productId}`;
            const variant = variantKey(p.subTypeName);
            if (!keep.has(`${id}|${variant}`)) continue;
            rows += db.run(sql, id, variant, day, Math.round(raw * 100) / 100).changes;
          }
        }
      });
      done.add(day);
      added++;
      log.info(`history: ${day} · ${rows} prices`);
    } catch (e) {
      log.warn(`history: ${day} failed (${e.message}); trying again next run`);
      break;
    } finally {
      rmSync(dir, { recursive: true, force: true });
      // Remember every finished day (including ones with no archive) right away.
      db.run(`INSERT INTO settings(key, value) VALUES('_historyDays', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, JSON.stringify([...done].filter((d) => d >= FIRST_DAY).sort()));
      progress(i + 1, todo.length);
    }
  }
  const left = wantedDays(now).filter((d) => !done.has(d)).length;
  log.info(`history: added ${added} day${added === 1 ? '' : 's'} · ${left} still to fetch`);
  return added;
}
