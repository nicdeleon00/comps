import { useEffect, useState } from 'preact/hooks';
import { useData } from '../lib/api';
import { Link } from '../lib/router';
import { money, ago, longDate } from '../lib/format';
import { Empty, toast } from '../components/ui';
import { IconBolt, IconExternal, IconX, IconPhone } from '../components/icons';
import { Header } from './shared';
import { AccountPanel, useAccount } from '../components/Account';
import { accountsEnabled } from '../lib/supabase';
import {
  loadDrops, addWatch, removeWatch, removeDevice, enableAlerts, disableAlerts, currentEndpoint, pushSupported, isStandalone, isIOS,
  monitorOnline, storeOf, storeName, STATE_LABEL, BUYABLE, MAX_WATCH, type DropsFile, type MonitorFile, type Watch, type StockState,
} from '../lib/drops';

const REPO = (import.meta.env.VITE_REPO as string | undefined) ?? '';
type Data = { drops: DropsFile; monitor: MonitorFile | null };
type SetSummary = { id: string; name: string; series: string; released: string | null };

const pillClass = (s?: StockState) => (s && BUYABLE.has(s) ? 'on' : s === 'blocked' || s === 'error' ? 'warn' : 'off');

export function DropsPage() {
  const user = useAccount();
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const connected = Boolean(user);

  const reload = async () => {
    try { setData(await loadDrops()); setErr(''); } catch (e) { setErr((e as Error).message); }
  };
  useEffect(() => { if (!user) setData(null); }, [user?.id]);
  useEffect(() => {
    if (!connected) return;
    reload();
    const id = setInterval(() => { if (document.visibilityState === 'visible') reload(); }, 15_000);
    return () => clearInterval(id);
  }, [user?.id]);

  const m = data?.monitor ?? null;
  const online = monitorOnline(m);
  const watch = data?.drops.watch ?? [];
  const buyable = watch.filter((w) => BUYABLE.has(m?.status[w.id]?.state as StockState)).length;

  return (
    <div class="page drops">
      <Header title="Drops">
        {connected && data && <>
          <span class={`dot ${online ? '' : 'err'}`} style={{ display: 'inline-block', marginRight: 6 }} />
          <span>{online ? `Drop monitor running · checked ${ago(m!.seenAt)}` : m ? `Drop monitor offline · last seen ${ago(m.seenAt)}` : 'Drop monitor not started yet'}</span>
          <span class="faint">·</span><span>{watch.length} of {MAX_WATCH} links{buyable ? ` · ${buyable} buyable now` : ''}</span>
        </>}
      </Header>

      {!connected && (
        <section class="section">
          <p class="section-note">Sign in to watch product links and get an alert the moment one can be bought.</p>
          <div class="panel" style={{ padding: 16, maxWidth: 460 }}>{accountsEnabled ? <AccountPanel compact /> : <AccountPanel />}</div>
        </section>
      )}
      {err && <p class="section-note" style={{ color: 'var(--down)' }}>{err}</p>}

      {connected && data && <>
        {!online && <MonitorSetup monitor={m} />}
        <AddWatch onAdded={reload} full={watch.length >= MAX_WATCH} />
        <section class="section">
          <div class="section-head"><h2>Watching</h2></div>
          {!watch.length ? (
            <Empty icon={<IconBolt size={26} />} title="Nothing watched yet">
              Paste a product link above — an Elite Trainer Box, a booster bundle, a pre-order page. The monitor on your PC checks it every ~30 seconds and alerts you the moment it can be bought.
            </Empty>
          ) : (
            <div class="panel drop-list">
              {watch.map((w) => <WatchRow w={w} m={m} onRemoved={reload} />)}
            </div>
          )}
        </section>
        <Alerts data={data} onChange={reload} />
        {(m?.events.length ?? 0) > 0 && (
          <section class="section">
            <div class="section-head"><h2>Recent drops</h2></div>
            <div class="panel drop-list">
              {m!.events.slice(0, 20).map((e) => (
                <a class="drop-row" href={e.url} target="_blank" rel="noopener noreferrer">
                  <span class="status-pill on">{STATE_LABEL[e.state] ?? e.state}</span>
                  <div class="drop-main">
                    <div class="drop-title ellipsis">{e.title || e.url}</div>
                    <div class="drop-sub">{storeName(e.store)} · {new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
                  </div>
                  <span class="num drop-price">{money(e.price)}</span>
                </a>
              ))}
            </div>
          </section>
        )}
      </>}

      <Upcoming />
    </div>
  );
}

function WatchRow({ w, m, onRemoved }: { w: Watch; m: MonitorFile | null; onRemoved: () => void }) {
  const st = m?.status[w.id];
  const store = st?.store ?? storeOf(w.url);
  const title = w.name || st?.title || w.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 80);
  const [busy, setBusy] = useState(false);
  return (
    <div class="drop-row">
      <span class={`status-pill ${pillClass(st?.state)}`}>{st ? STATE_LABEL[st.state] : 'Waiting'}</span>
      <div class="drop-main">
        <a class="drop-title ellipsis" href={w.url} target="_blank" rel="noopener noreferrer">{title}</a>
        <div class="drop-sub">
          {storeName(store)}
          {w.maxPrice != null && <> · alert at {money(w.maxPrice)} or less</>}
          {st ? <> · checked {ago(st.checkedAt)}</> : <> · not checked yet</>}
          {st?.note && !BUYABLE.has(st.state) && <span class="drop-note"> · {st.note}</span>}
        </div>
      </div>
      <span class="num drop-price">{money(st?.price)}</span>
      <a class="btn icon sm" href={w.url} target="_blank" rel="noopener noreferrer" aria-label="Open store page"><IconExternal size={15} /></a>
      <button class="btn icon sm" disabled={busy} aria-label={`Stop watching ${title}`}
        onClick={async () => { setBusy(true); try { await removeWatch(w.id); onRemoved(); } catch (e) { toast((e as Error).message); } setBusy(false); }}>
        <IconX size={15} />
      </button>
    </div>
  );
}

