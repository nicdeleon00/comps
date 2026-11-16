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
console.log('===== DOLLAR GENERAL 2');
{
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'en-US' })).newPage();
  const seen = [];
  page.on('response', async (res) => {
    const url = res.url(); const req = res.request();
    if (!/dollargeneral\.com$/.test(new URL(url).hostname) || !['xhr', 'fetch'].includes(req.resourceType())) return;
    let body = ''; try { body = await res.text(); } catch {}
    seen.push({ url, headers: req.headers() });
    if (!/dggo\./.test(url)) return;
    let sh; try { sh = shape(JSON.parse(body)).slice(0, 1500); } catch { sh = body.slice(0, 80); }
    console.log(`  ${req.method()} ${res.status()} ${url.slice(0, 220)} ${body.length}b\n     post=${(req.postData() ?? '').slice(0, 400)}\n     ${sh}`);
  });
  for (const u of ['https://www.dollargeneral.com/p/pokemon-trading-card-game-15-card-pack-1-ct/728192558375', 'https://www.dollargeneral.com/product-search.html?q=pokemon', 'https://www.dollargeneral.com/c/toys/trading-cards']) {
    try { const r = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 35000 }); await page.waitForTimeout(9000); console.log(`PAGE ${r?.status()} ${page.url().slice(0, 140)} "${(await page.title()).slice(0, 60)}"`); } catch (e) { console.log(`PAGE FAILED ${u} ${e.message.split('\n')[0]}`); }
    const links = await page.evaluate(() => [...document.querySelectorAll('a[href*="/p/"]')].map((a) => a.getAttribute('href').slice(0, 110))).catch(() => []);
    console.log(`  links: ${[...new Set(links)].filter((l) => /pok/i.test(l)).slice(0, 25).join('\n     ')}`);
  }
  // Try the site's own search box.
  try {
    await page.goto('https://www.dollargeneral.com/', { waitUntil: 'domcontentloaded', timeout: 35000 }); await page.waitForTimeout(5000);
    const box = page.locator('input[type="search"], input[placeholder*="earch"]').first();
    await box.fill('pokemon trading card', { timeout: 8000 }); await box.press('Enter'); await page.waitForTimeout(10000);
    console.log(`SEARCH BOX -> ${page.url().slice(0, 160)} "${(await page.title()).slice(0, 60)}"`);
    const links = await page.evaluate(() => [...document.querySelectorAll('a[href*="/p/"]')].map((a) => a.getAttribute('href').slice(0, 110))).catch(() => []);
    console.log(`  links: ${[...new Set(links)].filter((l) => /pok/i.test(l)).slice(0, 40).join('\n     ')}`);
  } catch (e) { console.log(`SEARCH BOX failed ${e.message.split('\n')[0]}`); }
  const sess = [...seen].reverse().find((x) => /dggo\./.test(x.url) && x.headers.authorization);
  if (sess) {
    const h = Object.fromEntries(Object.entries(sess.headers).filter(([k]) => /^(authorization|x-dg)/.test(k)));
    console.log(`session header names: ${Object.keys(h).join(', ')}`);
    for (const extra of [{}, { startRecord: '25' }, { pageNumber: '2' }, { page: '2' }, { expectedRecordsPerPage: '100' }, { recordsPerPage: '100' }]) {
      const body = new URLSearchParams({ latitude: String(LAT), longitude: String(LON), radius: '25', upc: '820650801563', offerSourceType: '0', ...extra }).toString();
      const r = await page.evaluate(async ([h, body]) => { const r = await fetch('https://dggo.dollargeneral.com/omni/api/store/search/inventory', { method: 'POST', headers: { ...h, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body }); return { status: r.status, text: await r.text() }; }, [h, body]);
      let out = r.text.slice(0, 120); try { const j = JSON.parse(r.text); out = `${JSON.stringify(j.paginationInfo)} first=${j.stores?.[0]?.storeNumber} n=${j.stores?.length} withStock=${j.stores?.filter((x) => x.productQTY > 0).length}`; } catch {}
      console.log(`inventory ${JSON.stringify(extra)}: ${r.status} ${out}`);
    }
  }
  await browser.close();
}
