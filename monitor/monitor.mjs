#!/usr/bin/env node
// Comps drop monitor — runs on the site owner's computer.
//
// Reads every account's drop links (Supabase, with the service_role key), checks
// each unique link about every 30 seconds, and the moment a product can be bought
// it sends a notification to the devices of everyone watching it — straight from
// this computer through the browser vendors' push services (Apple's, for an
// iPhone Home Screen web app). Stock status and recent drops are written back so
// the website and app can show them.
//
//   node monitor.mjs              start watching
//   node monitor.mjs --setup      enter the Supabase settings / Best Buy key again
//   node monitor.mjs --check URL  check one link once and print what it sees

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { Accounts, AccountsError } from './accounts.mjs';
import { checkProduct, storeName, BUYABLE } from './stores.mjs';
import { generateVapidKeys, sendPush } from './webpush.mjs';

const VERSION = '2.0';
const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(HERE, 'config.json');
const MIN_INTERVAL = 15;
const STORE_SPACING_MS = 4000;      // never hit the same store more than once every 4 s
const READ_EVERY_MS = 45_000;       // pick up new links and devices
const WRITE_EVERY_MS = 120_000;     // "last checked" times + heartbeat
const MAX_LINKS = 300;              // protects this computer's connection from too many links
const EVENT_DAYS = 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = () => new Date().toLocaleTimeString();
const money = (n) => (n == null ? '' : `$${Number(n).toFixed(2)}`);
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
  console.log('From your Supabase project: Project Settings → API.\n');
  for (;;) {
    const url = (await rl.question('Project URL (https://….supabase.co): ')).trim();
    const key = (await rl.question('service_role key (keep it secret): ')).trim();
    if (!url || !key) continue;
    try {
      await new Accounts(url, key).monitorState();
      config = { ...config, supabaseUrl: url, serviceKey: key };
      delete config.token;
      delete config.gist;
      break;
    } catch (e) {
      console.log(`  ${e.message}\n`);
    }
  }
  const bb = (await rl.question('Best Buy API key (optional, free at developer.bestbuy.com — Enter to skip): ')).trim();
  if (bb) config.bestBuyKey = bb;
  rl.close();
  config.vapid ??= generateVapidKeys();
  config.interval ??= 30;
  config.subject ??= 'https://github.com/';
  config.greeted ??= [];
  saveConfig(config);
  console.log(`\nSaved to ${CONFIG_FILE}. Keep this file private — it holds your key.\n`);
  return config;
}

export class Monitor {
  /** `accounts` is the data store (Supabase, or a stand-in in tests). */
  constructor(config, accounts, { save = saveConfig } = {}) {
    this.config = config;
    this.accounts = accounts;
    this.saveConfig = save;
    this.interval = Math.max(MIN_INTERVAL, Number(config.interval) || 30) * 1000;
    this.items = [];             // everyone's watch items
    this.devices = [];
    this.status = new Map();     // watch id → status row
    this.dirty = new Map();      // watch id → status row to write
    this.events = [];            // events to write
    this.links = new Map();      // url → { items, next, backoff, store }
    this.storeNext = new Map();  // store → earliest next request
    this.lastRead = 0;
    this.lastWrite = 0;
    this.lastPrune = 0;
    this.startedAt = Date.now();
  }

  async load() {
    for (const s of await this.accounts.statuses()) this.status.set(s.watch_id, s);
    await this.refresh();
  }