function AddWatch({ onAdded, full }: { onAdded: () => void; full: boolean }) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [max, setMax] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = /^https?:\/\/[^\s]+\.[a-z]{2,}/i.test(url.trim());
  const submit = async (e: Event) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    try {
      await addWatch({ url: url.trim(), name: name.trim() || null, maxPrice: max ? Number(max.replace(/[$,]/g, '')) || null : null });
      setUrl(''); setName(''); setMax('');
      toast('Watching — the monitor picks it up within a minute');
      onAdded();
    } catch (x) { toast((x as Error).message); }
    setBusy(false);
  };
  return (
    <form class="panel drop-add" onSubmit={submit}>
      <input class="input" type="url" inputMode="url" placeholder="Paste a product link — Walmart, Best Buy, GameStop, Pokémon Center…" value={url}
        onInput={(e) => setUrl((e.target as HTMLInputElement).value)} aria-label="Product link" />
      <div class="drop-add-row">
        <input class="input" placeholder="Name (optional)" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} aria-label="Name" />
        <div class="input-wrap" style={{ width: 150 }}>
          <span class="prefix">$</span>
          <input class="input num" inputMode="decimal" placeholder="Max price" value={max} onInput={(e) => setMax((e.target as HTMLInputElement).value)} aria-label="Alert only at or under this price" />
        </div>
        <button class="btn primary" disabled={!valid || busy || full}>{busy ? 'Adding…' : 'Watch'}</button>
      </div>
      {full && <p class="drop-hint">You're watching {MAX_WATCH} links, the most per account. Remove one to add another.</p>}
      {valid && storeOf(url) === 'target' && <p class="drop-hint">Target doesn't put stock on its product pages, so the monitor can't tell when Target items are in stock yet.</p>}
    </form>
  );
}

