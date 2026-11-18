// Scheduled stock check: node server/src/stock/cli.js <out file> [previous file]
// Also keeps history.json (every change, for months) next to the out file, starting from previous-history.json.
//
//   STOCK_ZIP          the ZIP code to look around (required)
//   STOCK_RADIUS       miles, default 50
//   STOCK_LAT, STOCK_LON  where that ZIP is (Dollar General looks around a point)
//   BESTBUY_API_KEY    Best Buy's free developer key
//   STOCK_BROWSER=1    Chrome is on this machine: check Dollar General
//   STOCK_NTFY_TOPIC   push alerts for restocks, through the ntfy app subscribed to this topic
//   STOCK_ALERT_MILES  only alert for stores this close (default 15)
//   STOCK_BAD_STORES   store numbers whose counts are wrong, separated by commas
//   STOCK_SITE         the page an alert opens
//
// Writes nothing when no chain is set up, so the last file stays as it is.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkStock, configuredChains, findRestocks, restockMessage } from './index.js';
import { updateHistory } from './history.js';

const [out, prev] = process.argv.slice(2);
const zip = (process.env.STOCK_ZIP ?? '').trim();
const radius = Math.min(250, Math.max(5, Number(process.env.STOCK_RADIUS) || 50));
const chains = configuredChains();

if (!out) { console.error('usage: cli.js <out file> [previous file]'); process.exit(2); }
if (!/^\d{5}$/.test(zip) || !chains.length) {
  console.log(`Stock checks aren't set up (${!chains.length ? 'no store key' : 'no STOCK_ZIP'}). Nothing written.`);
  process.exit(0);
}

let previous = null;
try { previous = JSON.parse(readFileSync(prev, 'utf8')); } catch { /* first run */ }

const num = (v) => (v == null || v === '' ? null : Number(v));
const badStores = (process.env.STOCK_BAD_STORES ?? '').split(/[\s,]+/).filter(Boolean);
const doc = await checkStock({ zip, radius, lat: num(process.env.STOCK_LAT), lon: num(process.env.STOCK_LON), badStores, previous, log: (m) => console.log(m) });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(doc));
let oldHistory = null;
try { oldHistory = JSON.parse(readFileSync(join(dirname(prev ?? out), 'previous-history.json'), 'utf8')); } catch { /* first run */ }
const history = updateHistory(oldHistory, doc);
writeFileSync(join(dirname(out), 'history.json'), JSON.stringify(history));
console.log(`history.json: ${Object.keys(history.series).length} store/product series`);
const inStock = doc.stock.filter((e) => e.in).length;
console.log(`stock.json: ${doc.stores.length} stores, ${doc.products.length} products, ${inStock} in stock`);
const flagged = doc.stores.filter((s) => s.suspect).length;
if (flagged) console.log(`${flagged} store${flagged === 1 ? '' : 's'} marked as having wrong counts`);

// Push alert for what just came in.
const restocks = findRestocks(previous, doc, { miles: Number(process.env.STOCK_ALERT_MILES) || 15 });
console.log(`${restocks.length} restock${restocks.length === 1 ? '' : 's'} to alert`);
const topic = (process.env.STOCK_NTFY_TOPIC ?? '').trim();
if (restocks.length && topic && process.env.STOCK_NO_ALERTS !== '1') {
  const { title, body } = restockMessage(restocks);
  try {
    // ntfy's JSON form (the topic goes in the body, so names with accents arrive intact).
    const res = await fetch(process.env.NTFY_BASE ?? 'https://ntfy.sh', {
      method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, title, message: body, tags: ['shopping_cart'], priority: 4, ...(process.env.STOCK_SITE ? { click: process.env.STOCK_SITE } : {}) }),
    });
    console.log(`alert sent: ${res.status}`);
  } catch (err) { console.log(`alert not sent: ${err.name}`); }
}

// A run where every chain failed is a failed run (the old file is still published as it was).
for (const c of Object.values(doc.chains)) if (!c.ok) console.log(`${c.name} not checked: ${c.error}`);
if (Object.values(doc.chains).every((c) => !c.ok)) process.exit(1);
