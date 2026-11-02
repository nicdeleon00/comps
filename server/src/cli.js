// Command line for scheduled runs (GitHub Actions) and local use.
//
//   node server/src/cli.js refresh [--force]   prices + listings + recompute
//   node server/src/cli.js export <dir>        write the static site data
//   node server/src/cli.js demo <dir>          sample data → static export (for previews)

import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import { createSettings } from './settings.js';
import { createJobs } from './jobs.js';
import { createApi } from './api.js';
import { exportStatic } from './export.js';
import { seedDemo } from './demo.js';
import { log } from './lib/util.js';

const here = dirname(fileURLToPath(import.meta.url));
const [cmd, arg] = process.argv.slice(2);
const force = process.argv.includes('--force');
const DATA_DIR = resolve(process.env.DATA_DIR ?? join(here, '../../data'));

const db = openDatabase(cmd === 'demo' ? ':memory:' : DATA_DIR);
const settings = createSettings(db);
const jobs = createJobs(db, settings);
const api = createApi({ db, settings, jobs });

async function main() {
  if (cmd === 'refresh') {
    const s = settings.get();
    const last = db.get(`SELECT MAX(finished_at) t FROM jobs WHERE name = 'pokemon' AND status = 'ok'`)?.t ?? 0;
    const due = force || Date.now() - last > (Number(s.refreshHours) || 12) * 3600_000 - 15 * 60_000;
    if (due) await jobs.runCatalog();
    else log.info(`catalog refreshed ${Math.round((Date.now() - last) / 3600_000)}h ago — skipping, recomputing only`);
    await jobs.runListings();
    if (!due) jobs.recompute();
    const failed = db.all(`SELECT name, message FROM jobs WHERE status = 'error'`);
    for (const f of failed) log.warn(`job ${f.name} failed: ${f.message}`);
    const n = db.get('SELECT COUNT(*) n FROM valuations').n;
    if (!n) throw new Error('no prices after refresh');
    log.info(`refresh done: ${n} priced printings`);
  } else if (cmd === 'export') {
    if (!arg) throw new Error('usage: cli.js export <dir>');
    await exportStatic({ db, api, outDir: resolve(arg) });
  } else if (cmd === 'demo') {
    if (!arg) throw new Error('usage: cli.js demo <dir>');
    seedDemo(db, settings);
    jobs.recompute();
    await exportStatic({ db, api, outDir: resolve(arg) });
  } else {
    console.log('usage: cli.js refresh [--force] | export <dir> | demo <dir>');
    process.exitCode = 2;
  }
}

main()
  .catch((err) => { log.error(err.stack ?? err.message); process.exitCode = 1; })
  .finally(() => {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
    db.close();
  });