  async refresh() {
    try {
      const [items, devices] = await Promise.all([this.accounts.watchItems(), this.accounts.devices()]);
      this.items = items.filter((w) => /^https?:\/\//.test(w.url ?? ''));
      this.devices = devices;
      const urls = new Map();
      for (const w of this.items) {
        if (!urls.has(w.url)) urls.set(w.url, []);
        urls.get(w.url).push(w);
      }
      const keep = [...urls.keys()].slice(0, MAX_LINKS);
      if (urls.size > MAX_LINKS) log(`! ${urls.size} links watched; checking the first ${MAX_LINKS}`);
      for (const url of keep) {
        const cur = this.links.get(url);
        if (cur) cur.items = urls.get(url);
        else {
          this.links.set(url, { items: urls.get(url), next: 0, backoff: null, store: null });
          if (this.lastRead) log(`+ watching ${urls.get(url)[0].name || url}`);
        }
      }
      for (const url of [...this.links.keys()]) if (!keep.includes(url)) this.links.delete(url);
      await this.greetNewDevices();
    } catch (e) {
      log(`! couldn't read watch lists: ${e.message}`);
    }
    this.lastRead = Date.now();
  }

  /** A test notification to each newly added device, so its owner knows alerts work. */
  async greetNewDevices() {
    const greeted = new Set(this.config.greeted ?? []);
    let changed = false;
    for (const d of this.devices) {
      if (greeted.has(d.id)) continue;
      const r = await this.push(d, { title: 'Drop alerts are on', body: `This ${d.name || 'device'} will be notified the moment a watched product can be bought.`, url: 'drops' });
      if (r.ok || r.gone) {
        greeted.add(d.id);
        changed = true;
        if (r.ok) log(`✓ alerts connected: ${d.name || 'device'}`);
      }
    }
    if (changed) {
      this.config.greeted = [...greeted].slice(-500);
      this.saveConfig(this.config);
    }
  }

  async push(device, message) {
    const r = await sendPush({ endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } }, message, this.config.vapid, { subject: this.config.subject });
    if (r.gone) {
      log(`! a ${device.name || 'device'} turned alerts off; removing it`);
      this.devices = this.devices.filter((d) => d.id !== device.id);
      await this.accounts.deleteDevice(device.id).catch(() => {});
    } else if (!r.ok) {
      log(`! alert to a ${device.name || 'device'} failed (${r.status || 'network'}) ${r.detail}`);
    }
    return r;
  }

  async alert(item, s) {
    const store = storeName(s.store);
    const title = s.state === 'preorder' ? `${store}: pre-order open` : `${store}: in stock`;
    const name = item.name || s.title || 'Watched product';
    const body = [name, money(s.price)].filter(Boolean).join(' · ');
    this.events.push({ user_id: item.user_id, watch_id: item.id, at: Date.now(), state: s.state, price: s.price, title: name, url: item.url, store: s.store });
    const mine = this.devices.filter((d) => d.user_id === item.user_id);
    const results = await Promise.all(mine.map((d) => this.push(d, { title, body, url: item.url, tag: item.id })));
    process.stdout.write('\x07');
    log(`🔔 ${title} — ${body} → ${results.filter((r) => r.ok).length} of ${mine.length} device${mine.length === 1 ? '' : 's'}`);
  }

  async check(url) {
    const link = this.links.get(url);
    const s = await checkProduct(url, { bestBuyKey: this.config.bestBuyKey });
    const now = Date.now();
    link.store = s.store;
    for (const item of link.items) {
      const prev = this.status.get(item.id);
      const max = item.max_price == null ? null : Number(item.max_price);
      const canBuy = (x) => x && BUYABLE.has(x.state) && (max == null || x.price == null || Number(x.price) <= max);
      const changed = !prev || prev.state !== s.state || Number(prev.price ?? NaN) !== Number(s.price ?? NaN);
      const row = {
        watch_id: item.id, user_id: item.user_id, state: s.state, price: s.price, title: s.title ?? prev?.title ?? null, store: s.store,
        note: s.note ?? null, checked_at: now, changed_at: changed ? now : prev.changed_at,
      };
      this.status.set(item.id, row);
      this.dirty.set(item.id, row);
      if (changed) this.lastWrite = 0; // write changes promptly
      if (canBuy(s) && !canBuy(prev)) await this.alert(item, s);
    }
    if (link.items.length && (!this.lastLogged?.has(url) || this.lastLogged.get(url) !== `${s.state}|${s.price}`)) {
      this.lastLogged ??= new Map();
      this.lastLogged.set(url, `${s.state}|${s.price}`);
      const who = link.items.length > 1 ? ` (${link.items.length} watching)` : '';
      log(`${storeName(s.store)} · ${link.items[0].name || s.title || url}${who}: ${STATE_LABEL[s.state]} ${money(s.price)}${s.note && !BUYABLE.has(s.state) ? ` (${s.note})` : ''}`);
    }
    // Back off from a store that's blocking us or erroring; return to normal once it answers.
    const trouble = s.state === 'blocked' || s.state === 'error';
    link.backoff = trouble ? Math.min(10 * 60_000, (link.backoff ?? this.interval) * 2) : null;
    link.next = now + (link.backoff ?? this.interval) * (0.85 + Math.random() * 0.3);
    this.storeNext.set(s.store, now + STORE_SPACING_MS);
  }

