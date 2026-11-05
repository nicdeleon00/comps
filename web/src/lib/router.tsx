// Tiny History-API router with View Transitions and per-entry scroll restore.

import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { prefetch } from './api';

/** `bg` is the page a card was opened over (cards open as a panel on top of where you were). */
type Loc = { path: string; query: URLSearchParams; bg?: Loc | null };
/** "/comps" on GitHub Pages, "" when served at the root. */
export const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const withBase = (path: string) => (/^https?:/.test(path) ? path : BASE + path);
const listeners = new Set<(l: Loc) => void>();
const scrolls = new Map<string, number>();
let loc: Loc = parse(location.pathname + location.search, history.state?.bg);
// GitHub Pages serves 404.html for deep links; it's the same app, so just route.
let entryKey = (history.state?.key as string) ?? newKey();
let depth = (history.state?.depth as number) ?? 0;
if (!history.state?.key) history.replaceState({ key: entryKey, depth }, '');

function newKey() { return Math.random().toString(36).slice(2, 10); }
function parse(href: string, bg?: string | null): Loc {
  const u = new URL(href, location.origin);
  let path = u.pathname;
  if (BASE && path.startsWith(BASE)) path = path.slice(BASE.length) || '/';
  return { path, query: u.searchParams, bg: bg ? parse(bg) : null };
}

const hrefOf = (l: Loc) => l.path + (l.query.toString() ? `?${l.query}` : '');
const isCard = (path: string) => path.startsWith('/card/');

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
  // A card opens over the page you're on (or over the same page as the card before it).
  const bg = isCard(parse(to).path) ? (loc.bg ? hrefOf(loc.bg) : !isCard(loc.path) ? hrefOf(loc) : null) : null;
  const next = parse(to, bg);
  if (next.path + next.query.toString() === loc.path + loc.query.toString()) return;
  scrolls.set(entryKey, window.scrollY);
  const opensPanel = Boolean(bg) && !loc.bg;
  transition(() => {
    entryKey = newKey();
    if (replace) history.replaceState({ key: entryKey, bg, depth }, '', withBase(to));
    else history.pushState({ key: entryKey, bg, depth: ++depth }, '', withBase(to));
    loc = next;
    listeners.forEach((l) => l(loc));
    if (scroll && !opensPanel && !bg) window.scrollTo(0, 0);
  });
}

/** Back within the app when there's somewhere to go back to, else to `fallback`. */
export function goBack(fallback = '/') {
  if (depth > 0) history.back();
  else navigate(fallback, { replace: true });
}

/** Closes a card panel, returning to the page underneath exactly as it was. */
export function closePanel() {
  if (loc.bg) history.back();
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
  history.replaceState({ key: entryKey, depth }, '', withBase(to));
  loc = parse(withBase(to));
  listeners.forEach((l) => l(loc));
}

addEventListener('popstate', (e) => {
  scrolls.set(entryKey, window.scrollY);
  transition(() => {
    entryKey = (e.state?.key as string) ?? newKey();
    depth = (e.state?.depth as number) ?? 0;
    loc = parse(location.pathname + location.search, e.state?.bg);
    listeners.forEach((l) => l(loc));
    const y = scrolls.get(entryKey) ?? 0;
    requestAnimationFrame(() => window.scrollTo(0, y));
  });
});

/** The page's own location: the page underneath when a card panel is open. */
export function usePageLocation(): Loc {
  const l = useLocation();
  return l.bg ?? l;
}

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
      href={withBase(href)}
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
