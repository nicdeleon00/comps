// Fetch layer: token auth, an in-memory cache and a stale-while-revalidate hook.

import { useEffect, useState, useRef } from 'preact/hooks';

const cache = new Map<string, { at: number; data: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
const listeners = new Set<() => void>();

export function token(): string {
  try { return localStorage.getItem('comps.token') ?? ''; } catch { return ''; }
}
export function setToken(t: string) {
  try { localStorage.setItem('comps.token', t); } catch {}
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('comps:unauthorized'));
    throw new HttpError(401, 'Unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status, (data as any)?.error ?? res.statusText);
  return data as T;
}

export const get = <T,>(url: string) => request<T>('GET', url);
export const post = <T,>(url: string, body?: unknown) => request<T>('POST', url, body ?? {});
export const put = <T,>(url: string, body?: unknown) => request<T>('PUT', url, body ?? {});
export const patch = <T,>(url: string, body?: unknown) => request<T>('PATCH', url, body ?? {});
export const del = <T,>(url: string) => request<T>('DELETE', url);

/** Warm the cache (used on hover so navigation feels instant). */
export function prefetch(url: string) {
  const c = cache.get(url);
  if (c && Date.now() - c.at < 30_000) return;
  load(url).catch(() => {});
}

function load(url: string) {
  let p = inflight.get(url);
  if (!p) {
    p = get(url).then((data) => {
      cache.set(url, { at: Date.now(), data });
      return data;
    }).finally(() => inflight.delete(url));
    inflight.set(url, p);
  }
  return p;
}

export function peek<T>(url: string): T | undefined {
  return cache.get(url)?.data as T | undefined;
}

/** Drop cached responses (prefix match) and tell mounted hooks to refetch. */
export function invalidate(prefix = '/api/') {
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
  listeners.forEach((l) => l());
}

export function useData<T>(url: string | null, { refresh = 0 }: { refresh?: number } = {}) {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>(() => ({ data: url ? peek<T>(url) : undefined, loading: Boolean(url) }));
  const urlRef = useRef(url);
  urlRef.current = url;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const l = () => setTick((t) => t + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);

  useEffect(() => {
    if (!url) return;
    const cached = peek<T>(url);
    setState((s) => ({ data: cached ?? (s.data as T | undefined), loading: true }));
    let live = true;
    load(url).then(
      (data) => live && urlRef.current === url && setState({ data: data as T, loading: false }),
      (error) => live && setState((s) => ({ ...s, error, loading: false })),
    );
    return () => { live = false; };
  }, [url, tick]);

  useEffect(() => {
    if (!refresh || !url) return;
    const id = setInterval(() => { cache.delete(url); setTick((t) => t + 1); }, refresh);
    return () => clearInterval(id);
  }, [refresh, url]);

  return { ...state, reload: () => { if (url) cache.delete(url); setTick((t) => t + 1); } };
}
