// Refresh pipeline. Catalog providers run every `refreshHours`; the eBay
// listing scan runs every `listingsHours`. Jobs never overlap.

import { refreshTcgcsv } from './providers/tcgcsv.js';
import { refreshTcgdex } from './providers/tcgdex.js';
import { refreshPriceCharting } from './providers/pricecharting.js';
import { refreshGraded } from './providers/ppt.js';
import { refreshFx } from './providers/fx.js';
import { ebayConfigured } from './providers/ebay.js';
import { rebuildValuations, compactHistory } from './engine/valuation.js';
import { computeSpreads } from './engine/grading.js';
import { computeSignals } from './engine/signals.js';
import { scanListings } from './engine/listings.js';
import { snapshotPortfolio } from './collection.js';
import { setJob } from './store.js';
import { log } from './lib/util.js';

export function createJobs(db, settings) {
  let running = null;
  const timers = [];

  async function step(name, fn) {
    setJob(db, name, { status: 'running', started_at: Date.now(), message: null, items: null });
    try {
      const items = await fn((done, total) => setJob(db, name, { items: done, message: total ? `${done} / ${total}` : `${done}` }));
      setJob(db, name, { status: 'ok', finished_at: Date.now(), items: typeof items === 'number' ? items : items?.kept ?? null, message: null });
      return items;
    } catch (err) {
      log.error(`${name}: ${err.message}`);
      setJob(db, name, { status: 'error', finished_at: Date.now(), message: err.message.slice(0, 300) });
      return null;
    }
  }

  /** Rebuild derived tables only (fast; no network). */
  function recompute() {
    const s = settings.get();
    const fx = s.fxEurUsd;
    const costs = settings.grading();
    const n = rebuildValuations(db, fx, { historyMinUsd: s.historyMinUsd });
    computeSpreads(db, costs);
    computeSignals(db, { fx, costs });
    snapshotPortfolio(db);
    return n;
  }

  async function runCatalog() {
    const s = settings.get();
    await step('fx', () => refreshFx(s, settings));
    await step('pokemon', (p) => refreshTcgcsv(db, s, p));
    if (s.pricechartingToken) await step('pricecharting', (p) => refreshPriceCharting(db, s, p));
    // Value first so the graded and EU steps know which cards matter most.
    await step('valuations', () => recompute());
    if (s.pptApiKey) await step('graded', (p) => refreshGraded(db, settings.get(), p));
    await step('europe', (p) => refreshTcgdex(db, settings.get(), p));
    await step('valuations', () => recompute());
    compactHistory(db);
  }

  async function runListings() {
    const s = settings.get();
    if (!ebayConfigured(s)) return;
    await step('ebay', () => scanListings(db, s));
    await step('signals', () => computeSignals(db, { fx: s.fxEurUsd, costs: settings.grading() }));
  }

  async function exclusive(name, fn) {
    if (running) return { started: false, running };
    running = name;
    try { await fn(); } finally { running = null; }
    return { started: true };
  }

  return {
    recompute,
    runCatalog,
    runListings,
    get running() { return running; },
    trigger(what = 'all') {
      const fn = what === 'listings' ? runListings : what === 'recompute' ? async () => step('valuations', () => recompute()) : async () => { await runCatalog(); await runListings(); };
      if (running) return { started: false, running };
      exclusive(what, fn).catch((e) => log.error(e));
      return { started: true };
    },
    status() {
      return { running, jobs: db.all('SELECT * FROM jobs ORDER BY name') };
    },
    start() {
      const s = settings.get();
      if (s._demo) return;
      const catalogMs = Math.max(1, Number(s.refreshHours) || 12) * 3600_000;
      const listingMs = Math.max(0.5, Number(s.listingsHours) || 3) * 3600_000;
      const lastCatalog = db.get(`SELECT MAX(finished_at) t FROM jobs WHERE name = 'valuations' AND status = 'ok'`)?.t ?? 0;
      const firstDelay = Math.max(5_000, lastCatalog + catalogMs - Date.now());
      timers.push(setTimeout(function tick() {
        exclusive('all', async () => { await runCatalog(); await runListings(); }).catch((e) => log.error(e));
        timers.push(setTimeout(tick, catalogMs));
      }, firstDelay));
      timers.push(setInterval(() => exclusive('listings', runListings).catch((e) => log.error(e)), listingMs));
      log.info(`scheduler: catalog every ${catalogMs / 3600_000}h (next in ${Math.round(firstDelay / 60_000)}m), listings every ${listingMs / 3600_000}h`);
    },
    stop() { timers.forEach((t) => clearTimeout(t)); },
  };
}
