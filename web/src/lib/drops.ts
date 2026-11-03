// Drops: product links watched by the monitor on your PC, its live stock status,
// recent drops, and the phones that get alerts. Shared through the sync gist:
//   comps-drops.json   watch list + phones (written here and by the iPhone app)
//   comps-monitor.json status + drops (written only by the PC monitor)

import { gh, syncState } from './sync';

export const DROPS_FILE = 'comps-drops.json';
export const MONITOR_FILE = 'comps-monitor.json';

export type Watch = { id: string; url: string; name?: string | null; maxPrice?: number | null; addedAt: number };
export type Device = { id: string; name: string; endpoint: string; keys: { p256dh: string; auth: string }; addedAt: number };
export type DropsFile = { v: 1; updatedAt: number; watch: Watch[]; devices: Device[] };
export type StockState = 'in_stock' | 'preorder' | 'in_store' | 'out_of_stock' | 'unknown' | 'blocked' | 'error';
export type WatchStatus = { state: StockState; price: number | null; title: string | null; store: string; via?: string | null; note?: string | null; checkedAt: number; changedAt: number };
export type DropEvent = { id: string; watchId: string; at: number; state: StockState; price: number | null; title: string | null; url: string; store: string };
export type MonitorFile = { v: 1; seenAt: number; startedAt: number; interval: number; vapidPublicKey: string; status: Record<string, WatchStatus>; events: DropEvent[]; dead?: string[] };

export const STORES: Record<string, string> = {
  target: 'Target', walmart: 'Walmart', bestbuy: 'Best Buy', pokemoncenter: 'Pokémon Center', gamestop: 'GameStop',
  amazon: 'Amazon', samsclub: "Sam's Club", costco: 'Costco', tcgplayer: 'TCGplayer',
};
export function storeOf(url: string) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    const hit = Object.keys(STORES).find((k) => host === `${k}.com` || host.endsWith(`.${k}.com`));
    return hit ?? host;
  } catch { return ''; }
}
export const storeName = (id: string) => STORES[id] ?? id;
export const STATE_LABEL: Record<StockState, string> = {
  in_stock: 'In stock', preorder: 'Pre-order', in_store: 'In store only', out_of_stock: 'Out of stock', unknown: 'Unknown', blocked: 'Blocked', error: 'Error',
};
export const BUYABLE = new Set<StockState>(['in_stock', 'preorder']);

/** The monitor counts as running if it checked in during the last 5 minutes. */
export const monitorOnline = (m: MonitorFile | null) => Boolean(m && Date.now() - m.seenAt < 5 * 60_000);

type GistFiles = Record<string, { content?: string; truncated?: boolean; raw_url?: string }>;

export async function loadDrops(): Promise<{ drops: DropsFile; monitor: MonitorFile | null }> {
  const s = syncState();
  const g = await gh<{ files: GistFiles }>(s.token!, `/gists/${s.gist}`);
  const parse = async (name: string) => {
    const f = g.files[name];
    if (!f) return null;
    let text = f.content ?? '';
    if (f.truncated && f.raw_url) text = await (await fetch(f.raw_url, { cache: 'no-store' })).text();
    try { return JSON.parse(text); } catch { return null; }
  };
  const d = (await parse(DROPS_FILE)) ?? {};
  return {
    drops: { v: 1, updatedAt: d.updatedAt ?? 0, watch: Array.isArray(d.watch) ? d.watch : [], devices: Array.isArray(d.devices) ? d.devices : [] },
    monitor: await parse(MONITOR_FILE),
  };
}

/** Read the latest list, change it, write it back (only the drops file). */
async function update(change: (d: DropsFile) => void) {
  const { drops, monitor } = await loadDrops();
  change(drops);
  // Phones that turned alerts off, as reported by the monitor.
  if (monitor?.dead?.length) drops.devices = drops.devices.filter((x) => !monitor.dead!.includes(x.endpoint));
  drops.updatedAt = Date.now();
  const s = syncState();
  await gh(s.token!, `/gists/${s.gist}`, { method: 'PATCH', body: JSON.stringify({ files: { [DROPS_FILE]: { content: JSON.stringify(drops) } } }) });
  return drops;
}

export const addWatch = (w: { url: string; name?: string | null; maxPrice?: number | null }) =>
  update((d) => {
    if (d.watch.some((x) => x.url === w.url)) return;
    d.watch.unshift({ id: crypto.randomUUID(), addedAt: Date.now(), url: w.url, name: w.name || null, maxPrice: w.maxPrice ?? null });
  });
export const removeWatch = (id: string) => update((d) => { d.watch = d.watch.filter((x) => x.id !== id); });
export const removeDevice = (endpoint: string) => update((d) => { d.devices = d.devices.filter((x) => x.endpoint !== endpoint); });

// ---------------------------------------------------------------- alerts on this device
export const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Windows/.test(ua)) return 'Windows browser';
  if (/Mac/.test(ua)) return 'Mac browser';
  return 'Browser';
}

const keyBytes = (b64: string) => {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64.length / 4) * 4, '='));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
const sameBytes = (a: ArrayBuffer | null | undefined, b: Uint8Array) => {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
};

export async function registerWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try { return await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }); } catch { return null; }
}

/** This device's alert subscription, if it has one. */
export async function currentEndpoint(): Promise<string | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
  return (await reg?.pushManager.getSubscription())?.endpoint ?? null;
}

/** Ask for permission (must run from a tap), subscribe, and register this device with the monitor. */
export async function enableAlerts(vapidPublicKey: string) {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications are off for Comps. Turn them on in Settings → Notifications → Comps, then try again.');
  const reg = (await registerWorker()) ?? (await navigator.serviceWorker.ready);
  await navigator.serviceWorker.ready;
  const key = keyBytes(vapidPublicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameBytes(sub.options.applicationServerKey, key)) { await sub.unsubscribe(); sub = null; }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const j = sub.toJSON();
  if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth) throw new Error("This browser didn't return a push subscription.");
  await update((d) => {
    d.devices = [{ id: crypto.randomUUID(), name: deviceName(), endpoint: j.endpoint!, keys: { p256dh: j.keys!.p256dh, auth: j.keys!.auth }, addedAt: Date.now() },
      ...d.devices.filter((x) => x.endpoint !== j.endpoint)];
  });
  return j.endpoint;
}

export async function disableAlerts() {
  const reg = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  await removeDevice(endpoint);
}
