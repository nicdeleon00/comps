// Talks to the "Comps for Marketplace" browser extension, which prices the
// Facebook Marketplace listings you scroll past and keeps them in your browser.

import { useEffect, useState } from 'preact/hooks';

export interface Find {
  id: string;
  url: string;
  title: string;
  price: number | null;
  location: string | null;
  image: string | null;
  seenAt: number;
  firstSeen?: number;
  card: { id: string; name: string; set: string; number: string; total: string | null; image: string };
  variant: string;
  grade: string | null;
  value: number | null;
  basis: string;
  discount: number | null;
  confident: boolean;
}

const post = (msg: Record<string, unknown>) => window.postMessage({ source: 'comps-site', ...msg }, location.origin);
const site = () => new URL(import.meta.env.BASE_URL, location.origin).href;

/** null while checking, false when the extension isn't installed. */
export function useMarketplace() {
  const [state, setState] = useState<{ installed: boolean | null; finds: Find[]; enabled: boolean; version?: string }>({ installed: null, finds: [], enabled: true });
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source !== window || e.data?.source !== 'comps-ext') return;
      if (e.data.type === 'mp:ready') post({ type: 'mp:get', site: site() });
      if (e.data.type === 'mp:finds') setState({ installed: true, finds: e.data.finds ?? [], enabled: e.data.enabled !== false, version: e.data.version });
    };
    addEventListener('message', on);
    post({ type: 'mp:get', site: site() });
    const t = setTimeout(() => setState((s) => (s.installed === null ? { ...s, installed: false } : s)), 1200);
    return () => { removeEventListener('message', on); clearTimeout(t); };
  }, []);
  return {
    ...state,
    remove: (id: string) => post({ type: 'mp:remove', id }),
    clear: () => post({ type: 'mp:clear' }),
    setEnabled: (enabled: boolean) => post({ type: 'mp:enabled', enabled }),
  };
}
