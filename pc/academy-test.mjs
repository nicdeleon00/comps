// Run once on your PC: opens Academy in your own Chrome, searches for Pokémon cards, and writes
// what the site answers to academy-test.txt (response shapes only, nothing personal).
//
//   npm install playwright-core
//   node academy-test.mjs
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const lines = [];
const log = (s) => { console.log(s); lines.push(s); };
function shape(v, d = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? `[${v.length}× ${shape(v[0], d + 1)}]` : '[]';
  if (typeof v === 'object') return d > 4 ? '{…}' : '{' + Object.entries(v).slice(0, 40).map(([k, x]) => `${k}: ${shape(x, d + 1)}`).join(', ') + '}';
  return typeof v === 'string' ? JSON.stringify(v.length > 50 ? v.slice(0, 50) + '…' : v) : String(v);
}

const browser = await chromium.launch({ channel: 'chrome', headless: false });
const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
page.on('response', async (res) => {
  const url = res.url(); const req = res.request();
  if (!/academy\.com$/.test(new URL(url).hostname) || !['xhr', 'fetch'].includes(req.resourceType())) return;
  if (!/api|inventor|store|search|product/i.test(url)) return;
  let body = ''; try { body = await res.text(); } catch {}
  let s; try { s = shape(JSON.parse(body)).slice(0, 1500); } catch { s = body.slice(0, 100).replace(/\s+/g, ' '); }
  log(`${req.method()} ${res.status()} ${url.slice(0, 220)} ${body.length}b\n   post=${(req.postData() ?? '').slice(0, 300)}\n   ${s}`);
});

async function go(url) {
  try {
    const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(10000);
    log(`PAGE ${r?.status()} ${page.url().slice(0, 150)} "${(await page.title()).slice(0, 70)}"`);
  } catch (e) { log(`PAGE FAILED ${url} ${e.message.split('\n')[0]}`); }
  const links = await page.evaluate(() => [...document.querySelectorAll('a[href*="/p/"]')].map((a) => a.getAttribute('href').slice(0, 120))).catch(() => []);
  const found = [...new Set(links)].filter((l) => /pok/i.test(l));
  log(`  product links (${found.length}): ${found.slice(0, 30).join('\n     ')}`);
  return found;
}

log(`Academy test ${new Date().toISOString()}`);
const found = await go('https://www.academy.com/search?searchTerm=pokemon%20trading%20cards');
if (found[0]) await go(new URL(found[0], 'https://www.academy.com').href);
await browser.close();
writeFileSync('academy-test.txt', lines.join('\n'));
console.log('\nDone. Send academy-test.txt back.');
