// Runs on the Comps website: lets the Deals page see what this browser found,
// start or stop a scan, and tidy the list. Only talks to the Comps page itself.

(() => {
  const post = (data) => window.postMessage({ source: 'comps-ext', ...data }, location.origin);
  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

  async function update() {
    const s = await send({ type: 'summary' });
    if (s) post({ type: 'mp:state', finds: s.finds, scan: s.scan, lastScan: s.lastScan, share: s.settings.share, version: chrome.runtime.getManifest().version });
    return s;
  }

  const actions = {
    'mp:get': update,
    'mp:scan': () => send({ type: 'scan:start' }),
    'mp:stop': () => send({ type: 'scan:stop' }),
    'mp:remove': (d) => send({ type: 'finds:remove', id: d.id }),
    'mp:clear': () => send({ type: 'finds:clear' }),
  };
  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.origin !== location.origin || e.data?.source !== 'comps-site') return;
    const act = actions[e.data.type];
    if (act) { await act(e.data); update(); }
  });

  // Live updates while a scan runs elsewhere.
  chrome.storage.onChanged.addListener(update);
  setInterval(async () => { if (document.visibilityState === 'visible') update(); }, 5000);
  post({ type: 'mp:ready' });
})();
