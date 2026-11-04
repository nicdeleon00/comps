// Drops: product links the monitor checks, its live stock status, recent drops,
// and the devices that get alerts — stored per account (see supabase/schema.sql).
// The monitor on the site owner's PC reads everyone's links and writes status back.

import { rest } from './supabase';

export type Watch = { id: string; url: string; name?: string | null; maxPrice?: number | null; addedAt: number };
export type Device = { id: string; name: string; endpoint: string; keys: { p256dh: string; auth: string }; addedAt: number };
export type DropsFile = { watch: Watch[]; devices: Device[] };
export type StockState = 'in_stock' | 'preorder' | 'in_store' | 'out_of_stock' | 'unknown' | 'blocked' | 'error';
export type WatchStatus = { state: StockState; price: number | null; title: string | null; store: string; note?: string | null; checkedAt: number; changedAt: number };
export type DropEvent = { id: string; watchId: string; at: number; state: StockState; price: number | null; title: string | null; url: string; store: string };
export type MonitorFile = { seenAt: number; interval: number; vapidPublicKey: string | null; watching: number | null; status: Record<string, WatchStatus>; events: DropEvent[] };

/** Most links one account can watch (also enforced by the database). */
export const MAX_WATCH = 20;

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

const n = (v: unknown) => (v == null ? null : Number(v));

export async function loadDrops(): Promise<{ drops: DropsFile; monitor: MonitorFile | null }> {
  const [watch, devices, status, events, monitor] = await Promise.all([
    rest<any[]>('watch_items?select=id,url,name,max_price,added_at&order=added_at.desc'),
    rest<any[]>('push_devices?select=id,name,endpoint,p256dh,auth,added_at&order=added_at.desc'),
    rest<any[]>('drop_status?select=*'),
    rest<any[]>('drop_events?select=*&order=at.desc&limit=30'),
    rest<any[]>('monitor_state?select=*'),
  ]);
  const m = monitor[0];
  return {
    drops: {
      watch: watch.map((w) => ({ id: w.id, url: w.url, name: w.name, maxPrice: n(w.max_price), addedAt: Number(w.added_at) })),
      devices: devices.map((d) => ({ id: d.id, name: d.name ?? 'Device', endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth }, addedAt: Number(d.added_at) })),
    },
    monitor: m ? {
      seenAt: Number(m.seen_at ?? 0), interval: Number(m.interval_s ?? 30), vapidPublicKey: m.vapid_public_key ?? null, watching: n(m.watching),
      status: Object.fromEntries(status.map((x) => [x.watch_id, { state: x.state, price: n(x.price), title: x.title, store: x.store ?? '', note: x.note, checkedAt: Number(x.checked_at ?? 0), changedAt: Number(x.changed_at ?? 0) }])),
      events: events.map((e) => ({ id: e.id, watchId: e.watch_id, at: Number(e.at), state: e.state, price: n(e.price), title: e.title, url: e.url, store: e.store ?? '' })),
    } : null,
  };
}

export async function addWatch(w: { url: string; name?: string | null; maxPrice?: number | null }) {
  try {
    await rest('watch_items', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ url: w.url, name: w.name || null, max_price: w.maxPrice ?? null }) });
  } catch (e) {
    if ((e as { status?: number }).status === 409) throw new Error('You’re already watching that link.');
    throw e;
  }
}
export const removeWatch = (id: string) => rest(`watch_items?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
export const removeDevice = (endpoint: string) => rest(`push_devices?endpoint=eq.${encodeURIComponent(endpoint)}`, { method: 'DELETE' });

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
  await rest('push_devices?on_conflict=user_id,endpoint', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ name: deviceName(), endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }),
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
