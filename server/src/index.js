// Comps server: JSON API, cached image proxy and the static web app, on one port.

import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import { brotliCompressSync, gzipSync, constants as zc } from 'node:zlib';
import { openDatabase } from './db.js';
import { createSettings } from './settings.js';
import { createJobs } from './jobs.js';
import { createApi } from './api.js';
import { seedDemo } from './demo.js';
import { log } from './lib/util.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const DATA_DIR = resolve(process.env.DATA_DIR ?? join(here, '../../data'));
const WEB_DIR = resolve(process.env.WEB_DIR ?? join(here, '../../web/dist'));
const TOKEN = process.env.COMPS_TOKEN ?? '';

const db = openDatabase(DATA_DIR);
const settings = createSettings(db);
const jobs = createJobs(db, settings);
const api = createApi({ db, settings, jobs });

if (process.env.COMPS_DEMO === '1' && !settings.get()._demo) {
  seedDemo(db, settings);
  jobs.recompute();
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.txt': 'text/plain',
};

function authorized(req, url) {
  if (!TOKEN) return true;
  const h = req.headers.authorization ?? '';
  const given = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token') ?? '';
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(req, res, status, body, headers = {}) {
  let buf = typeof body === 'string' || Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(JSON.stringify(body));
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers };
  const ae = req.headers['accept-encoding'] ?? '';
  if (buf.length > 1024 && /json|text|javascript|svg/.test(h['Content-Type'])) {
    if (ae.includes('br')) { buf = brotliCompressSync(buf, { params: { [zc.BROTLI_PARAM_QUALITY]: 4 } }); h['Content-Encoding'] = 'br'; }
    else if (ae.includes('gzip')) { buf = gzipSync(buf, { level: 6 }); h['Content-Encoding'] = 'gzip'; }
    h.Vary = 'Accept-Encoding';
  }
  h['Content-Length'] = buf.length;
  res.writeHead(status, h);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

async function readBody(req, limit = 10 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  if (!size) return null;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}

// --- Image proxy: caches card art on disk so pages load instantly and we
// don't hammer the source CDNs. Only known image hosts are allowed.
const IMG_HOSTS = new Set(['images.pokemontcg.io', 'cards.scryfall.io', 'c1.scryfall.com', 'images.ygoprodeck.com', 'i.ebayimg.com', 'storage.googleapis.com', 'commondatastorage.googleapis.com']);
const IMG_DIR = join(DATA_DIR, 'img');
const inflight = new Map();

async function proxyImage(req, res, url) {
  const u = url.searchParams.get('u');
  let target;
  try { target = new URL(u); } catch { return send(req, res, 400, { error: 'bad url' }); }
  if (target.protocol !== 'https:' || !IMG_HOSTS.has(target.hostname)) return send(req, res, 403, { error: 'host not allowed' });
  const hash = createHash('sha1').update(target.href).digest('hex');
  const file = join(IMG_DIR, hash.slice(0, 2), hash);
  const cacheHeaders = { 'Cache-Control': 'public, max-age=2592000, immutable' };
  try {
    const [data, meta] = await Promise.all([readFile(file), readFile(file + '.type', 'utf8')]);
    return send(req, res, 200, data, { ...cacheHeaders, 'Content-Type': meta });
  } catch {}
  if (process.env.COMPS_OFFLINE_IMAGES === '1') return send(req, res, 404, { error: 'offline' });
  let p = inflight.get(hash);
  if (!p) {
    p = (async () => {
      const r = await fetch(target, { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'Comps/1.0' } });
      if (!r.ok) throw Object.assign(new Error(`upstream ${r.status}`), { status: 502 });
      const type = r.headers.get('content-type') ?? 'image/jpeg';
      if (!type.startsWith('image/')) throw Object.assign(new Error('not an image'), { status: 502 });
      const data = Buffer.from(await r.arrayBuffer());
      await mkdir(dirname(file), { recursive: true });
      await Promise.all([writeFile(file, data), writeFile(file + '.type', type)]);
      return { data, type };
    })().finally(() => setTimeout(() => inflight.delete(hash), 1000));
    inflight.set(hash, p);
  }
  try {
    const { data, type } = await p;
    return send(req, res, 200, data, { ...cacheHeaders, 'Content-Type': type });
  } catch (err) {
    return send(req, res, err.status ?? 502, { error: err.message }, { 'Cache-Control': 'max-age=300' });
  }
}

// --- Static web app with precompressed assets and SPA fallback.
async function serveStatic(req, res, url) {
  if (!existsSync(WEB_DIR)) {
    return send(req, res, 200, `<!doctype html><meta charset=utf-8><title>Comps</title><body style="font:15px system-ui;padding:40px">
      Web app not built. Run <code>npm run build</code>, or <code>npm run dev</code> for development.`, { 'Content-Type': 'text/html; charset=utf-8' });
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel.includes('..')) return send(req, res, 400, { error: 'bad path' });
  let file = join(WEB_DIR, rel);
  let isIndex = false;
  try {
    const st = await stat(file);
    if (st.isDirectory()) throw new Error('dir');
  } catch {
    file = join(WEB_DIR, 'index.html');
    isIndex = true;
  }
  const type = MIME[extname(file)] ?? 'application/octet-stream';
  const immutable = rel.startsWith('/assets/');
  const headers = {
    'Content-Type': type,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };
  if (isIndex || type.startsWith('text/html')) headers['Referrer-Policy'] = 'same-origin';
  const ae = req.headers['accept-encoding'] ?? '';
  for (const [enc, ext] of [['br', '.br'], ['gzip', '.gz']]) {
    if (ae.includes(enc) && existsSync(file + ext)) {
      const data = await readFile(file + ext);
      res.writeHead(200, { ...headers, 'Content-Encoding': enc, 'Content-Length': data.length, Vary: 'Accept-Encoding' });
      return res.end(req.method === 'HEAD' ? undefined : data);
    }
  }
  const data = await readFile(file);
  return send(req, res, 200, data, headers);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const t0 = performance.now();
  try {
    if (url.pathname === '/img') return await proxyImage(req, res, url);
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname !== '/api/health' && !authorized(req, url)) return send(req, res, 401, { error: 'unauthorized' });
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : null;
      const query = Object.fromEntries(url.searchParams);
      const out = await api(req.method, url.pathname, query, body);
      if (out === undefined) return send(req, res, 404, { error: 'not found' });
      const status = out?.status && out?.error ? out.status : 200;
      send(req, res, status, out);
      const ms = performance.now() - t0;
      if (ms > 250) log.info(`${req.method} ${url.pathname} ${Math.round(ms)}ms`);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, { error: 'method not allowed' });
    return await serveStatic(req, res, url);
  } catch (err) {
    log.error(req.method, url.pathname, err.stack ?? err.message);
    if (!res.headersSent) send(req, res, err.status ?? 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  log.info(`Comps on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (data: ${DATA_DIR}${TOKEN ? ', token auth on' : ''})`);
  jobs.start();
  const st = settings.get();
  if (st._demo) log.info('demo mode: sample data, scheduler off');
  else if (!db.get('SELECT 1 FROM cards LIMIT 1')) log.info('empty catalog — first refresh starts in a few seconds (Pokémon takes a few minutes without an API key)');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    jobs.stop();
    server.close();
    db.close();
    process.exit(0);
  });
}
