#!/usr/bin/env node
// Comps drop monitor — runs on your computer.
//
// Watches the product links you add (website → Drops, or the app's Drops screen),
// checks each one every ~30 seconds, and the moment one can be bought it sends a
// notification to your iPhone (the Comps web app on your Home Screen) — straight
// from this computer through Apple's push service. Status and recent drops are
// shared with the website and app through your Comps sync gist on GitHub.
//
//   node monitor.mjs              start watching
//   node monitor.mjs --setup      enter a new GitHub key / Best Buy key
//   node monitor.mjs --check URL  check one link once and print what it sees

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { Gist, GistError, DROPS_FILE, MONITOR_FILE, TOKEN_URL } from './gist.mjs';
import { checkProduct, storeName, BUYABLE } from './stores.mjs';
import { generateVapidKeys, sendPush } from './webpush.mjs';

const VERSION = '1.0';
const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(HERE, 'config.json');
const MIN_INTERVAL = 15;
const STORE_SPACING_MS = 4000;      // never hit the same store more than once every 4 s
const READ_EVERY_MS = 45_000;       // pick up new links from the website/app
const HEARTBEAT_MS = 120_000;       // tell the website/app we're alive
const MAX_EVENTS = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = () => new Date().toLocaleTimeString();
const money = (n) => (n == null ? '' : `$${n.toFixed(2)}`);
const log = (...a) => console.log(`[${clock()}]`, ...a);
const STATE_LABEL = { in_stock: 'IN STOCK', preorder: 'PRE-ORDER', in_store: 'in store only', out_of_stock: 'out of stock', unknown: 'unknown', blocked: 'blocked', error: 'error' };

function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveConfig(c) {
  writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2));
}

async function setup(config) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log('\nComps drop monitor — setup\n');
  console.log('Paste your GitHub sync key — the same one you used on the website (Settings → Sync with iPhone).');
  console.log(`No key yet? Create one (only "gist" ticked, no expiration): ${TOKEN_URL}\n`);
  for (;;) {
    const token = (await rl.question('GitHub key: ')).trim();
    if (!token) continue;
    try {
      const gist = new Gist(token);
      const id = await gist.findOrCreate();
      config = { ...config, token, gist: id };
      break;
    } catch (e) {
      console.log(`  ${e.message}\n`);
    }
  }
  const bb = (await rl.question('Best Buy API key (optional, makes Best Buy checks reliable — Enter to skip): ')).trim();
  if (bb) config.bestBuyKey = bb;
  rl.close();
  config.vapid ??= generateVapidKeys();
  config.interval ??= 30;
  config.subject ??= 'https://github.com/';
  saveConfig(config);
  console.log(`\nSaved to ${CONFIG_FILE}. Keep this file private — it holds your key.\n`);
  return config;
}

export class Monitor {
  constructor(config) {
    this.config = config;
    this.gist = new Gist(config.token, config.gist);
    this.interval = Math.max(MIN_INTERVAL, Number(config.interval) || 30) * 1000;
    this.watch = [];
    this.devices = [];
    this.status = {};
    this.events = [];
    this.dead = [];
    this.greeted = [];
    this.next = new Map();       // watch id → next check time
    this.backoff = new Map();    // watch id → current interval while blocked/erroring
    this.storeNext = new Map();  // store → earliest next request
    this.lastRead = 0;
    this.lastWrite = 0;
    this.dirty = false;
    this.startedAt = Date.now();
  }

  async load() {
    const files = await this.gist.read();
    const mine = files[MONITOR_FILE];
    if (mine) {
      this.status = mine.status ?? {};
      this.events = mine.events ?? [];
      this.dead = mine.dead ?? [];
      this.greeted = mine.greeted ?? [];
    }
    if (!files[DROPS_FILE]) await this.gist.write({ [DROPS_FILE]: { v: 1, updatedAt: Date.now(), watch: [], devices: [] } });
    this.applyDrops(files[DROPS_FILE]);
    this.lastRead = Date.now();
    this.dirty = true;
  }

