// Runs on Facebook. On Marketplace pages it reads the listings you scroll past
// (title, price, location, link), asks Comps what each card is worth, and puts
// a small price tag on each one. It never scrolls, clicks or opens anything by
// itself; it only reads what's already on your screen.

(() => {
  const seen = new WeakMap(); // tile → listing text already handled
  const UNDER = 0.15;
  let timer = 0;
  let off = false;

  const money = (v) => (v >= 100 ? `$${Math.round(v).toLocaleString()}` : `$${v.toFixed(2)}`);
  const parsePrice = (s) => {
    // "$8" or a reduced price next to the old one ("$8$10"): the first is the asking price.
    const m = /^\s*\$\s?([\d,]+(?:\.\d{1,2})?)/.exec(s);
    return m ? Number(m[1].replace(/,/g, '')) || null : null;
  };

  /** Reads a listing tile: an <a href="/marketplace/item/123…"> holding price, title and location lines. */
  function readTile(a) {
    const idm = /\/marketplace\/item\/(\d+)/.exec(a.getAttribute('href') ?? '');
    if (!idm) return null;
    const lines = (a.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return null;
    let price = null;
    let i = 0;
    // Price first (a second, struck-through price may follow), then the title, then where.
    for (; i < lines.length && (/^\S*\$|^free$/i.test(lines[i]) || /^(just listed|sold|pending)$/i.test(lines[i])); i++) {
      if (price == null) price = parsePrice(lines[i]);
    }
    const title = lines[i];
    if (!title) return null;
    const img = a.querySelector('img');
    return { id: idm[1], url: `https://www.facebook.com/marketplace/item/${idm[1]}/`, title, price, location: lines[i + 1] ?? null, image: img?.src ?? null };
  }

  function badge(a, m, price) {
    a.querySelector(':scope .comps-tag')?.remove();
    if (!m) return;
    const tag = document.createElement('div');
    tag.className = 'comps-tag';
    let text;
    let tone = 'neutral';
    if (m.value == null) {
      text = m.grade ? `Comps: ${m.grade} — no graded price` : 'Comps: no price yet';
    } else {
      text = `Comps ${money(m.value)}${m.grade ? ` · ${m.grade}` : ''}`;
      if (m.discount != null) {
        const pct = Math.round(Math.abs(m.discount) * 100);
        if (m.discount >= UNDER) { tone = 'good'; text += ` · ${pct}% under`; }
        else if (m.discount <= -UNDER) { tone = 'bad'; text += ` · ${pct}% over`; }
        else text += ' · fair';
      }
    }
    if (!m.confident) text += ' (check card)';
    tag.textContent = text;
    tag.title = `${m.card.name} · ${m.card.set} #${m.card.number}${price ? ` · listed ${money(price)}` : ''}`;
    const colors = { good: ['#0a7d32', '#e8f7ee'], bad: ['#b42318', '#fdecea'], neutral: ['#3a3a3c', '#f2f2f7'] }[tone];
    Object.assign(tag.style, {
      position: 'absolute', left: '6px', top: '6px', zIndex: 3, maxWidth: 'calc(100% - 12px)', padding: '3px 7px', borderRadius: '7px',
      font: '600 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', color: colors[0], background: colors[1],
      boxShadow: '0 1px 3px rgba(0,0,0,.25)', pointerEvents: 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    });
    if (getComputedStyle(a).position === 'static') a.style.position = 'relative';
    a.appendChild(tag);
  }

  async function scan() {
    if (off || !location.pathname.startsWith('/marketplace')) return;
    const fresh = [];
    for (const a of document.querySelectorAll('a[href*="/marketplace/item/"]')) {
      const l = readTile(a);
      if (!l || seen.get(a) === `${l.id}|${l.title}|${l.price}`) continue;
      seen.set(a, `${l.id}|${l.title}|${l.price}`);
      fresh.push([a, l]);
    }
    if (!fresh.length) return;
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'match', listings: fresh.map(([, l]) => l) });
    } catch {
      return; // extension was reloaded; this page needs a refresh
    }
    if (res?.off) { off = true; return; }
    const byId = new Map((res?.results ?? []).map((r) => [r.id, r.match]));
    for (const [a, l] of fresh) badge(a, byId.get(l.id) ?? null, l.price);
  }

  const soon = () => { clearTimeout(timer); timer = setTimeout(scan, 500); };
  new MutationObserver(soon).observe(document.documentElement, { childList: true, subtree: true });
  chrome.storage.onChanged.addListener((c) => {
    if (c.enabled) { off = c.enabled.newValue === false; if (!off) soon(); else document.querySelectorAll('.comps-tag').forEach((t) => t.remove()); }
  });
  soon();
})();
