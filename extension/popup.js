const DEFAULT_SITE = 'https://nicdeleon00.github.io/comps/';
const $ = (id) => document.getElementById(id);
const money = (v) => (v >= 100 ? `$${Math.round(v).toLocaleString()}` : `$${Number(v).toFixed(2)}`);

async function render() {
  const { finds = [], enabled = true } = await chrome.storage.local.get(['finds', 'enabled']);
  $('enabled').checked = enabled;
  const deals = finds.filter((f) => f.discount != null && f.discount >= 0.15).sort((a, b) => b.value - b.price - (a.value - a.price));
  $('count').textContent = `${finds.length} card${finds.length === 1 ? '' : 's'} priced · ${deals.length} under value`;
  $('empty').hidden = deals.length > 0;
  const list = $('list');
  list.replaceChildren(...deals.slice(0, 8).map((f) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = f.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = `${f.card.name} #${f.card.number}${f.grade ? ` · ${f.grade}` : ''}`;
    const sub = document.createElement('div');
    sub.className = 'sub';
    const good = document.createElement('span');
    good.className = 'good';
    good.textContent = `${Math.round(f.discount * 100)}% under`;
    sub.append(`${money(f.price)} · worth ${money(f.value)} · `, good);
    li.append(a, sub);
    return li;
  }));
}

$('enabled').addEventListener('change', (e) => chrome.storage.local.set({ enabled: e.target.checked }));
$('clear').addEventListener('click', async () => { await chrome.storage.local.set({ finds: [] }); render(); });
$('open').addEventListener('click', async () => {
  const { site } = await chrome.storage.local.get('site');
  chrome.tabs.create({ url: new URL('deals?kind=marketplace', site || DEFAULT_SITE).href });
});
render();
