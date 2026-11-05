const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const money = (v) => (v >= 100 ? `$${Math.round(v).toLocaleString()}` : `$${Number(v).toFixed(2)}`);
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const save = (patch) => send({ type: 'settings:set', patch }).then(render);

function dealRow(f) {
  return el('li', {},
    el('div', { className: 'm' },
      el('div', { className: 't', textContent: `${f.card.name}${f.grade ? ` · ${f.grade}` : ''}` }),
      el('div', { className: 's', textContent: `${money(f.price)} · worth ${f.confident ? money(f.value) : `${money(f.low)}+`} · ${f.location ?? f.card.set}` })),
    el('a', { href: f.url, target: '_blank', rel: 'noopener', textContent: `▼${Math.round(f.discount * 100)}% Buy` }));
}

/** Is it working? What it has read from Facebook, and anything that went wrong. */
function status({ scan, lastScan, stats }) {
  if (scan?.running) return el('div', { className: 'note', textContent: `${scan.mode === 'monitor' ? 'Checking in the background' : 'Searching'}: “${scan.list[scan.i].q}” (${scan.i + 1} of ${scan.list.length}) · ${scan.priced} priced so far` });
  if (scan?.note === 'blocked') return el('div', { className: 'note warn', textContent: 'Couldn’t see any listings. Log in to Facebook, then try again.' });
  const parts = [];
  if (stats.lastSeen) parts.push(`Read ${stats.seen ?? 0} listings from Marketplace (${stats.fromFacebook ?? 0} straight from Facebook’s data), last ${ago(stats.lastSeen)}. ${stats.shared ?? 0} shared with Comps.`);
  else parts.push('Nothing read yet: open Facebook Marketplace or press Search now.');
  if (lastScan) parts.push(`Last ${lastScan.mode === 'monitor' ? 'check' : 'search'} ${ago(lastScan.at)}: ${lastScan.priced} priced, ${lastScan.deals} deals.`);
  const box = el('div', { className: stats.lastSeen ? 'note ok' : 'note', textContent: parts.join(' ') });
  return stats.lastError ? [box, el('div', { className: 'note warn', textContent: `Problem: ${stats.lastError}` })] : box;
}

async function render() {
  const s = await send({ type: 'summary' });
  const set = s.settings;
  $('version').textContent = `Version ${s.version}`;
  $('update').replaceChildren(...(s.update ? [el('div', { className: 'note ok' }, `Version ${s.update} is ready. `, el('a', { href: '#', textContent: 'Install it', onclick: (e) => { e.preventDefault(); send({ type: 'open:update' }); } }))] : []));
  $('presets').replaceChildren(...s.presets.map((p) => el('button', {
    className: 'chip', textContent: p.label,
    onclick: () => save({ presets: set.presets.includes(p.id) ? set.presets.filter((x) => x !== p.id) : [...set.presets, p.id] }),
  })));
  [...$('presets').children].forEach((b, i) => b.setAttribute('aria-pressed', String(set.presets.includes(s.presets[i].id))));
  for (const id of ['custom', 'minPrice', 'maxPrice']) if (document.activeElement !== $(id)) $(id).value = set[id] ?? '';
  $('days').value = String(set.days ?? '');
  $('every').value = String(set.every);
  $('monitor').checked = set.monitor;
  $('enabled').checked = set.enabled;
  $('share').checked = set.share;
  $('scan').textContent = s.scan?.running ? 'Stop' : `▶ Search now (${s.searches.length} search${s.searches.length === 1 ? '' : 'es'})`;
  $('scan').className = s.scan?.running ? 'big stop' : 'big';
  $('scan').disabled = !s.scan?.running && !s.searches.length;
  $('status').replaceChildren(...[status(s)].flat());
  const deals = s.finds.filter((f) => f.deal && f.status !== 'sold').sort((a, b) => ((b.value ?? b.low) - b.price) - ((a.value ?? a.low) - a.price));
  $('priced').textContent = s.finds.length.toLocaleString();
  $('deals').textContent = deals.length.toLocaleString();
  $('list').replaceChildren(...(deals.length ? deals.slice(0, 10).map(dealRow) : [el('div', { className: 'sub', textContent: 'No deals yet. Press Search now, or just browse Marketplace.' })]));
  $('site').href = new URL('deals?kind=marketplace', s.site).href;
}

$('scan').addEventListener('click', async () => {
  const { scan } = await send({ type: 'summary' });
  if (scan?.running) await send({ type: 'scan:stop' });
  else { await send({ type: 'scan:start' }); window.close(); }
  render();
});
$('custom').addEventListener('change', (e) => save({ custom: e.target.value }));
$('minPrice').addEventListener('change', (e) => save({ minPrice: e.target.value }));
$('maxPrice').addEventListener('change', (e) => save({ maxPrice: e.target.value }));
$('days').addEventListener('change', (e) => save({ days: e.target.value }));
$('every').addEventListener('change', (e) => save({ every: Number(e.target.value) }));
$('monitor').addEventListener('change', (e) => save({ monitor: e.target.checked }));
$('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));
$('share').addEventListener('change', (e) => save({ share: e.target.checked }));
$('updates').addEventListener('click', async () => {
  $('updates').textContent = 'Checking…';
  const v = await send({ type: 'update:check' });
  $('updates').textContent = v ? `Installing ${v}…` : 'Up to date ✓';
  if (v) send({ type: 'open:update' });
});
send({ type: 'seen' });
render();
setInterval(render, 3000);
