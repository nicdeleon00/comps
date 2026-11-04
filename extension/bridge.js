// Runs on the Comps website. Hands the Deals page the Marketplace listings this
// browser has seen, and tells the extension where the Comps prices live.
// Only answers the Comps page itself (same window, Comps message format).

(() => {
  const send = async () => {
    const { finds = [], enabled = true } = await chrome.storage.local.get(['finds', 'enabled']);
    window.postMessage({ source: 'comps-ext', type: 'mp:finds', finds, enabled, version: chrome.runtime.getManifest().version }, location.origin);
  };

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.origin !== location.origin || e.data?.source !== 'comps-site') return;
    const { type } = e.data;
    if (type === 'mp:get') {
      // Remember the site the user opened, so prices come from the same place.
      if (typeof e.data.site === 'string' && /^https:\/\//.test(e.data.site)) await chrome.storage.local.set({ site: e.data.site });
      await send();
    } else if (type === 'mp:remove') {
      const { finds = [] } = await chrome.storage.local.get('finds');
      await chrome.storage.local.set({ finds: finds.filter((f) => f.id !== e.data.id) });
    } else if (type === 'mp:clear') {
      await chrome.storage.local.set({ finds: [] });
    } else if (type === 'mp:enabled') {
      await chrome.storage.local.set({ enabled: Boolean(e.data.enabled) });
    }
  });

  chrome.storage.onChanged.addListener((c) => { if (c.finds || c.enabled) send(); });
  window.postMessage({ source: 'comps-ext', type: 'mp:ready' }, location.origin);
})();
