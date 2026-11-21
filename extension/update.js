// Welcome page and updater. Chrome doesn't update extensions loaded from a folder,
// so this does it: with your OK (once), it downloads the newest version from the
// Comps site, writes it into the extension's folder and restarts the extension.

const SITE = 'https://nicdeleon00.github.io/comps/';
const NAME = 'Comps for Marketplace';
const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const mine = chrome.runtime.getManifest().version;

// ---------------------------------------------------------------- the remembered folder

function store() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('comps-updater', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function getFolder() {
  const db = await store();
  return new Promise((resolve) => {
    const q = db.transaction('kv').objectStore('kv').get('dir');
    q.onsuccess = () => resolve(q.result ?? null);
    q.onerror = () => resolve(null);
  });
}
async function saveFolder(dir) {
  const db = await store();
  return new Promise((resolve, reject) => {
    const t = db.transaction('kv', 'readwrite');
    t.objectStore('kv').put(dir, 'dir');
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

/** True when the folder really is this extension (its manifest names it). */
async function isOurs(dir) {
  try {
    const file = await (await dir.getFileHandle('manifest.json')).getFile();
    return JSON.parse(await file.text()).name === NAME;
  } catch {
    return false;
  }
}

async function permitted(dir, ask) {
  if (!dir) return false;
  const opts = { mode: 'readwrite' };
  if ((await dir.queryPermission(opts)) === 'granted') return true;
  return ask && (await dir.requestPermission(opts)) === 'granted';
}

/** Asks for the extension's folder (the one picked in "Load unpacked") and remembers it. */
async function pickFolder() {
  if (!window.showDirectoryPicker) throw new Error('This browser can’t update the extension by itself. Download the new version from the Comps website instead.');
  const dir = await window.showDirectoryPicker({ id: 'comps-marketplace', mode: 'readwrite' });
  if (!(await isOurs(dir))) throw new Error('That isn’t the comps-marketplace folder. Pick the folder you chose in “Load unpacked” (it has manifest.json in it).');
  await saveFolder(dir);
  return dir;
}

// ---------------------------------------------------------------- installing

async function latest() {
  const v = await fetch(new URL('extension/version.json', SITE), { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!v?.version || !Array.isArray(v.files)) throw new Error('Couldn’t reach the Comps website. Check your connection.');
  return v;
}

const newer = (a, b) => {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
};

async function install(dir, v) {
  // Download everything first, so a dropped connection never leaves half an update.
  const files = await Promise.all(v.files.map(async (path) => {
    if (!/^[\w-]+(\.[\w-]+)*(\/[\w-]+(\.[\w-]+)*)*$/.test(path)) throw new Error(`Unexpected file name: ${path}`);
    const res = await fetch(new URL(`extension/${path}`, SITE), { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Couldn’t download ${path} (HTTP ${res.status}).`);
    return [path, await res.arrayBuffer()];
  }));
  const manifest = files.find(([p]) => p === 'manifest.json');
  const m = manifest && JSON.parse(new TextDecoder().decode(manifest[1]));
  if (m?.name !== NAME || m.version !== v.version) throw new Error('The download didn’t look right. Try again later.');
  // The manifest goes last: Chrome only sees the new version once every file is in place.
  files.sort((a, b) => Number(a[0] === 'manifest.json') - Number(b[0] === 'manifest.json'));
  for (const [path, data] of files) {
    const parts = path.split('/');
    let folder = dir;
    for (const part of parts.slice(0, -1)) folder = await folder.getDirectoryHandle(part, { create: true });
    const w = await (await folder.getFileHandle(parts.at(-1), { create: true })).createWritable();
    await w.write(data);
    await w.close();
  }
  chrome.runtime.reload(); // restarts with the new files (this page closes)
}

// ---------------------------------------------------------------- the page

function show(...nodes) { $('body').replaceChildren(...nodes); }
function el(tag, props = {}, ...kids) { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; }
const error = (e) => el('p', { className: 'err', textContent: e.message || String(e) });

async function updateNow(v) {
  show(el('p', { textContent: `Installing version ${v.version}…` }));
  try {
    let dir = await getFolder();
    if (!(await permitted(dir, true))) dir = await pickFolder();
    await install(dir, v);
  } catch (e) {
    if (e?.name === 'AbortError') return renderUpdate(v);
    show(error(e), el('button', { textContent: 'Try again', onclick: () => updateNow(v) }));
  }
}

function renderUpdate(v) {
  $('title').textContent = 'Update ready';
  show(
    el('p', { textContent: `Version ${v.version} is ready (you have ${mine}). It installs in a few seconds.` }),
    el('button', { textContent: 'Update now', onclick: () => updateNow(v) }),
  );
}

async function renderWelcome() {
  $('title').textContent = 'You’re all set';
  const dir = await getFolder();
  const on = await permitted(dir, false);
  const updates = on
    ? el('p', { className: 'ok', textContent: '✓ Automatic updates are on.' })
    : el('div', {},
      el('p', { textContent: 'Turn on automatic updates: press the button and pick the comps-marketplace folder you chose in “Load unpacked”. You only do this once.' }),
      el('button', {
        textContent: 'Turn on automatic updates',
        onclick: async () => {
          try { await pickFolder(); renderWelcome(); } catch (e) { if (e?.name !== 'AbortError') $('body').append(error(e)); }
        },
      }));
  show(
    updates,
    el('ol', {},
      el('li', { textContent: 'Open Facebook Marketplace (you need to be logged in).' }),
      el('li', { textContent: 'The Comps panel appears in the bottom right: pick what to search for and press Search now.' }),
      el('li', { textContent: 'Every Pokémon card gets a price tag. Deals have a green outline and show up on the Comps website too.' })),
    el('a', { className: 'btn', href: 'https://www.facebook.com/marketplace/', textContent: 'Open Marketplace' }),
    el('a', { className: 'btn secondary', href: new URL('deals?kind=marketplace', SITE).href, textContent: 'Comps deals' }),
  );
}

async function main() {
  $('version').textContent = `Version ${mine}`;
  if (params.has('welcome')) return renderWelcome();
  let v;
  try { v = await latest(); } catch (e) { return show(error(e)); }
  if (!newer(v.version, mine)) {
    $('title').textContent = 'Up to date';
    return show(el('p', { className: 'ok', textContent: `✓ You have the newest version (${mine}).` }));
  }
  // Opened by the extension itself: install without a click if the folder is already allowed.
  if (params.has('auto') && (await permitted(await getFolder(), false))) return updateNow(v);
  renderUpdate(v);
}

main();
