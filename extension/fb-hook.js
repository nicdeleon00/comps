// Runs inside Facebook's own page (not the extension's isolated world), only to
// read the Marketplace listing data Facebook already sends to this page: the
// first results embedded in the page, and the ones it fetches as you scroll.
// Structured data (title, price, place, photo, sold/pending) is far more reliable
// than reading text off the screen. It reads responses; it never changes or sends anything.

(() => {
  if (window.__compsHook) return;
  window.__compsHook = true;
  const MARK = 'marketplace_listing_title';
  const found = new Map(); // everything seen on this page, for a Comps script that starts listening later
  const post = (listings) => window.postMessage({ source: 'comps-fb', listings }, location.origin);

  const place = (l) => {
    const g = l.location?.reverse_geocode;
    if (g?.city && g?.state) return `${g.city}, ${g.state}`;
    return g?.city_page?.display_name ?? null;
  };
  const usd = (p) => {
    if (!p) return null;
    if (p.currency && p.currency !== 'USD') return null;
    if (p.formatted_amount && !/^\$/.test(p.formatted_amount.trim())) return null;
    const n = Number(p.amount ?? String(p.formatted_amount ?? '').replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  function collect(node, out, depth) {
    if (!node || typeof node !== 'object' || depth > 80) return;
    if (Array.isArray(node)) { for (const x of node) collect(x, out, depth + 1); return; }
    if (typeof node[MARK] === 'string' && /^\d{5,25}$/.test(String(node.id ?? ''))) {
      out.push({
        id: String(node.id),
        title: String(node.custom_title || node[MARK]).slice(0, 200),
        price: usd(node.listing_price),
        location: place(node),
        image: node.primary_listing_photo?.image?.uri ?? node.listing_photos?.[0]?.image?.uri ?? null,
        status: node.is_sold ? 'sold' : node.is_pending ? 'pending' : 'active',
        description: String(node.redacted_description?.text ?? node.description?.text ?? '').slice(0, 2000) || null,
      });
    }
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === 'object') collect(v, out, depth + 1);
    }
  }

  function scan(text) {
    if (typeof text !== 'string' || !text.includes(MARK)) return;
    const out = [];
    // A response can hold several JSON documents, one per line.
    for (const line of text.split('\n')) {
      if (!line.includes(MARK)) continue;
      try { collect(JSON.parse(line.replace(/^for \(;;\);/, '')), out, 0); } catch { /* not JSON */ }
    }
    if (!out.length) return;
    for (const l of out) found.set(l.id, l);
    post(out);
  }

  // The Comps script starts after the page's first listings arrived: hand it everything so far.
  addEventListener('message', (e) => {
    if (e.source === window && e.data?.source === 'comps-ext' && e.data.type === 'fb:resend' && found.size) post([...found.values()]);
  });

  // Results embedded in the page when it first loads (and in pieces streamed in later).
  const done = new WeakSet();
  const scanScripts = () => {
    for (const s of document.querySelectorAll('script[type="application/json"]')) {
      if (done.has(s)) continue;
      done.add(s);
      scan(s.textContent);
    }
  };
  document.addEventListener('DOMContentLoaded', scanScripts);
  addEventListener('load', scanScripts);
  let t = 0;
  new MutationObserver(() => { clearTimeout(t); t = setTimeout(scanScripts, 300); }).observe(document, { childList: true, subtree: true });

  // Results Facebook fetches as you scroll or search.
  const isGraphql = (u) => /\/api\/graphql/.test(String(u ?? ''));
  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = nativeFetch.call(this, input, init);
    if (isGraphql(input?.url ?? input)) p.then((r) => r.clone().text().then(scan, () => {}), () => {});
    return p;
  };
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__comps = isGraphql(url);
    return open.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__comps) {
      this.addEventListener('load', () => {
        try { if (this.responseType === '' || this.responseType === 'text') scan(this.responseText); } catch { /* unreadable */ }
      });
    }
    return send.apply(this, args);
  };
})();