  async write() {
    try {
      const rows = [...this.dirty.values()].filter((r) => this.items.some((w) => w.id === r.watch_id));
      await this.accounts.upsertStatus(rows);
      this.dirty.clear();
      const events = this.events.splice(0);
      await this.accounts.addEvents(events);
      await this.accounts.heartbeat({
        seen_at: Date.now(), started_at: this.startedAt, interval_s: this.interval / 1000, vapid_public_key: this.config.vapid.publicKey,
        version: VERSION, watching: this.links.size,
      });
      if (Date.now() - this.lastPrune > 3600_000) {
        await this.accounts.pruneEvents(Date.now() - EVENT_DAYS * 86400_000);
        this.lastPrune = Date.now();
      }
      this.lastWrite = Date.now();
    } catch (e) {
      log(`! couldn't save status: ${e.message}`);
      this.lastWrite = Date.now() - WRITE_EVERY_MS + 30_000; // retry in 30 s
    }
  }

  summary() {
    const people = new Set(this.items.map((w) => w.user_id)).size;
    const buyable = this.items.filter((w) => BUYABLE.has(this.status.get(w.id)?.state)).length;
    return `watching ${this.links.size} link${this.links.size === 1 ? '' : 's'} for ${people} ${people === 1 ? 'person' : 'people'}${buyable ? ` (${buyable} buyable now)` : ''} · ${this.devices.length} alert device${this.devices.length === 1 ? '' : 's'} · every ${this.interval / 1000}s`;
  }

  async run() {
    await this.load();
    await this.write();
    log(this.summary());
    if (!this.links.size) log('Add product links on the website (Drops) or in the Comps app — they show up here within a minute.');
    let lastSummary = Date.now();
    for (;;) {
      const now = Date.now();
      if (now - this.lastRead > READ_EVERY_MS) await this.refresh();
      const due = [...this.links.entries()].filter(([, l]) => l.next <= now).sort((a, b) => a[1].next - b[1].next);
      for (const [url, l] of due) {
        if (l.store && (this.storeNext.get(l.store) ?? 0) > Date.now()) continue;
        await this.check(url);
      }
      if (Date.now() - this.lastWrite > WRITE_EVERY_MS || (this.events.length && Date.now() - this.lastWrite > 5000)) await this.write();
      if (Date.now() - lastSummary > 10 * 60_000) { log(this.summary()); lastSummary = Date.now(); }
      await sleep(1000);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  let config = loadConfig();

  if (args[0] === '--check') {
    if (!args[1]) { console.log('Usage: node monitor.mjs --check <product link>'); return; }
    console.log(JSON.stringify(await checkProduct(args[1], { bestBuyKey: config.bestBuyKey }), null, 2));
    return;
  }
  if (args[0] === '--inspect') {
    // Diagnostics for tuning a store: what the page exposes.
    const res = await fetch(args[1], { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' } });
    const html = await res.text();
    const uniq = (re) => [...new Set([...html.matchAll(re)].map((m) => m[1] ?? m[0]))].slice(0, 15);
    console.log(JSON.stringify({
      http: res.status, bytes: html.length, title: html.match(/<title[^>]*>([^<]*)/i)?.[1],
      ldJson: (html.match(/application\/ld\+json/g) ?? []).length,
      availability: uniq(/"availability(?:Status|_status)?\\?"\s*:\s*\\?"([^"\\]+)/gi),
      dataScripts: uniq(/(__[A-Z_]{4,}__)/g),
    }, null, 2));
    return;
  }
  if (!config.supabaseUrl || !config.serviceKey || args.includes('--setup')) {
    if (config.token && !config.supabaseUrl) console.log('\nComps now uses accounts. Connect the monitor to your Supabase project once.');
    config = await setup(config);
  }
  if (!config.vapid) { config.vapid = generateVapidKeys(); saveConfig(config); }

  console.log(`\nComps drop monitor ${VERSION} — leave this window open. Press Ctrl+C to stop.\n`);
  const monitor = new Monitor(config, new Accounts(config.supabaseUrl, config.serviceKey));
  for (;;) {
    try {
      await monitor.run();
    } catch (e) {
      if (e instanceof AccountsError && (e.status === 401 || e.status === 404)) { console.log(`\n${e.message}\n`); process.exit(1); }
      log(`! ${e.message} — retrying in 30 s`);
      await sleep(30_000);
    }
  }
}

// Run when started directly (not when imported by the tests).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
