// history.json: every change in how many of a product each store has, kept for months, so the Stock
// screens can show when a store restocks, how much and how long it lasts. One point per change.
// The website and app read it (web/src/lib/stockHistory.ts, ios/Comps/Services/StockHistory.swift).

const KEEP = 120 * 86400_000;
const MAX_POINTS = 800;

/** How many of each product each store has now, for chains read this time: "store|product" -> count. */
function current(doc) {
  const out = new Map();
  for (const e of doc.stock) {
    const chain = e.s.split(':')[0];
    if (!doc.chains[chain]?.ok) continue;
    if (e.in) out.set(`${e.s}|${e.p}`, e.qty ?? 1);
  }
  return out;
}

/** Adds this check to the history and returns it. Starts from each entry's short log the first time. */
export function updateHistory(previous, doc, now = doc.updatedAt) {
  const series = {};
  for (const [k, pts] of Object.entries(previous?.series ?? {})) series[k] = pts.slice();
  if (!previous) {
    for (const e of doc.stock) {
      const pts = (e.log ?? []).filter((x) => Array.isArray(x) && x.length >= 2).map(([t, c]) => [t, c]);
      if (pts.length) series[`${e.s}|${e.p}`] = pts;
    }
  }
  const add = (key, value) => {
    const pts = (series[key] ??= []);
    const last = pts.at(-1);
    if (last && last[1] === value) return;
    if (last && last[0] >= now) { last[1] = value; return; }
    pts.push([now, value]);
  };
  const nowMap = current(doc);
  for (const [key, n] of nowMap) add(key, n);
  // Gone since the last check: only for products and stores really read this time.
  const stores = new Set(doc.stores.map((s) => s.id));
  for (const key of Object.keys(series)) {
    if (nowMap.has(key)) continue;
    const [store, product] = key.split('|');
    const chain = doc.chains[store.split(':')[0]];
    if (!chain?.ok || !stores.has(store)) continue;
    if (chain.checked && !chain.checked.includes(product)) continue;
    if ((series[key].at(-1)?.[1] ?? 0) > 0) add(key, 0);
  }
  // Older than four months goes, but the last point before then stays as the starting level.
  let start = now;
  for (const [key, pts] of Object.entries(series)) {
    let i = 0;
    while (i < pts.length - 1 && pts[i + 1][0] < now - KEEP) i++;
    let kept = pts.slice(i).slice(-MAX_POINTS);
    if (kept.length === 1 && kept[0][1] === 0 && kept[0][0] < now - KEEP) { delete series[key]; continue; }
    series[key] = kept;
    start = Math.min(start, kept[0][0]);
  }
  return { v: 1, updatedAt: now, start: Math.min(previous?.start ?? start, start), series };
}