function Alerts({ data, onChange }: { data: Data; onChange: () => void }) {
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { currentEndpoint().then(setEndpoint); }, []);
  const devices = data.drops.devices;
  const here = endpoint && devices.some((d) => d.endpoint === endpoint);
  const vapid = data.monitor?.vapidPublicKey;
  const iosBrowser = isIOS() && !isStandalone();

  const turnOn = async () => {
    if (!vapid) { toast('The drop monitor hasn’t been started yet'); return; }
    setBusy(true);
    try { setEndpoint(await enableAlerts(vapid)); toast('Alerts on — a test alert arrives within a minute'); onChange(); } catch (e) { toast((e as Error).message); }
    setBusy(false);
  };
  const turnOff = async () => {
    setBusy(true);
    try { await disableAlerts(); setEndpoint(null); onChange(); } catch (e) { toast((e as Error).message); }
    setBusy(false);
  };

  return (
    <section class="section">
      <div class="section-head"><h2>Alerts</h2></div>
      <p class="section-note">The drop monitor sends the alert straight to your devices the moment a watched product can be bought.</p>
      <div class="panel drop-list">
        {devices.map((d) => (
          <div class="drop-row">
            <span class="drop-icon"><IconPhone size={18} /></span>
            <div class="drop-main">
              <div class="drop-title">{d.name}{d.endpoint === endpoint ? ' (this device)' : ''}</div>
              <div class="drop-sub">Added {ago(d.addedAt)}</div>
            </div>
            <button class="btn sm" onClick={async () => { await removeDevice(d.endpoint); onChange(); }}>Remove</button>
          </div>
        ))}
        <div class="drop-row">
          <div class="drop-main">
            {iosBrowser ? (
              <div class="drop-sub" style={{ fontSize: 14 }}>
                <b>To get alerts on this iPhone:</b> tap <b>Share</b> → <b>Add to Home Screen</b>, open <b>Comps</b> from your Home Screen, sign in, then go to Drops and tap <b>Turn on alerts</b>. (iPhones only allow alerts for Home Screen web apps.)
              </div>
            ) : !pushSupported() ? (
              <div class="drop-sub" style={{ fontSize: 14 }}>This browser can't receive alerts. Use Chrome, Edge or Firefox on a computer, or Comps from your iPhone's Home Screen.</div>
            ) : (
              <div class="drop-sub" style={{ fontSize: 14 }}>{here ? 'This device gets drop alerts.' : 'Get drop alerts on this device.'}{!vapid ? ' (Waiting for the drop monitor to start.)' : ''}</div>
            )}
          </div>
          {!iosBrowser && pushSupported() && (
            here
              ? <button class="btn sm" disabled={busy} onClick={turnOff}>Turn off</button>
              : <button class="btn primary sm" disabled={busy || !vapid} onClick={turnOn}>{busy ? 'Turning on…' : 'Turn on alerts'}</button>
          )}
        </div>
      </div>
    </section>
  );
}

function MonitorSetup({ monitor }: { monitor: MonitorFile | null }) {
  const [open, setOpen] = useState(false);
  const zip = REPO ? `https://github.com/${REPO}/archive/refs/heads/main.zip` : '';
  return (
    <section class="section">
      <div class="panel drop-setup">
        <div class="g-title">{monitor ? 'The drop monitor is offline' : 'The drop monitor hasn’t started yet'}</div>
        <p class="g-desc">It runs on the site owner's computer and checks everyone's links about every 30 seconds while it's on. Your links are saved and will be checked as soon as it's back.</p>
        <button class="btn sm" style={{ marginTop: 10 }} onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Run it yourself (site owner)'}</button>
        {open && (
          <ol class="sync-steps">
            <li><div class="g-title">Install Node.js</div><div class="g-desc">The free <a href="https://nodejs.org" target="_blank" rel="noopener noreferrer">LTS version from nodejs.org</a>.</div></li>
            <li><div class="g-title">Download Comps</div><div class="g-desc">{zip ? <a href={zip}>Download the ZIP</a> : 'Download this repository'}, unzip it, and open the <b>monitor</b> folder.</div></li>
            <li><div class="g-title">Start it</div><div class="g-desc">Double-click <b>start-monitor.cmd</b> (Windows) or <b>start-monitor.command</b> (Mac). When it asks, paste your Supabase Project URL and <b>service_role</b> key (Supabase → Project Settings → API). Leave the window open.</div></li>
          </ol>
        )}
      </div>
    </section>
  );
}

function Upcoming() {
  const { data } = useData<{ items: SetSummary[] }>('/api/sets');
  const today = new Date().toISOString().slice(0, 10);
  const next = (data?.items ?? []).filter((s) => s.released && s.released > today).sort((a, b) => a.released!.localeCompare(b.released!)).slice(0, 6);
  if (!next.length) return null;
  return (
    <section class="section">
      <div class="section-head"><h2>Upcoming releases</h2></div>
      <div class="panel drop-list">
        {next.map((s) => {
          const days = Math.round((Date.parse(s.released! + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86_400_000);
          return (
            <Link class="drop-row" href={`/sets/${s.id}`}>
              <span class="status-pill free">{days <= 1 ? (days === 1 ? 'Tomorrow' : 'Today') : `${days} days`}</span>
              <div class="drop-main">
                <div class="drop-title">{s.name}</div>
                <div class="drop-sub">{s.series} · {longDate(s.released!)}</div>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

