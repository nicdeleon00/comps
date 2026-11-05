const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const money = (v) => (v >= 100 ? `$${Math.round(v).toLocaleString()}` : `$${Number(v).toFixed(2)}`);
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

function row(f) {
  const li = document.createElement('li');
  const m = document.createElement('div');
  m.className = 'm';
  const t = document.createElement('div');
  t.className = 't';
  t.textContent = `${f.card.name}${f.grade ? ` · ${f.grade}` : ''}`;
  const s = document.createElement('div');
  s.className = 's';
  s.textContent = `${money(f.price)} · worth ${f.confident ? money(f.value) : `${money(f.low)}+`} · ${f.location ?? f.card.set}`;
  m.append(t, s);
  const buy = document.createElement('a');
  buy.className = 'buy';
  buy.href = f.url;
  buy.target = '_blank';
  buy.rel = 'noopener';
  buy.textContent = `▼${Math.round(f.discount * 100)}% Buy`;
  li.append(m, buy);
  return li;
}

async function render() {
  const { finds, scan, lastScan, settings, site } = await send({ type: 'summary' });
  const deals = finds.filter((f) => f.deal && f.status !== 'sold').sort((a, b) => ((b.value ?? b.low) - b.price) - ((a.value ?? a.low) - a.price));
  $('priced').textContent = finds.length.toLocaleString();
  $('deals').textContent = deals.length.toLocaleString();
  $('scan').textContent = scan?.running ? 'Stop searching' : '▶ Find deals for me';
  $('scan').className = scan?.running ? 'big stop' : 'big';
  $('status').textContent = scan?.running
    ? `Searching “${scan.queries[scan.qi]}” (${scan.qi + 1} of ${scan.queries.length}) · ${scan.priced} priced so far`
    : scan?.note === 'blocked' ? 'Couldn’t see listings. Log in to Facebook, then try again.'
    : lastScan ? `Last search ${ago(lastScan.at)}: ${lastScan.priced} priced, ${lastScan.deals} deals` : 'Opens Marketplace, scrolls through the newest listings near you and prices every card.';
  $('list').replaceChildren(...(deals.length ? deals.slice(0, 10).map(row) : [Object.assign(document.createElement('div'), { className: 'empty', textContent: 'No deals yet. Press the blue button, or just browse Marketplace.' })]));
  $('enabled').checked = settings.enabled;
  $('share').checked = settings.share;
  if (document.activeElement !== $('queries')) $('queries').value = settings.queries.join(', ');
  $('site').href = new URL('deals?kind=marketplace', site).href;
}

$('scan').addEventListener('click', async () => {
  const { scan } = await send({ type: 'summary' });
  if (scan?.running) await send({ type: 'scan:stop' });
  else { await send({ type: 'scan:start' }); window.close(); }
  render();
});
$('enabled').addEventListener('change', (e) => send({ type: 'settings:set', patch: { enabled: e.target.checked } }));
$('share').addEventListener('change', (e) => send({ type: 'settings:set', patch: { share: e.target.checked } }));
$('queries').addEventListener('change', (e) => {
  const queries = e.target.value.split(',').map((q) => q.trim()).filter(Boolean).slice(0, 6);
  send({ type: 'settings:set', patch: { queries: queries.length ? queries : ['pokemon cards'] } }).then(render);
});
render();
setInterval(render, 3000);
