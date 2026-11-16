// Scheduled stock check: node server/src/stock/cli.js <out file> [previous file]
//
//   STOCK_ZIP          the ZIP code to look around (required)
//   STOCK_RADIUS       miles, default 50
//   STOCK_LAT, STOCK_LON  where that ZIP is (Dollar General looks around a point)
//   BESTBUY_API_KEY    Best Buy's free developer key
//   STOCK_BROWSER=1    Chrome is on this machine: check Dollar General
//
// Writes nothing when no chain is set up, so the last file stays as it is.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { checkStock, configuredChains } from './index.js';

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
const doc = await checkStock({ zip, radius, lat: num(process.env.STOCK_LAT), lon: num(process.env.STOCK_LON), previous, log: (m) => console.log(m) });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(doc));
const inStock = doc.stock.filter((e) => e.in).length;
console.log(`stock.json: ${doc.stores.length} stores, ${doc.products.length} products, ${inStock} in stock`);
// A run where every chain failed is a failed run (the old file is still published as it was).
for (const c of Object.values(doc.chains)) if (!c.ok) console.log(`${c.name} not checked: ${c.error}`);
if (Object.values(doc.chains).every((c) => !c.ok)) process.exit(1);
