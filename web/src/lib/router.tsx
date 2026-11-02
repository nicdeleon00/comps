// Tiny History-API router with View Transitions and per-entry scroll restore.

import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { prefetch } from './api';

type Loc = { path: string; query: URLSearchParams };
const listeners = new Set<(l: Loc) => void>();
const scrolls = new Map<string, number>();
let loc: Loc = parse(location.pathname + location.search);
let entryKey = (history.state?.key as string) ?? newKey();
if (!history.state?.key) history.replaceState({ key: entryKey }, '');

function newKey() { return Math.random().toString(36).slice(2, 10); }
function parse(href: string): Loc {
  const u = new URL(href, location.origin);
  return { path: u.pathname, query: u.searchParams };
}

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function transition(update: () => void) {
  type VT = { ready: Promise<void>; finished: Promise<void>; updateCallbackDone: Promise<void> };
  const doc = document as Document & { startViewTransition?: (cb: () => Promise<void> | void) => VT };
  if (doc.startViewTransition && !reduced() && document.visibilityState === 'visible') {
    const vt = doc.startViewTransition(() => new Promise<void>((resolve) => {
      update();
      // Preact renders on a microtask; give it a frame, but never stall the transition.
      requestAnimationFrame(() => setTimeout(resolve, 0));
      setTimeout(resolve, 120);
    }));
    const quiet = () => {};
    vt.ready.catch(quiet);
    vt.finished.catch(quiet);
    vt.updateCallbackDone.catch(quiet);
  } else update();
}

export function navigate(to: string, { replace = false, scroll = true } = {}) {
  const next = parse(to);
  if (next.path + next.query.toString() === loc.path + loc.query.toString()) return;
  scrolls.set(entryKey, window.scrollY);
  transition(() => {
    entryKey = newKey();
    if (replace) history.replaceState({ key: entryKey }, '', to);
    else history.pushState({ key: entryKey }, '', to);
    loc = next;
    listeners.forEach((l) => l(loc));
    if (scroll) window.scrollTo(0, 0);
  });
}

/** Update query params in place (filters) without a transition or scroll jump. */
export function setQuery(patch: Record<string, string | number | null | undefined>) {
  const q = new URLSearchParams(loc.query);
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === '' || v === 'all') q.delete(k);
    else q.set(k, String(v));
  }
  const s = q.toString();
  const to = loc.path + (s ? `?${s}` : '');
  history.replaceState({ key: entryKey }, '', to);
  loc = parse(to);
  listeners.forEach((l) => l(loc));
}

addEventListener('popstate', (e) => {
  scrolls.set(entryKey, window.scrollY);
  transition(() => {
    entryKey = (e.state?.key as string) ?? newKey();
    loc = parse(location.pathname + location.search);
    listeners.forEach((l) => l(loc));
    const y = scrolls.get(entryKey) ?? 0;
    requestAnimationFrame(() => window.scrollTo(0, y));
  });
});

export function useLocation(): Loc {
  const [l, set] = useState(loc);
  useEffect(() => {
    listeners.add(set);
    return () => { listeners.delete(set); };
  }, []);
  return l;
}

type LinkProps = JSX.HTMLAttributes<HTMLAnchorElement> & { href: string; prefetchUrl?: string; children?: ComponentChildren; replace?: boolean };

export function Link({ href, prefetchUrl, onClick, replace, ...rest }: LinkProps) {
  const external = /^https?:/.test(href);
  return (
    <a
      href={href}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      onMouseEnter={prefetchUrl ? () => prefetch(prefetchUrl) : undefined}
      onTouchStart={prefetchUrl ? () => prefetch(prefetchUrl) : undefined}
      onClick={(e) => {
        onClick?.(e as any);
        if (external || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(href, { replace });
      }}
      {...rest}
    />
  );
}

/** Marks the next card image to morph into the detail page hero. */
let heroId: string | null = null;
export const setHero = (id: string | null) => { heroId = id; };
export const getHero = () => heroId;
