// Runs on Facebook. On Marketplace it prices every Pokémon card listing (from the
// listing data Facebook sends the page, or from the screen as a fallback), puts a
// price tag on each, and shows the Comps panel: pick what to search for, search
// now, or let it check by itself every so often.

(() => {
  if (window.__compsMarketplace) return;
  window.__compsMarketplace = true;

  const STEP_MS = 2500; // one scroll every 2.5 s while searching
  const MAX_STEPS = 60; // ~2.5 minutes per search
  const IDLE_STEPS = 4; // no new listings after 4 scrolls = end of results
  const PRICE_LINE = /^(?:[A-Z]{1,3})?[$£€¥₹]|^free$/i;
  const SKIP_LINE = /^(just listed|partner listing|sponsored|shipping available|ships to you|free shipping|[·•]|\d+(\.\d+)?k?\s*(mi|miles|km)( away)?)$/i;
  const NUMBER = /\b[A-Za-z]{0,4}\d{1,3}[a-z]?\s*\/\s*[A-Za-z]{0,4}\d{1,3}\b/;
  const DEFAULT_SITE = 'https://nicdeleon00.github.io/comps/';

  const listings = new Map(); // id → { listing, sig, match, priced }
  let enabled = true;
  let info = null; // settings, presets, update… from the background
  let scan = null;
  let scanning = false;
  let open = true;

  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const onMarketplace = () => location.pathname.startsWith('/marketplace');
  const itemId = () => /\/marketplace\/item\/(\d+)/.exec(location.pathname)?.[1] ?? null;
  const fbUrl = (id) => `https://www.facebook.com/marketplace/item/${id}/`;
  const siteUrl = (path) => new URL(path, info?.site ?? DEFAULT_SITE).href;
  const money = (v) => (v == null ? '—' : v >= 100 ? `$${Math.round(v).toLocaleString()}` : `$${v.toFixed(2)}`);
  const parsePrice = (s) => {
    const m = /^\s*\$\s?([\d,]+(?:\.\d{1,2})?)/.exec(s); // "$8$10" (reduced) reads as $8
    return m ? Number(m[1].replace(/,/g, '')) || null : null;
  };

  // ------------------------------------------------------------ listings

  /** Adds or refreshes a listing. Facebook's own data wins over what's read off the screen. */
  function upsert(l) {
    const cur = listings.get(l.id);
    if (cur?.listing.structured && !l.structured) return;
    const sig = `${l.title}|${l.price}|${l.status}|${l.hint ?? ''}`;
    if (cur?.sig === sig) return;
    listings.set(l.id, { listing: { ...l, url: fbUrl(l.id) }, sig, match: cur?.match ?? null, priced: false });
  }

  // Listing data from fb-hook.js (Facebook's page and scroll responses).
  addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== 'comps-fb' || !Array.isArray(e.data.listings)) return;
    for (const r of e.data.listings) {
      if (!/^\d{5,25}$/.test(String(r?.id)) || typeof r.title !== 'string') continue;
      upsert({
        id: String(r.id), title: r.title.slice(0, 200), price: Number.isFinite(r.price) ? r.price : null,
        location: typeof r.location === 'string' ? r.location.slice(0, 80) : null,
        image: typeof r.image === 'string' && r.image.startsWith('https://') ? r.image : null,
        status: ['sold', 'pending'].includes(r.status) ? r.status : 'active',
        hint: typeof r.description === 'string' ? NUMBER.exec(r.description)?.[0] ?? null : null,
        structured: true,
      });
    }
    soon();
  });

  /** Listing links on screen, grouped by listing (a tile can have a photo link and a text link). */
  function linksById() {
    const groups = new Map();
    for (const a of document.querySelectorAll('a[href*="/marketplace/item/"]')) {
      const id = /\/marketplace\/item\/(\d+)/.exec(a.getAttribute('href') ?? '')?.[1];
      if (!id) continue;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(a);
    }
    return groups;
  }

  /** Fallback: a listing read off its tile (price, title and place lines). */
  function readTile(id, links) {
    const ours = new Set(links.map((a) => a.querySelector(':scope > .comps-tag')?.textContent).filter(Boolean));
    const lines = links.flatMap((a) => (a.innerText || a.textContent || '').split('\n')).map((s) => s.trim()).filter((s) => s && !ours.has(s));
    let price = null;
    let status = 'active';
    const rest = [];
    for (const line of lines) {
      if (/^(sold|pending)$/i.test(line)) status = line.toLowerCase();
      else if (PRICE_LINE.test(line)) price ??= parsePrice(line);
      else if (!SKIP_LINE.test(line)) rest.push(line);
    }
    const img = links.map((a) => a.querySelector('img')).find(Boolean);
    let [title, place] = rest;
    // The photo's description reads "<title> in <City, ST>" when the text isn't drawn yet.
    if (!title && img?.alt) {
      const m = /^(.*)\s+in\s+([^,]+,\s*[A-Z]{2})$/.exec(img.alt.trim());
      [title, place] = m ? [m[1], m[2]] : [img.alt.trim(), null];
    }
    if (!title) return null;
    return { id, title: title.slice(0, 200), price, location: place?.slice(0, 80) ?? null, status, image: img?.src ?? null, hint: null, structured: false };
  }

  /** Fallback for an open listing: its title, price and a card number from the description. */
  function readItemPage(id) {
    const main = document.querySelector('[role="main"]') ?? document.body;
    const title = (main.querySelector('h1')?.innerText ?? document.title.replace(/^\(\d+\+?\)\s*/, '').replace(/^Marketplace\s*[–-]\s*/i, '').replace(/\s*\|\s*Facebook\s*$/i, '')).trim();
    if (!title) return null;
    const lines = (main.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const at = Math.max(0, lines.indexOf(title));
    const price = lines.slice(at, at + 6).map(parsePrice).find(Boolean) ?? null;
    return { id, title: title.slice(0, 200), price, location: null, status: 'active', image: main.querySelector('img[src*="fbcdn"]')?.src ?? null, hint: NUMBER.exec(lines.slice(at + 1).join(' '))?.[0] ?? null, structured: false };
  }

  // ------------------------------------------------------------ pricing

  async function priceNew() {
    if (!enabled || !onMarketplace()) return { priced: [], deals: [] };
    for (const [id, links] of linksById()) {
      const l = readTile(id, links);
      if (l) upsert(l);
    }
    const id = itemId();
    if (id && !listings.has(id)) {
      const l = readItemPage(id);
      if (l) upsert(l);
    }
    const todo = [...listings.values()].filter((x) => !x.priced);
    const priced = [];
    const deals = [];
    for (let i = 0; i < todo.length; i += 60) {
      const batch = todo.slice(i, i + 60);
      const res = await send({ type: 'match', listings: batch.map((x) => x.listing) });
      if (res?.off) { enabled = false; clearTags(); break; }
      if (!res?.results) break;
      for (const x of batch) {
        x.priced = true;
        x.match = res.results.find((r) => r.id === x.listing.id)?.match ?? null;
        if (x.match && !x.match.fake) priced.push(x.listing.id);
        if (x.match?.deal) deals.push(x.listing.id);
      }
    }
    tagAll();
    render();
    return { priced, deals };
  }

  // ------------------------------------------------------------ price tags

  const TONES = { deal: ['#0b7a35', '#e3f6e9'], over: ['#a33a00', '#fdeee4'], fair: ['#1d1d1f', 'rgba(255,255,255,.94)'], unsure: ['#3d4f7a', '#eaf0fb'] };

  function tagText(m, l) {
    if (!m) return null;
    if (m.fake) return [`Worth ${money(m.value ?? m.low)} · fake price, ignored`, 'fair'];
    if (m.value == null && m.low == null) return [m.grade ? `${m.grade} · no graded price yet` : 'Comps: no price yet', 'fair'];
    if (!m.confident) {
      const range = `${money(m.low)}–${money(m.high)}`;
      return m.deal ? [`▼ ${Math.round(m.discount * 100)}% · worth ${range}`, 'deal'] : [`Worth ${range} · check which card`, 'unsure'];
    }
    if (m.deal) return [`▼ ${Math.round(m.discount * 100)}% under · worth ${money(m.value)}`, 'deal'];
    if (m.discount != null && m.discount <= -0.15 && l.price) return [`▲ ${Math.round(-m.discount * 100)}% over · worth ${money(m.value)}`, 'over'];
    return [`Worth ${money(m.value)}${m.grade ? ` · ${m.grade}` : ''}`, 'fair'];
  }

  function tag(links, m, l) {
    const host = links.find((a) => a.querySelector('img')) ?? links[0];
    const tt = enabled && tagText(m, l);
    const old = host.querySelector(':scope > .comps-tag');
    if (old && tt && old.textContent === tt[0]) return; // already tagged (re-adding would wake the page observer)
    old?.remove();
    host.style.outline = '';
    if (!tt) return;
    const [text, tone] = tt;
    const el = document.createElement('div');
    el.className = 'comps-tag';
    el.textContent = text;
    el.title = `Comps: ${m.card.name} · ${m.card.set} #${m.card.number}${m.matches > 1 ? ` (or ${m.matches - 1} similar cards)` : ''}`;
    const [fg, bg] = TONES[tone];
    Object.assign(el.style, {
      position: 'absolute', left: '8px', top: '8px', zIndex: '5', maxWidth: 'calc(100% - 16px)', padding: '4px 8px', borderRadius: '8px',
      font: '600 12.5px/1.25 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', color: fg, background: bg,
      boxShadow: '0 1px 4px rgba(0,0,0,.28)', pointerEvents: 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    });
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(el);
    if (tone === 'deal') { host.style.outline = '3px solid #34c759'; host.style.outlineOffset = '-3px'; }
  }

  function tagAll() {
    for (const [id, links] of linksById()) {
      const x = listings.get(id);
      if (x?.priced) tag(links, x.match, x.listing);
    }
  }

  function clearTags() {
    for (const t of document.querySelectorAll('.comps-tag')) {
      t.parentElement.style.outline = '';
      t.remove();
    }
  }

  // ------------------------------------------------------------ searching

  async function runScan() {
    if (scanning) return;
    scanning = true;
    render();
    const monitor = scan?.mode === 'monitor';
    const started = Date.now();
    let steps = 0;
    let idle = 0;
    let last = 0;
    // A background check only needs the newest listings: the first screens of each search.
    const maxSteps = monitor ? 2 : MAX_STEPS;
    await sleep(monitor ? 5000 : STEP_MS);
    while (scanning) {
      const { priced, deals } = await priceNew();
      if (priced.length) scan = await send({ type: 'scan:progress', priced, deals });
      const count = listings.size;
      if (!count && Date.now() - started > 15_000) {
        scanning = false;
        scan = await send({ type: 'scan:stop', note: 'blocked' });
        break;
      }
      idle = count > last ? 0 : idle + 1;
      last = count;
      if ((!monitor && idle >= IDLE_STEPS) || steps++ >= maxSteps) {
        scanning = false;
        scan = await send({ type: 'scan:next' }); // the tab moves on to the next search, or the run is over
        break;
      }
      window.scrollBy({ top: Math.round(innerHeight * 0.85), behavior: 'smooth' });
      render();
      await sleep(STEP_MS);
    }
    render();
  }

  async function stopScan() {
    scanning = false;
    scan = await send({ type: 'scan:stop' });
    render();
  }

  async function saveSettings(patch) {
    if (info) info.settings = { ...info.settings, ...patch };
    await send({ type: 'settings:set', patch });
    refresh();
  }

  // ------------------------------------------------------------ panel

  const CSS = `
    :host { all: initial; }
    .p { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; width: 340px; max-height: min(640px, calc(100vh - 32px)); display: flex; flex-direction: column;
      background: #fff; color: #1d1d1f; border-radius: 16px; box-shadow: 0 12px 40px rgba(0,0,0,.28), 0 0 0 .5px rgba(0,0,0,.12);
      font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; overflow: hidden; }
    .p.min { width: auto; }
    .hd { display: flex; align-items: center; gap: 9px; padding: 11px 12px 11px 14px; cursor: pointer; user-select: none; }
    .logo { width: 24px; height: 24px; border-radius: 7px; background: #0071e3; color: #fff; display: grid; place-items: center; font-weight: 800; font-size: 14px; flex: none; }
    .ttl { font-weight: 700; flex: 1; white-space: nowrap; }
    .pill { font-size: 12px; font-weight: 700; color: #0b7a35; background: #e3f6e9; border-radius: 99px; padding: 2px 8px; white-space: nowrap; }
    .x { border: 0; background: rgba(120,120,128,.14); color: #3a3a3c; width: 24px; height: 24px; border-radius: 50%; cursor: pointer; font-size: 13px; line-height: 1; }
    .bd { padding: 0 14px 14px; overflow: auto; }
    .min .bd { display: none; }
    h4 { margin: 12px 2px 7px; font-size: 11.5px; text-transform: uppercase; letter-spacing: .04em; color: #6e6e73; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip { border: 0; border-radius: 99px; padding: 6px 11px; font: 600 13px/1.1 inherit; font-family: inherit; cursor: pointer; background: #f2f2f7; color: #1d1d1f; }
    .chip[aria-pressed="true"] { background: #0071e3; color: #fff; }
    input, select { font: inherit; font-size: 13.5px; color: inherit; background: #f2f2f7; border: 0; border-radius: 9px; height: 34px; padding: 0 10px; min-width: 0; box-sizing: border-box; }
    input:focus, select:focus { outline: 2px solid #0071e3; }
    .full { width: 100%; margin-top: 8px; }
    .row { display: flex; gap: 6px; margin-top: 8px; align-items: center; }
    .row > * { flex: 1; }
    .big { width: 100%; height: 44px; border: 0; border-radius: 12px; background: #0071e3; color: #fff; font: 700 15px/1 inherit; font-family: inherit; cursor: pointer; margin-top: 10px; }
    .big:hover { filter: brightness(.94); }
    .big:disabled { opacity: .5; cursor: default; }
    .big.stop { background: #ff3b30; }
    .sub { color: #6e6e73; font-size: 12.5px; margin: 6px 2px 0; }
    .auto { display: flex; align-items: center; gap: 8px; margin-top: 12px; font-size: 13.5px; }
    .auto input[type=checkbox] { width: 18px; height: 18px; accent-color: #0071e3; padding: 0; }
    .auto select { height: 30px; flex: none; }
    .status { display: flex; align-items: center; gap: 9px; margin-top: 10px; font-weight: 600; }
    .spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid #0071e3; border-right-color: transparent; animation: s .8s linear infinite; flex: none; }
    @keyframes s { to { transform: rotate(360deg); } }
    .nums { display: flex; gap: 8px; margin-top: 12px; }
    .num { flex: 1; background: #f2f2f7; border-radius: 10px; padding: 7px 10px; }
    .num b { display: block; font-size: 18px; }
    .num span { font-size: 11.5px; color: #6e6e73; }
    .item { background: #f2f2f7; border-radius: 12px; padding: 10px 12px; margin-bottom: 4px; }
    .item .nm { font-weight: 700; }
    .item .val { font-size: 22px; font-weight: 800; margin-top: 2px; }
    .good { color: #0b7a35; } .bad { color: #a33a00; } .muted { color: #6e6e73; }
    .deal { display: flex; gap: 10px; align-items: center; padding: 7px 4px; border-radius: 10px; cursor: pointer; }
    .deal:hover { background: #f2f2f7; }
    .deal img, .deal .ph { width: 42px; height: 42px; border-radius: 8px; object-fit: cover; flex: none; background: #e5e5ea; }
    .deal .m { flex: 1; min-width: 0; }
    .deal .t { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .deal .s { font-size: 12px; color: #6e6e73; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .deal .r { text-align: right; font-size: 12.5px; flex: none; }
    .deal .r b { display: block; font-size: 14px; }
    a.link { display: block; text-align: center; margin-top: 12px; color: #0071e3; font-weight: 600; text-decoration: none; }
    .note { background: #fff4e5; color: #8a4b00; border-radius: 10px; padding: 8px 10px; font-size: 13px; margin-top: 10px; }
    .note.ok { background: #e3f6e9; color: #0b7a35; }
    .upd { display: flex; align-items: center; gap: 8px; background: #eaf3ff; color: #0058b0; border-radius: 10px; padding: 8px 10px; font-size: 13px; margin-bottom: 6px; }
    .upd button { margin-left: auto; border: 0; background: #0071e3; color: #fff; border-radius: 8px; padding: 5px 10px; font: 600 12.5px/1 inherit; font-family: inherit; cursor: pointer; }
  `;

  const host = document.createElement('div');
  host.id = 'comps-panel';
  const root = host.attachShadow({ mode: 'open' });
  // Built without HTML strings: Facebook blocks pages from inserting raw HTML.
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = CSS;
    root.append(style);
  }
  const panel = document.createElement('div');
  panel.className = 'p';
  root.append(panel);

  function h(tagName, attrs = {}, ...kids) {
    const el = document.createElement(tagName);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked') el[k] = v;
      else if (v != null && v !== false) el.setAttribute(k, v === true ? '' : v);
    }
    el.append(...kids.flat(3).filter((x) => x != null && x !== false));
    return el;
  }

  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
  const pageDeals = () => [...listings.values()].filter((x) => x.match?.deal && x.listing.status === 'active')
    .sort((a, b) => ((b.match.value ?? b.match.low) - b.listing.price) - ((a.match.value ?? a.match.low) - a.listing.price));

  function showListing(id) {
    const el = linksById().get(id)?.[0];
    if (!el) { window.open(fbUrl(id), '_blank'); return; }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.animate([{ boxShadow: '0 0 0 6px #34c759' }, { boxShadow: '0 0 0 0 transparent' }], { duration: 1600 });
  }

  function itemBlock() {
    const x = itemId() && listings.get(itemId());
    if (!x?.priced) return null;
    const m = x.match;
    if (!m) return h('div', { class: 'item' }, h('div', { class: 'muted' }, 'Comps couldn’t tell which card this is from the listing.'));
    const worth = m.confident ? money(m.value) : `${money(m.low)}–${money(m.high)}`;
    const verdict = m.fake ? h('span', { class: 'muted' }, 'Price looks fake; ignored')
      : m.deal ? h('span', { class: 'good' }, `${Math.round(m.discount * 100)}% under value`)
      : m.discount != null && m.discount <= -0.15 ? h('span', { class: 'bad' }, `${Math.round(-m.discount * 100)}% over value`)
      : x.listing.price ? h('span', { class: 'muted' }, 'About fair') : null;
    return h('div', { class: 'item' },
      h('div', { class: 'nm' }, `${m.card.name}${m.grade ? ` · ${m.grade}` : ''}`),
      h('div', { class: 'muted' }, `${m.card.set} #${m.card.number}${m.confident ? '' : ` · or ${m.matches - 1} similar`}`),
      h('div', { class: 'val' }, `Worth ${worth}`), verdict,
      h('a', { class: 'link', href: siteUrl(`card/${encodeURIComponent(m.card.id)}`), target: '_blank', rel: 'noopener' }, 'Prices & history on Comps ↗'));
  }

  function searchBlock() {
    const s = info?.settings;
    if (!s) return null;
    const running = scan?.running;
    const lastRun = info.lastScan;
    const n = info.searches.length;
    const action = running && scanning
      ? [h('div', { class: 'status' }, h('div', { class: 'spin' }), `Searching “${scan.list[scan.i].q}” (${scan.i + 1} of ${scan.list.length})`), h('button', { class: 'big stop', onclick: stopScan }, 'Stop')]
      : running
        ? [h('div', { class: 'status' }, h('div', { class: 'spin' }), scan.mode === 'monitor' ? 'Checking for new deals in the background…' : 'Searching in another tab…'), h('button', { class: 'big stop', onclick: stopScan }, 'Stop')]
        : [h('button', { class: 'big', onclick: () => send({ type: 'scan:start', here: true }), disabled: !n }, `▶ Search now (${n} search${n === 1 ? '' : 'es'})`),
          h('div', { class: 'sub' }, 'Newest listings first, near your Marketplace location. Fake prices ($0, free, 123, 9999…) are ignored.')];
    return [
      h('h4', {}, 'Search Marketplace for'),
      h('div', { class: 'chips' }, info.presets.map((p) => h('button', {
        class: 'chip', 'aria-pressed': String(s.presets.includes(p.id)),
        onclick: () => saveSettings({ presets: s.presets.includes(p.id) ? s.presets.filter((x) => x !== p.id) : [...s.presets, p.id] }),
      }, p.label))),
      h('input', { class: 'full', type: 'text', placeholder: 'Also search for… (e.g. lugia, giratina)', value: s.custom, onchange: (e) => saveSettings({ custom: e.target.value }) }),
      h('div', { class: 'row' },
        h('input', { type: 'number', min: '0', placeholder: '$ min', value: s.minPrice, onchange: (e) => saveSettings({ minPrice: e.target.value }), 'aria-label': 'Lowest price' }),
        h('input', { type: 'number', min: '0', placeholder: '$ max', value: s.maxPrice, onchange: (e) => saveSettings({ maxPrice: e.target.value }), 'aria-label': 'Highest price' }),
        h('select', { onchange: (e) => saveSettings({ days: e.target.value }), 'aria-label': 'Listed' },
          [['1', 'Last 24 h'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['', 'Any time']].map(([v, label]) => h('option', { value: v, selected: String(s.days) === v }, label)))),
      action,
      h('label', { class: 'auto' },
        h('input', { type: 'checkbox', checked: Boolean(s.monitor), onchange: (e) => saveSettings({ monitor: e.target.checked }) }),
        'Check by itself every',
        h('select', { onchange: (e) => saveSettings({ every: Number(e.target.value) }), 'aria-label': 'How often' },
          [15, 30, 60, 180].map((v) => h('option', { value: String(v), selected: Number(s.every) === v }, v < 60 ? `${v} min` : `${v / 60} h`)))),
      s.monitor ? h('div', { class: 'sub' }, 'While Chrome is open, it checks your searches in a background tab and alerts you to new deals.') : null,
      scan?.note === 'blocked' ? h('div', { class: 'note' }, 'Couldn’t see any listings. Make sure you’re logged in to Facebook, then try again.') : null,
      !running && lastRun ? h('div', { class: 'note ok' }, `Last ${lastRun.mode === 'monitor' ? 'check' : 'search'} ${ago(lastRun.at)}: ${lastRun.priced} cards priced, ${lastRun.deals} deals${lastRun.newDeals ? `, ${lastRun.newDeals} new` : ''}.`) : null,
    ];
  }

  let shown = '';
  function render() {
    if (!onMarketplace()) { host.remove(); return; }
    if (!host.isConnected) document.documentElement.appendChild(host);
    // Don't redraw under someone typing in the panel.
    if (root.activeElement && /^(INPUT|SELECT)$/.test(root.activeElement.tagName)) return;
    const deals = pageDeals();
    const priced = [...listings.values()].filter((x) => x.match && !x.match.fake).length;
    // Facebook's page changes constantly; only redraw when what the panel shows has changed.
    const key = JSON.stringify([enabled, open, scanning, scan, info, location.pathname, priced, deals.map((x) => x.listing.id + x.listing.price), itemId() && listings.get(itemId())?.match?.card.id]);
    if (key === shown) return;
    shown = key;
    panel.className = `p${open ? '' : ' min'}`;
    const head = h('div', { class: 'hd', onclick: () => { open = !open; render(); } },
      h('div', { class: 'logo' }, 'C'), h('div', { class: 'ttl' }, 'Comps'),
      deals.length ? h('span', { class: 'pill' }, `${deals.length} deal${deals.length === 1 ? '' : 's'}`) : null,
      h('button', { class: 'x', title: open ? 'Minimize' : 'Open' }, open ? '▾' : '▴'));
    const body = enabled ? [
      info?.update ? h('div', { class: 'upd' }, `Update ready (${info.update})`, h('button', { onclick: () => send({ type: 'open:update' }) }, 'Install')) : null,
      itemBlock(),
      searchBlock(),
      h('div', { class: 'nums' },
        h('div', { class: 'num' }, h('b', {}, String(priced)), h('span', {}, 'cards priced here')),
        h('div', { class: 'num' }, h('b', { class: 'good' }, String(deals.length)), h('span', {}, 'deals here'))),
      deals.length ? h('h4', {}, 'Best deals here') : null,
      deals.slice(0, 6).map((x) => h('div', { class: 'deal', onclick: () => showListing(x.listing.id), title: x.listing.title },
        x.listing.image ? h('img', { src: x.listing.image, alt: '' }) : h('div', { class: 'ph' }),
        h('div', { class: 'm' }, h('div', { class: 't' }, x.match.card.name + (x.match.grade ? ` · ${x.match.grade}` : '')), h('div', { class: 's' }, x.listing.location ?? x.listing.title)),
        h('div', { class: 'r' }, h('b', {}, money(x.listing.price)), h('span', { class: 'good' }, `▼${Math.round(x.match.discount * 100)}%`)))),
      h('a', { class: 'link', href: siteUrl('deals?kind=marketplace'), target: '_blank', rel: 'noopener' }, 'All Marketplace deals on Comps ↗'),
    ] : [
      h('div', { class: 'sub', style: 'margin:0 0 4px' }, 'Comps price tags are switched off.'),
      h('button', { class: 'big', onclick: () => saveSettings({ enabled: true }) }, 'Turn them on'),
    ];
    panel.replaceChildren(head, h('div', { class: 'bd' }, body));
  }
  root.addEventListener('focusout', () => setTimeout(render, 0));

  // ------------------------------------------------------------ wiring

  async function refresh() {
    const s = await send({ type: 'summary' });
    if (!s) return;
    enabled = s.settings.enabled !== false;
    info = { settings: s.settings, presets: s.presets, searches: s.searches, site: s.site, update: s.update, lastScan: s.lastScan };
    if (!scanning) scan = s.scan;
    render();
  }

  let timer = 0;
  let lastUrl = '';
  const soon = () => { clearTimeout(timer); timer = setTimeout(tick, 500); };

  async function tick() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (onMarketplace()) {
        const res = await send({ type: 'scan:get' });
        scan = res?.scan ?? scan;
        if (res?.mine && !scanning) runScan();
      }
    }
    if (!onMarketplace()) { host.remove(); return; }
    if (!scanning) await priceNew();
    render();
  }

  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== 'local') return;
    if (c.enabled) {
      enabled = c.enabled.newValue !== false;
      if (enabled) { for (const x of listings.values()) x.priced = false; soon(); } else { clearTags(); render(); }
    }
    if (c.lastScan || c.update || c.monitor || c.presets || c.custom) refresh();
  });
  new MutationObserver(soon).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(() => { if (location.href !== lastUrl) soon(); }, 1000);
  setInterval(() => { if (onMarketplace() && document.visibilityState === 'visible') refresh(); }, 10_000);
  window.postMessage({ source: 'comps-ext', type: 'fb:resend' }, location.origin); // listings the page loaded before this script started
  refresh().then(soon);
})();