  applyDrops(drops) {
    const before = new Set(this.watch.map((w) => w.id));
    this.watch = (drops?.watch ?? []).filter((w) => w && w.id && /^https?:\/\//.test(w.url ?? '') && !w.deleted);
    this.devices = (drops?.devices ?? []).filter((d) => d?.endpoint && d.keys?.p256dh && d.keys?.auth);
    for (const w of this.watch) {
      if (!before.has(w.id)) {
        this.next.set(w.id, 0);
        if (before.size || this.lastRead) log(`+ watching ${w.name || w.url}`);
      }
    }
    for (const id of Object.keys(this.status)) if (!this.watch.some((w) => w.id === id)) { delete this.status[id]; this.dirty = true; }
  }

  async refresh() {
    try {
      const files = await this.gist.read();
      this.applyDrops(files[DROPS_FILE]);
      await this.greetNewDevices();
    } catch (e) {
      log(`! couldn't read your watch list: ${e.message}`);
    }
    this.lastRead = Date.now();
  }

  /** A test notification to each newly added phone, so you know alerts work. */
  async greetNewDevices() {
    for (const d of this.devices) {
      if (this.greeted.includes(d.id) || this.dead.includes(d.endpoint)) continue;
      const r = await this.push(d, { title: 'Drop alerts are on', body: `This ${d.name || 'phone'} will be notified the moment a watched product can be bought.`, url: 'drops' });
      if (r.ok) {
        this.greeted.push(d.id);
        this.dirty = true;
        log(`✓ alerts connected: ${d.name || 'phone'}`);
      }
    }
  }

  async push(device, message) {
    const r = await sendPush(device, message, this.config.vapid, { subject: this.config.subject });
    if (r.gone) {
      this.dead.push(device.endpoint);
      this.dirty = true;
      log(`! ${device.name || 'a phone'} turned alerts off; removing it`);
    } else if (!r.ok) {
      log(`! alert to ${device.name || 'phone'} failed (${r.status || 'network'}) ${r.detail}`);
    }
    return r;
  }

  async alert(w, s) {
    const store = storeName(s.store);
    const title = s.state === 'preorder' ? `${store}: pre-order open` : `${store}: in stock`;
    const body = [w.name || s.title || 'Watched product', money(s.price)].filter(Boolean).join(' · ');
    process.stdout.write('\x07');
    log(`🔔 ${title} — ${body}`);
    const event = { id: randomUUID(), watchId: w.id, at: Date.now(), state: s.state, price: s.price, title: w.name || s.title, url: w.url, store: s.store };
    this.events = [event, ...this.events].slice(0, MAX_EVENTS);
    const live = this.devices.filter((d) => !this.dead.includes(d.endpoint));
    const results = await Promise.all(live.map((d) => this.push(d, { title, body, url: w.url, tag: w.id })));
    const sent = results.filter((r) => r.ok).length;
    if (live.length) log(`   sent to ${sent} of ${live.length} phone${live.length === 1 ? '' : 's'}`);
    else log('   no phones connected yet — turn on alerts on the website (Drops) from your Home Screen');
  }

  async check(w) {
    const prev = this.status[w.id];
    const s = await checkProduct(w.url, { bestBuyKey: this.config.bestBuyKey });
    const now = Date.now();
    const canBuy = (x) => x && BUYABLE.has(x.state) && (w.maxPrice == null || x.price == null || x.price <= w.maxPrice);
    const changed = !prev || prev.state !== s.state || prev.price !== s.price;
    this.status[w.id] = {
      state: s.state, price: s.price, title: s.title ?? prev?.title ?? null, store: s.store, via: s.via ?? null, note: s.note ?? null,
      checkedAt: now, changedAt: changed ? now : prev.changedAt,
    };
    if (changed) {
      this.dirty = true;
      const name = w.name || s.title || w.url;
      log(`${storeName(s.store)} · ${name}: ${prev ? `${STATE_LABEL[prev.state]} → ` : ''}${STATE_LABEL[s.state]} ${money(s.price)}${s.note && !BUYABLE.has(s.state) ? ` (${s.note})` : ''}`);
    }
    if (canBuy(s) && !canBuy(prev)) await this.alert(w, s);

    // Back off from a store that's blocking us or erroring; return to normal once it answers.
    const trouble = s.state === 'blocked' || s.state === 'error';
    const wait = trouble ? Math.min(10 * 60_000, (this.backoff.get(w.id) ?? this.interval) * 2) : this.interval;
    if (trouble) this.backoff.set(w.id, wait); else this.backoff.delete(w.id);
    this.next.set(w.id, now + wait * (0.85 + Math.random() * 0.3));
    this.storeNext.set(s.store, now + STORE_SPACING_MS);
  }

  async save() {
    const data = {
      v: 1, version: VERSION, seenAt: Date.now(), startedAt: this.startedAt, interval: this.interval / 1000,
      vapidPublicKey: this.config.vapid.publicKey, status: this.status, events: this.events,
      dead: this.dead.slice(-50), greeted: this.greeted.slice(-50),
    };
    try {
      await this.gist.write({ [MONITOR_FILE]: data });
      this.dirty = false;
      this.lastWrite = Date.now();
    } catch (e) {
      log(`! couldn't save status: ${e.message}`);
      this.lastWrite = Date.now() - HEARTBEAT_MS + 30_000; // retry in 30 s
    }
  }

  summary() {
    const n = this.watch.length;
    const buyable = this.watch.filter((w) => BUYABLE.has(this.status[w.id]?.state)).length;
    const phones = this.devices.filter((d) => !this.dead.includes(d.endpoint)).length;
    return `watching ${n} product${n === 1 ? '' : 's'}${n ? ` (${buyable} buyable now)` : ''} · alerts to ${phones} phone${phones === 1 ? '' : 's'} · every ${this.interval / 1000}s`;
  }

  async run() {
    await this.load();
    await this.greetNewDevices();
    log(this.summary());
    if (!this.watch.length) log('Add product links on the website (Drops) or in the Comps app — they show up here within a minute.');
    let lastSummary = Date.now();
    for (;;) {
      const now = Date.now();
      if (now - this.lastRead > READ_EVERY_MS) await this.refresh();
      const due = this.watch
        .filter((w) => (this.next.get(w.id) ?? 0) <= now)
        .sort((a, b) => (this.next.get(a.id) ?? 0) - (this.next.get(b.id) ?? 0));
      for (const w of due) {
        const store = this.status[w.id]?.store;
        if (store && (this.storeNext.get(store) ?? 0) > Date.now()) continue;
        await this.check(w);
      }
      if (this.dirty || Date.now() - this.lastWrite > HEARTBEAT_MS) await this.save();
      if (Date.now() - lastSummary > 10 * 60_000) { log(this.summary()); lastSummary = Date.now(); }
      await sleep(1000);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  let config = loadConfig();

  if (args[0] === '--inspect') {
    // Diagnostics for tuning a store: what the page exposes.
    const res = await fetch(args[1], { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' } });
    const html = await res.text();
    const uniq = (re) => [...new Set([...html.matchAll(re)].map((m) => m[1] ?? m[0]))].slice(0, 15);
    console.log(JSON.stringify({
      http: res.status, bytes: html.length, title: html.match(/<title[^>]*>([^<]*)/i)?.[1],
      ldJson: (html.match(/application\/ld\+json/g) ?? []).length,
      availability: uniq(/"availability(?:Status|_status)?\\?"\s*:\s*\\?"([^"\\]+)/gi),
      apiEndpoints: uniq(/(redsky_aggregations\/v\d\/[a-z_]+\/[a-z0-9_]+)/gi),
      apiKeyFound: /apiKey\\?"\s*:\s*\\?"[0-9a-f]{40}/.test(html),
      dataScripts: uniq(/(__[A-Z_]{4,}__)/g),
    }, null, 2));
    return;
  }
  if (args[0] === '--check') {
    if (!args[1]) { console.log('Usage: node monitor.mjs --check <product link>'); return; }
    const r = await checkProduct(args[1], { bestBuyKey: config.bestBuyKey });
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (!config.token || !config.gist || args.includes('--setup')) config = await setup(config);
  if (!config.vapid) { config.vapid = generateVapidKeys(); saveConfig(config); }

  console.log(`\nComps drop monitor ${VERSION} — leave this window open. Press Ctrl+C to stop.\n`);
  const monitor = new Monitor(config);
  for (;;) {
    try {
      await monitor.run();
    } catch (e) {
      if (e instanceof GistError && e.status === 401) { console.log(`\n${e.message}\n`); process.exit(1); }
      log(`! ${e.message} — retrying in 30 s`);
      await sleep(30_000);
    }
  }
}

// Run when started directly (not when imported by the tests).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
