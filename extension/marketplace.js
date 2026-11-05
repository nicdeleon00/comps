// Runs on Facebook. On Marketplace it reads the listings on screen, puts a Comps
// price tag on every Pokémon card, and shows a panel with the best deals. Press
// "Find deals" and it searches Marketplace for you, scrolling through the newest
// listings at a steady pace, then moves to the next search.

(() => {
  if (window.__compsMarketplace) return;
  window.__compsMarketplace = true;

  const STEP_MS = 2500;   // one scroll every 2.5 s
  const MAX_STEPS = 60;   // ~2.5 minutes per search
  const IDLE_STEPS = 4;   // no new listings after 4 scrolls = end of results
  const PRICE_LINE = /^(?:[A-Z]{1,3})?[$£€¥₹]|^free$/i;
  const SKIP_LINE = /^(just listed|partner listing|sponsored|shipping available|ships to you|free shipping|[·•]|\d+(\.\d+)?k?\s*(mi|miles|km)( away)?)$/i;

  const tiles = new Map(); // listing id → { sig, listing, match }
  let enabled = true;
  let scanning = false;
  let scan = null;         // background scan state
  let item = null;         // the open listing on /marketplace/item/… pages
  let collapsed = false;
  let site = 'https://nicdeleon00.github.io/comps/';

  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const onMarketplace = () => location.pathname.startsWith('/marketplace');
  const money = (v) => (v == null ? '—' : v >= 100 ? `$${Math.round(v).toLocaleString()}` : `$${v.toFixed(2)}`);
  const parsePrice = (s) => {
    const m = /^\s*\$\s?([\d,]+(?:\.\d{1,2})?)/.exec(s);
    return m ? Number(m[1].replace(/,/g, '')) || null : null;
  };

  // ------------------------------------------------------------ reading listings

  /** Listing links, grouped by listing (a tile can have one link on the photo and one on the text). */
  function listingLinks() {
    const groups = new Map();
    for (const a of document.querySelectorAll('a[href*="/marketplace/item/"]')) {
      const id = /\/marketplace\/item\/(\d+)/.exec(a.getAttribute('href') ?? '')?.[1];
      if (!id) continue;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(a);
    }
    return groups;
  }

  function readTile(id, links) {
    // Our own price tag sits inside the link; its text isn't part of the listing.
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
    let [title, location] = rest;
    // The photo's description reads "<title> in <City, ST>" when the text isn't rendered yet.
    if (!title && img?.alt) {
      const m = /^(.*)\s+in\s+([^,]+,\s*[A-Z]{2})$/.exec(img.alt.trim());
      [title, location] = m ? [m[1], m[2]] : [img.alt.trim(), null];
    }
    if (!title) return null;
    return { id, url: `https://www.facebook.com/marketplace/item/${id}/`, title: title.slice(0, 200), price, location: location?.slice(0, 80) ?? null, status, image: img?.src ?? null };
  }

  /** The open listing: title, price, and any card number written in the description. */
  function readItemPage() {
    const id = /\/marketplace\/item\/(\d+)/.exec(location.pathname)?.[1];
    if (!id) return null;
    const main = document.querySelector('[role="main"]') ?? document.body;
    const title = (main.querySelector('h1')?.innerText ?? document.title.replace(/^\(\d+\+?\)\s*/, '').replace(/^Marketplace\s*[–-]\s*/i, '').replace(/\s*\|\s*Facebook\s*$/i, '')).trim();
    if (!title) return null;
    const lines = (main.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const at = Math.max(0, lines.indexOf(title));
    const price = lines.slice(at, at + 6).map(parsePrice).find(Boolean) ?? null;
    const hint = /\b[A-Za-z]{0,4}\d{1,3}[a-z]?\s*\/\s*[A-Za-z]{0,4}\d{1,3}\b/.exec(lines.slice(at + 1).join(' '))?.[0] ?? null;
    const img = main.querySelector('img[src*="fbcdn"]');
    return { id, url: `https://www.facebook.com/marketplace/item/${id}/`, title: title.slice(0, 200), price, location: null, status: 'active', image: img?.src ?? null, hint };
  }

  // ------------------------------------------------------------ pricing

  async function priceNew() {
    if (!enabled || !onMarketplace()) return { priced: [], deals: [] };
    const fresh = [];
    for (const [id, links] of listingLinks()) {
      const l = readTile(id, links);
      if (!l) continue;
      const sig = `${l.title}|${l.price}|${l.status}`;
      const known = tiles.get(id);
      if (known?.sig === sig) { if (known.match) tag(links, known.match, l); continue; }
      tiles.set(id, { sig, listing: l, match: known?.match ?? null, links });
      fresh.push(l);
    }
    const priced = [];
    const deals = [];
    for (let i = 0; i < fresh.length; i += 60) {
      const res = await send({ type: 'match', listings: fresh.slice(i, i + 60) });
      if (res?.off) { enabled = false; clearTags(); break; }
      for (const r of res?.results ?? []) {
        const t = tiles.get(r.id);
        if (!t) continue;
        t.match = r.match;
        tag(t.links, r.match, t.listing);
        if (r.match) priced.push(r.id);
        if (r.match?.deal) deals.push(r.id);
      }
    }
    if (fresh.length) render();
    return { priced, deals };
  }

  async function priceItem() {
    const l = readItemPage();
    if (!l || (item?.listing.id === l.id && item.match)) return;
    item = { listing: l, match: null };
    const res = await send({ type: 'match', listings: [l] });
    item.match = res?.results?.[0]?.match ?? null;
    render();
  }

  // ------------------------------------------------------------ price tags

  const TONES = { deal: ['#0b7a35', '#e3f6e9'], over: ['#a33a00', '#fdeee4'], fair: ['#1d1d1f', 'rgba(255,255,255,.94)'], unsure: ['#3d4f7a', '#eaf0fb'] };

  function tagText(m, l) {
    if (!m) return null;
    if (m.value == null && m.low == null) return [m.grade ? `${m.grade} · no graded price yet` : 'Comps: no price yet', 'fair'];
    if (m.placeholder) return [`Worth ${money(m.value ?? m.low)} · price looks like a placeholder`, 'fair'];
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
    if (old && tt && old.textContent === tt[0]) return; // already tagged (re-adding would wake the page observer again)
    old?.remove();
    if (!tt) return;
    const [text, tone] = tt;
    const el = document.createElement('div');
    el.className = 'comps-tag';
    el.textContent = text;
    el.title = `Comps: ${m.card.name} · ${m.card.set} #${m.card.number}${m.matches > 1 ? ` (or ${m.matches - 1} similar cards)` : ''}`;
    const [fg, bg] = TONES[tone];
    Object.assign(el.style, {
      position: 'absolute', left: '8px', top: '8px', zIndex: 5, maxWidth: 'calc(100% - 16px)', padding: '4px 8px', borderRadius: '8px',
      font: '600 12.5px/1.25 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', color: fg, background: bg,
      boxShadow: '0 1px 4px rgba(0,0,0,.28)', pointerEvents: 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    });
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(el);
    host.style.outline = tone === 'deal' ? '3px solid #34c759' : '';
    host.style.outlineOffset = tone === 'deal' ? '-3px' : '';
  }

  function clearTags() {
    document.querySelectorAll('.comps-tag').forEach((t) => {
      t.parentElement.style.outline = '';
      t.remove();
    });
  }

  // ------------------------------------------------------------ automatic scans

  async function runScan() {
    if (scanning) return;
    scanning = true;
    render();
    const started = Date.now();
    let steps = 0;
    let idle = 0;
    let last = 0;
    while (scanning) {
      await sleep(STEP_MS);
      if (!scanning) break;
      const { priced, deals } = await priceNew();
      if (priced.length) scan = await send({ type: 'scan:progress', priced, deals });
      const count = listingLinks().size;
      if (!count && Date.now() - started > 15_000) {
        scanning = false;
        scan = await send({ type: 'scan:stop', note: 'blocked' });
        break;
      }
      idle = count > last ? 0 : idle + 1;
      last = count;
      if (idle >= IDLE_STEPS || ++steps >= MAX_STEPS) {
        scanning = false;
        scan = await send({ type: 'scan:next' }); // the tab moves on to the next search, or the scan is done
        break;
      }
      window.scrollBy({ top: Math.round(innerHeight * 0.85), behavior: 'smooth' });
      render();
    }
    render();
  }

  async function startScan() {
    scan = await send({ type: 'scan:start', here: true });
  }

  async function stopScan() {
    scanning = false;
    scan = await send({ type: 'scan:stop' });
    render();
  }

  // ------------------------------------------------------------ panel

  const host = document.createElement('div');
  host.id = 'comps-panel';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host { all: initial; }
    .p { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; width: 330px; max-height: min(560px, calc(100vh - 32px)); display: flex; flex-direction: column;
      background: rgba(255,255,255,.97); color: #1d1d1f; border-radius: 16px; box-shadow: 0 12px 40px rgba(0,0,0,.28), 0 0 0 .5px rgba(0,0,0,.12);
      font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; overflow: hidden; }
    .p.min { width: auto; }
    .hd { display: flex; align-items: center; gap: 9px; padding: 11px 12px 11px 14px; cursor: pointer; user-select: none; }
    .logo { width: 24px; height: 24px; border-radius: 7px; background: #0071e3; color: #fff; display: grid; place-items: center; font-weight: 800; font-size: 14px; flex: none; }
    .ttl { font-weight: 700; flex: 1; white-space: nowrap; }
    .pill { font-size: 12px; font-weight: 700; color: #0b7a35; background: #e3f6e9; border-radius: 99px; padding: 2px 8px; white-space: nowrap; }
    .x { border: 0; background: rgba(120,120,128,.14); color: #3a3a3c; width: 24px; height: 24px; border-radius: 50%; cursor: pointer; font-size: 14px; line-height: 1; }
    .bd { padding: 0 14px 14px; overflow: auto; }
    .min .bd { display: none; }
    .big { width: 100%; height: 44px; border: 0; border-radius: 12px; background: #0071e3; color: #fff; font: 700 15px/1 inherit; font-family: inherit; cursor: pointer; }
    .big:hover { background: #0062c4; }
    .big.stop { background: #ff3b30; }
    .sub { color: #6e6e73; font-size: 12.5px; margin: 7px 2px 0; }
    .status { display: flex; align-items: center; gap: 9px; margin-bottom: 10px; font-weight: 600; }
    .spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid #0071e3; border-right-color: transparent; animation: s .8s linear infinite; flex: none; }
    @keyframes s { to { transform: rotate(360deg); } }
    .nums { display: flex; gap: 8px; margin: 10px 0 2px; }
    .num { flex: 1; background: #f2f2f7; border-radius: 10px; padding: 7px 10px; }
    .num b { display: block; font-size: 18px; }
    .num span { font-size: 11.5px; color: #6e6e73; }
    .item { background: #f2f2f7; border-radius: 12px; padding: 10px 12px; margin-bottom: 12px; }
    .item .nm { font-weight: 700; }
    .item .val { font-size: 22px; font-weight: 800; margin-top: 2px; }
    .good { color: #0b7a35; } .bad { color: #a33a00; } .muted { color: #6e6e73; }
    h4 { margin: 14px 2px 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #6e6e73; }
    .deal { display: flex; gap: 10px; align-items: center; padding: 7px 4px; border-radius: 10px; cursor: pointer; }
    .deal:hover { background: #f2f2f7; }
    .deal img { width: 42px; height: 42px; border-radius: 8px; object-fit: cover; flex: none; background: #e5e5ea; }
    .deal .m { flex: 1; min-width: 0; }
    .deal .t { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .deal .s { font-size: 12px; color: #6e6e73; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .deal .r { text-align: right; font-size: 12.5px; flex: none; }
    .deal .r b { display: block; font-size: 14px; }
    a.link { display: block; text-align: center; margin-top: 12px; color: #0071e3; font-weight: 600; text-decoration: none; }
    .note { background: #fff4e5; color: #8a4b00; border-radius: 10px; padding: 8px 10px; font-size: 13px; margin-bottom: 10px; }
  </style><div class="p"></div>`;
  const panel = root.querySelector('.p');

  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v != null && v !== false) el.setAttribute(k, v === true ? '' : v);
    }
    el.append(...kids.flat().filter((k) => k != null && k !== false));
    return el;
  }

  const pageDeals = () => [...tiles.values()].filter((t) => t.match?.deal && t.listing.price && t.listing.status === 'active')
    .sort((a, b) => ((b.match.value ?? b.match.low) - b.listing.price) - ((a.match.value ?? a.match.low) - a.listing.price));

  function showTile(id) {
    const t = tiles.get(id);
    const el = t && listingLinks().get(id)?.[0];
    if (!el) { window.open(t?.listing.url ?? `https://www.facebook.com/marketplace/item/${id}/`, '_blank'); return; }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.animate([{ boxShadow: '0 0 0 6px #34c759' }, { boxShadow: '0 0 0 0 transparent' }], { duration: 1600 });
  }

  function itemBlock() {
    if (!item) return null;
    const m = item.match;
    const l = item.listing;
    if (!m) return h('div', { class: 'item' }, h('div', { class: 'muted' }, 'Comps couldn’t tell which card this is from the title.'));
    const worth = m.confident ? money(m.value) : `${money(m.low)}–${money(m.high)}`;
    const verdict = m.placeholder ? h('span', { class: 'muted' }, 'Price looks like a placeholder')
      : m.deal ? h('span', { class: 'good' }, `${Math.round(m.discount * 100)}% under value`)
      : m.discount != null && m.discount <= -0.15 ? h('span', { class: 'bad' }, `${Math.round(-m.discount * 100)}% over value`)
      : l.price ? h('span', { class: 'muted' }, 'About fair') : null;
    return h('div', { class: 'item' },
      h('div', { class: 'nm' }, `${m.card.name}${m.grade ? ` · ${m.grade}` : ''}`),
      h('div', { class: 'muted' }, `${m.card.set} #${m.card.number}${m.confident ? '' : ` · or ${m.matches - 1} similar`}`),
      h('div', { class: 'val' }, `Worth ${worth}`),
      verdict,
      h('a', { class: 'link', href: new URL(`card/${encodeURIComponent(m.card.id)}`, site).href, target: '_blank', rel: 'noopener' }, 'Prices & history on Comps ↗'));
  }

  let shown = '';
  function render() {
    if (!onMarketplace()) { host.remove(); return; }
    if (!host.isConnected) document.documentElement.appendChild(host);
    const deals = pageDeals();
    const priced = [...tiles.values()].filter((t) => t.match).length;
    // Facebook's page changes constantly; only redraw when what the panel shows has changed.
    const key = JSON.stringify([enabled, collapsed, scanning, scan, item?.listing.id, item?.match?.card.id, priced, deals.map((t) => t.listing.id + t.listing.price)]);
    if (key === shown) return;
    shown = key;
    panel.className = `p${collapsed ? ' min' : ''}`;
    const head = h('div', { class: 'hd', onclick: () => { collapsed = !collapsed; render(); } },
      h('div', { class: 'logo' }, 'C'), h('div', { class: 'ttl' }, 'Comps'),
      deals.length ? h('span', { class: 'pill' }, `${deals.length} deal${deals.length === 1 ? '' : 's'}`) : null,
      h('button', { class: 'x', title: collapsed ? 'Open' : 'Minimize' }, collapsed ? '▴' : '▾'));
    let body;
    if (!enabled) {
      body = [h('div', { class: 'sub', style: 'margin:0 0 10px' }, 'Price tags are switched off.'),
        h('button', { class: 'big', onclick: async () => { await send({ type: 'settings:set', patch: { enabled: true } }); enabled = true; tiles.clear(); priceNew(); render(); } }, 'Turn on price tags')];
    } else {
      const running = scan?.running;
      const mine = running && scanning;
      const status = mine
        ? [h('div', { class: 'status' }, h('div', { class: 'spin' }), `Searching “${scan.queries[scan.qi]}” (${scan.qi + 1} of ${scan.queries.length})`),
          h('button', { class: 'big stop', onclick: stopScan }, 'Stop')]
        : running
          ? [h('div', { class: 'sub', style: 'margin:0 0 10px' }, 'A scan is running in another tab.'), h('button', { class: 'big stop', onclick: stopScan }, 'Stop it')]
          : [scan?.note === 'blocked' ? h('div', { class: 'note' }, 'Couldn’t see any listings. Make sure you’re logged in to Facebook, then try again.') : null,
            scan && !running && scan.endedAt && scan.note !== 'blocked' ? h('div', { class: 'note', style: 'background:#e3f6e9;color:#0b7a35' }, `Done: ${scan.priced} cards priced, ${scan.deals} deals.`) : null,
            h('button', { class: 'big', onclick: startScan }, '▶ Find deals for me'),
            h('div', { class: 'sub' }, 'Searches Marketplace near you, scrolls through the newest listings and prices every card. Takes a few minutes; you can keep using your computer.')];
      body = [
        itemBlock(),
        ...status,
        h('div', { class: 'nums' },
          h('div', { class: 'num' }, h('b', {}, String(scan?.running ? scan.priced : priced)), h('span', {}, 'cards priced')),
          h('div', { class: 'num' }, h('b', { class: 'good' }, String(scan?.running ? scan.deals : deals.length)), h('span', {}, 'deals'))),
        deals.length ? h('h4', {}, 'Best deals here') : null,
        ...deals.slice(0, 6).map((t) => h('div', { class: 'deal', onclick: () => showTile(t.listing.id), title: t.listing.title },
          t.listing.image ? h('img', { src: t.listing.image, alt: '' }) : h('img', { alt: '' }),
          h('div', { class: 'm' }, h('div', { class: 't' }, t.match.card.name + (t.match.grade ? ` · ${t.match.grade}` : '')), h('div', { class: 's' }, t.listing.location ?? t.listing.title)),
          h('div', { class: 'r' }, h('b', {}, money(t.listing.price)), h('span', { class: 'good' }, `▼${Math.round(t.match.discount * 100)}%`)))),
        h('a', { class: 'link', href: new URL('deals?kind=marketplace', site).href, target: '_blank', rel: 'noopener' }, 'All Marketplace deals on Comps ↗'),
      ];
    }
    panel.replaceChildren(head, h('div', { class: 'bd' }, ...body));
  }

  // ------------------------------------------------------------ wiring

  let timer = 0;
  let lastUrl = '';
  const soon = () => { clearTimeout(timer); timer = setTimeout(tick, 600); };

  async function tick() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      item = null;
      if (onMarketplace()) {
        const res = await send({ type: 'scan:get' });
        scan = res?.scan ?? null;
        if (res?.mine && !scanning) runScan();
      }
      // An open listing: price it once its page has loaded (and once more in case it was slow).
      if (/\/marketplace\/item\//.test(location.pathname)) { setTimeout(priceItem, 1200); setTimeout(priceItem, 4000); }
    }
    if (!onMarketplace()) { host.remove(); return; }
    if (!scanning) await priceNew();
    render();
  }

  chrome.storage.onChanged.addListener((c) => {
    if (c.enabled) {
      enabled = c.enabled.newValue !== false;
      if (enabled) { tiles.clear(); soon(); } else { clearTags(); render(); }
    }
  });
  send({ type: 'summary' }).then((s) => {
    if (s?.site) site = s.site;
    enabled = s?.settings?.enabled !== false;
  });
  new MutationObserver(soon).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(() => { if (location.href !== lastUrl) soon(); }, 1000);
  soon();
})();
