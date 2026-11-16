// One-off: can a normal Chrome on this machine read each store's own stock answer for a
// Pokémon product? Prints response shapes only.
import { chromium } from 'playwright-core';
const LAT = 32.7876, LON = -96.7994;
function shape(v, d = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? `[${v.length}× ${shape(v[0], d + 1)}]` : '[]';
  if (typeof v === 'object') return d > 4 ? '{…}' : '{' + Object.entries(v).slice(0, 40).map(([k, x]) => `${k}: ${shape(x, d + 1)}`).join(', ') + '}';
  return typeof v === 'string' ? JSON.stringify(v.length > 50 ? v.slice(0, 50) + '…' : v) : String(v);
}
async function visit(site, hosts, urls, after) {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'en-US', geolocation: { latitude: LAT, longitude: LON }, permissions: ['geolocation'] })).newPage();
  const seen = [];
  page.on('response', async (res) => {
    const url = res.url(); const req = res.request();
    if (!hosts.test(new URL(url).hostname) || !['xhr', 'fetch'].includes(req.resourceType())) return;
    let body = ''; try { body = await res.text(); } catch {}
    seen.push({ url, method: req.method(), status: res.status(), headers: req.headers() });
    if (!/inventor|availab|search|store|product|item/i.test(url)) return;
    let s; try { s = shape(JSON.parse(body)).slice(0, 1200); } catch { s = body.slice(0, 100).replace(/\s+/g, ' '); }
    console.log(`  ${site} ${req.method()} ${res.status()} ${url.slice(0, 170)} ${body.length}b\n     ${s}`);
  });
  for (const u of urls) {
    try { const r = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 35000 }); await page.waitForTimeout(8000); console.log(`${site} PAGE ${r?.status()} ${page.url().slice(0, 120)} "${(await page.title()).slice(0, 70)}"`); }
    catch (e) { console.log(`${site} PAGE FAILED ${u} ${e.message.split('\n')[0]}`); }
  }
  try { if (after) await after(page, seen); } catch (e) { console.log(`${site} ERROR ${e.message.split('\n')[0]}`); }
  const links = await page.evaluate(() => [...document.querySelectorAll('a[href*="/p/"]')].map((a) => `${a.textContent.trim().slice(0, 70)} | ${a.getAttribute('href').slice(0, 100)}`).filter((t) => /pok/i.test(t))).catch(() => []);
  console.log(`${site} product links: ${[...new Set(links)].slice(0, 15).join('\n   ')}`);
  await browser.close();
}
console.log('===== DOLLAR GENERAL');
await visit('DG', /dollargeneral\.com$/, ['https://www.dollargeneral.com/p/pokemon-trading-card-game-15-card-pack-1-ct/728192558375', 'https://www.dollargeneral.com/search?q=pokemon'], async (page, seen) => {
  const s = [...seen].reverse().find((x) => /dggo\./.test(x.url) && x.headers.authorization);
  console.log(`DG calls to its API: ${seen.filter((x) => /dggo\./.test(x.url)).length}, with a session: ${Boolean(s)}`);
  if (!s) return;
  const h = Object.fromEntries(Object.entries(s.headers).filter(([k]) => /^(authorization|x-dg)/.test(k)));
  const r = await page.evaluate(async ([h, body]) => { const r = await fetch('https://dggo.dollargeneral.com/omni/api/store/search/inventory', { method: 'POST', headers: { ...h, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body }); return { status: r.status, text: (await r.text()).slice(0, 200000) }; },
    [h, new URLSearchParams({ latitude: String(LAT), longitude: String(LON), radius: '25', upc: '820650801563', offerSourceType: '0' }).toString()]);
  let out = r.text.slice(0, 200); try { out = shape(JSON.parse(r.text)).slice(0, 2000); } catch {}
  console.log(`DG stores near a point for one product: ${r.status} ${out}`);
});
console.log('\n===== ACADEMY');
await visit('AC', /academy\.com$/, ['https://www.academy.com/search?searchTerm=pokemon'], async (page, seen) => {
  console.log(`AC api calls: ${seen.filter((x) => /\/api\//.test(x.url)).map((x) => `${x.status} ${x.url.slice(0, 120)}`).slice(0, 25).join('\n   ')}`);
});
