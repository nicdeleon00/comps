import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import './styles.css';
import './pages.css';
import { useLocation, Link } from './lib/router';
import { useData, setToken, invalidate, STATIC } from './lib/api';
import { startSync } from './lib/sync';
import { ago, num } from './lib/format';
import type { Status } from './lib/types';
import { Mark, IconMarket, IconTag, IconSlab, IconStack, IconStar, IconGear, IconSearch, IconBinder } from './components/icons';
import { Palette, openPalette, type PaletteOpts } from './components/Palette';
import { Sheet, Field } from './components/ui';
import { MarketPage, lastRefresh } from './pages/Market';
import { DealsPage } from './pages/Deals';
import { GradingPage } from './pages/Grading';
import { CardPage } from './pages/CardPage';
import { CollectionPage } from './pages/Collection';
import { WatchlistPage } from './pages/Watchlist';
import { SettingsPage } from './pages/Settings';
import { SetsPage, SetPage } from './pages/Sets';

const NAV = [
  { href: '/', label: 'Market', short: 'Market', icon: IconMarket, tab: true },
  { href: '/deals', label: 'Deals', short: 'Deals', icon: IconTag, count: 'deals' as const, tab: true },
  { href: '/grading', label: 'Raw to Graded', short: 'Grading', icon: IconSlab, count: 'spreads' as const, tab: true },
  { href: '/sets', label: 'Sets', short: 'Sets', icon: IconBinder, tab: true },
  { href: '/collection', label: 'Collection', short: 'Collection', icon: IconStack, count: 'holdings' as const, tab: true },
  { href: '/watchlist', label: 'Watchlist', short: 'Watchlist', icon: IconStar, tab: false },
];

function route(path: string) {
  if (path === '/') return { title: 'Market', el: <MarketPage /> };
  if (path === '/deals') return { title: 'Deals', el: <DealsPage /> };
  if (path === '/grading') return { title: 'Raw to Graded', el: <GradingPage /> };
  if (path === '/collection') return { title: 'Collection', el: <CollectionPage /> };
  if (path === '/watchlist') return { title: 'Watchlist', el: <WatchlistPage /> };
  if (path === '/settings') return { title: 'Settings', el: <SettingsPage /> };
  if (path === '/sets') return { title: 'Sets', el: <SetsPage /> };
  const set = /^\/sets\/([^/]+)$/.exec(path);
  if (set) return { title: 'Set', el: <SetPage id={decodeURIComponent(set[1])} key={set[1]} /> };
  const m = /^\/card\/(.+)$/.exec(path);
  if (m) { const id = decodeURIComponent(m[1]); return { title: '', el: <CardPage id={id} key={id} /> }; }
  return { title: 'Not found', el: <div class="page"><h1>Not found</h1></div> };
}

function isActive(href: string, path: string) {
  return href === '/' ? path === '/' : path.startsWith(href);
}

function Freshness({ st }: { st?: Status }) {
  if (!st) return null;
  const err = st.jobs.find((j) => j.status === 'error');
  const t = lastRefresh(st);
  return (
    <div class="freshness" title={err ? `${err.name}: ${err.message}` : undefined}>
      <span class={`dot ${st.running ? 'busy' : err ? 'err' : ''}`} />
      <span>{st.demo ? 'Sample data' : st.running ? `Refreshing ${st.running === 'all' ? 'prices' : st.running}…` : t ? `Prices ${ago(t)}` : 'Not refreshed yet'}</span>
    </div>
  );
}

function TokenPrompt({ onDone }: { onDone: () => void }) {
  const [v, setV] = useState('');
  return (
    <Sheet title="Access token" onClose={onDone} footer={(close) => <button class="btn primary" onClick={() => { setToken(v); invalidate('/api/'); close(); }}>Continue</button>}>
      <div class="sheet-body">
        <p class="muted" style={{ marginTop: 0, fontSize: 14 }}>This server is protected with <code>COMPS_TOKEN</code>. Enter it once; it's kept in this browser.</p>
        <Field label="Token"><input class="input" type="password" value={v} onInput={(e) => setV((e.target as HTMLInputElement).value)} /></Field>
      </div>
    </Sheet>
  );
}

function App() {
  const { path } = useLocation();
  const { data: st } = useData<Status>('/api/status', { refresh: 30_000 });
  const [palette, setPalette] = useState<PaletteOpts | null>(null);
  const [needToken, setNeedToken] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const r = route(path);

  useEffect(() => {
    const onPal = (e: Event) => setPalette((e as CustomEvent<PaletteOpts>).detail ?? {});
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
      else if (e.key === '/' && !(e.target as HTMLElement).closest('input,textarea,select')) { e.preventDefault(); openPalette(); }
    };
    const onAuth = () => setNeedToken(true);
    const onScroll = () => setScrolled(scrollY > 40);
    addEventListener('comps:palette', onPal);
    addEventListener('keydown', onKey);
    addEventListener('comps:unauthorized', onAuth);
    addEventListener('scroll', onScroll, { passive: true });
    return () => {
      removeEventListener('comps:palette', onPal);
      removeEventListener('keydown', onKey);
      removeEventListener('comps:unauthorized', onAuth);
      removeEventListener('scroll', onScroll);
    };
  }, []);

  useEffect(() => { document.title = r.title ? `${r.title} · Comps` : 'Comps'; }, [path]);

  return (
    <div class="shell">
      <aside class="sidebar">
        <Link href="/" class="brand"><span class="brand-mark-wrap" style={{ color: 'var(--label)' }}><Mark /></span>Comps<span class="brand-sub">Pokémon</span></Link>
        <button class="search-trigger" onClick={() => openPalette()}><IconSearch size={15} />Search<kbd>⌘K</kbd></button>
        {NAV.map((n) => (
          <Link href={n.href} class="nav-item" aria-current={isActive(n.href, path) ? 'page' : undefined}>
            <n.icon size={19} />{n.label}
            {n.count && st && st.counts[n.count] > 0 && <span class="count">{num(st.counts[n.count])}</span>}
          </Link>
        ))}
        <div class="sidebar-foot">
          <Link href="/settings" class="nav-item" aria-current={path === '/settings' ? 'page' : undefined}><IconGear size={19} />Settings</Link>
          <Freshness st={st} />
        </div>
      </aside>

      <main class="main">
        <div class={`mobile-top ${scrolled ? 'scrolled' : ''}`}>
          <Link href="/" aria-label="Comps home" style={{ color: 'var(--label)' }}><Mark size={24} /></Link>
          <span class="mt-title">{r.title}</span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button class="btn icon sm" style={{ background: 'none' }} onClick={() => openPalette()} aria-label="Search"><IconSearch size={19} /></button>
            <Link href="/watchlist" class="btn icon sm" style={{ background: 'none' }} aria-label="Watchlist"><IconStar size={19} /></Link>
            <Link href="/settings" class="btn icon sm" style={{ background: 'none' }} aria-label="Settings"><IconGear size={19} /></Link>
          </div>
        </div>
        {r.el}
      </main>

      <nav class="tabbar" aria-label="Sections">
        {NAV.filter((n) => n.tab).map((n) => (
          <Link href={n.href} class="tab" aria-current={isActive(n.href, path) ? 'page' : undefined}>
            <n.icon size={23} />{n.short}
          </Link>
        ))}
      </nav>

      {palette && <Palette opts={palette} onClose={() => setPalette(null)} />}
      {needToken && <TokenPrompt onDone={() => setNeedToken(false)} />}
    </div>
  );
}

render(<App />, document.getElementById('app')!);
// Keep the collection in step with the iPhone app (when sync is set up in Settings).
if (STATIC) startSync();
