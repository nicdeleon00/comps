import { useEffect, useState } from 'preact/hooks';
import { useData, put, post, invalidate, token, setToken, STATIC } from '../lib/api';
import { BASE } from '../lib/router';
import { ago, num } from '../lib/format';
import type { Status } from '../lib/types';
import { Field, MoneyInput, Segmented, toast } from '../components/ui';
import { IconRefresh } from '../components/icons';
import { Header } from './shared';
import { AccountPanel } from '../components/Account';

type S = Record<string, any>;

function Group({ id, title, note, children }: { id?: string; title: string; note?: string; children: preact.ComponentChildren }) {
  return (
    <section class="group" id={id}>
      <h2>{title}</h2>
      {note && <p class="section-note" style={{ marginTop: 4 }}>{note}</p>}
      <div class="group-body panel">{children}</div>
    </section>
  );
}

function KeyRow({ label, desc, k, s, status, href, onSave }: { label: string; desc: string; k: string; s: S; status: 'on' | 'off' | 'free'; href?: string; onSave: (patch: S) => Promise<void> }) {
  const [v, setV] = useState('');
  const env = s.fromEnv?.[k];
  return (
    <div class="g-row">
      <div class="g-main">
        <div class="g-title">{label} <span class={`status-pill ${status}`}>{status === 'on' ? 'Connected' : status === 'free' ? 'No key needed' : 'Not set'}</span></div>
        <div class="g-desc">{desc}{href && <> <a href={href} target="_blank" rel="noopener noreferrer">Get a key</a></>}</div>
      </div>
      <div class="g-ctl">
        {env ? <span class="faint" style={{ fontSize: 13 }}>Set by environment</span> : (
          <form onSubmit={async (e) => { e.preventDefault(); await onSave({ [k]: v }); setV(''); }} style={{ display: 'flex', gap: 8 }}>
            <input class="input sm" type="password" autocomplete="off" placeholder={s[k] || 'Paste key'} value={v} onInput={(e) => setV((e.target as HTMLInputElement).value)} style={{ width: 190 }} aria-label={label} />
            <button class="btn sm" disabled={!v}>Save</button>
          </form>
        )}
      </div>
    </div>
  );
}

function Qr({ text }: { text: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let live = true;
    import('qrcode-generator').then(({ default: qrcode }) => {
      const qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      const n = qr.getModuleCount();
      let d = '';
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c},${r}h1v1h-1z`;
      if (live) setSvg(`<svg viewBox="-2 -2 ${n + 4} ${n + 4}" width="168" height="168" shape-rendering="crispEdges"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`);
    });
    return () => { live = false; };
  }, [text]);
  return <div class="qr" dangerouslySetInnerHTML={{ __html: svg }} />;
}

const REPO = (import.meta.env.VITE_REPO as string | undefined) ?? '';

/** One account for the website and the app. */
function AccountGroup() {
  return (
    <Group id="account" title="Account" note="One account for the website and the iPhone app: your collection, watchlist, settings and drop alerts stay in step everywhere.">
      <AccountPanel />
    </Group>
  );
}

function HostedSettings() {
  useEffect(() => {
    if (location.hash) setTimeout(() => document.querySelector(location.hash)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
  }, []);
  const { data: st } = useData<Status & { exportedAt?: number }>('/api/status');
  const { data: s, reload } = useData<S>('/api/settings');
  const [g, setG] = useState<S>({});
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('comps.theme') ?? 'system'; } catch { return 'system'; } });
  useEffect(() => { if (s) setG({ gradingFee: s.gradingFee, gradingShipping: s.gradingShipping, sellFeePct: s.sellFeePct, sellFixed: s.sellFixed }); }, [s]);
  const applyTheme = (t: string) => {
    setTheme(t);
    try { t === 'system' ? localStorage.removeItem('comps.theme') : localStorage.setItem('comps.theme', t); } catch {}
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
  };
  const site = `${location.origin}${BASE}/`;
  const gh = REPO ? `https://github.com/${REPO}` : '';
  const gr = st?.providers.graded;
  const eb = st?.providers.ebay?.on;
  const jobOk = (name: string) => st?.jobs.find((j) => j.name === name);
  return (
    <div class="page settings">
      <Header title="Settings" />
      <Group title="Prices" note={st ? `Updated ${ago(st.exportedAt ?? null)}. GitHub refreshes everything every 6 hours — nothing runs on your computer.` : undefined}>
        <div class="g-row">
          <div class="g-main"><div class="g-title">TCGplayer prices <span class="status-pill on">Daily</span></div><div class="g-desc">Every English Pokémon card and printing{st ? ` · ${num(st.counts.valued)} prices` : ''}.</div></div>
          {jobOk('pokemon') && <span class={`dot ${jobOk('pokemon')!.status === 'error' ? 'err' : ''}`} />}
        </div>
        <div class="g-row">
          <div class="g-main"><div class="g-title">Cardmarket (EU) prices <span class="status-pill on">Daily</span></div><div class="g-desc">For cards worth $15+, via TCGdex. Powers cross-market and momentum deals.</div></div>
        </div>
        <div class="g-row">
          <div class="g-main">
            <div class="g-title">Graded prices <span class={`status-pill ${gr?.on ? 'on' : 'off'}`}>{gr?.on ? 'Free · learning' : 'Not set'}</span></div>
            <div class="g-desc">PSA, CGC and BGS prices for Raw to Graded, from PokemonPriceTracker's free plan: about 50 cards a day, most valuable first, each remembered and re-checked every few weeks{gr?.on ? ` · ${num(gr.cards ?? 0)} cards known so far` : ''}. Get a free key (no card) at <a href="https://www.pokemonpricetracker.com/pokemon-card-api" target="_blank" rel="noopener noreferrer">pokemonpricetracker.com</a> and add it as the repository secret <code>PPT_API_KEY</code>.</div>
          </div>
          {gh && !gr?.on && <a class="btn sm" href={`${gh}/settings/secrets/actions/new`} target="_blank" rel="noopener noreferrer">Add secret</a>}
        </div>
        <div class="g-row">
          <div class="g-main">
            <div class="g-title">eBay listings <span class={`status-pill ${eb ? 'on' : 'off'}`}>{eb ? 'Connected' : 'Not set'}</span></div>
            <div class="g-desc">Free developer keyset; finds live listings under value. Add <code>EBAY_CLIENT_ID</code> and <code>EBAY_CLIENT_SECRET</code> as repository secrets.</div>
          </div>
          {gh && !eb && <a class="btn sm" href="https://developer.ebay.com/my/keys" target="_blank" rel="noopener noreferrer">Get keys</a>}
        </div>
        {gh && (
          <div class="g-foot">
            <a class="btn sm" href={`${gh}/actions/workflows/data.yml`} target="_blank" rel="noopener noreferrer"><IconRefresh size={15} />Refresh now on GitHub</a>
          </div>
        )}
      </Group>

      <Group id="grading" title="Grading costs" note="Used for expected value on Raw to Graded and card pages. Saved in this browser.">
        <div class="g-grid">
          <Field label="Grading fee per card"><MoneyInput value={g.gradingFee ?? ''} onValue={(x) => setG({ ...g, gradingFee: x })} /></Field>
          <Field label="Shipping & insurance per card"><MoneyInput value={g.gradingShipping ?? ''} onValue={(x) => setG({ ...g, gradingShipping: x })} /></Field>
          <Field label="Selling fee (%)"><input class="input num" inputMode="decimal" value={g.sellFeePct ?? ''} onInput={(e) => setG({ ...g, sellFeePct: (e.target as HTMLInputElement).value })} /></Field>
          <Field label="Fixed fee per sale"><MoneyInput value={g.sellFixed ?? ''} onValue={(x) => setG({ ...g, sellFixed: x })} /></Field>
        </div>
        <div class="g-foot"><button class="btn primary sm" onClick={async () => { await put('/api/settings', g); invalidate('/api/'); reload(); toast('Saved'); }}>Save and recalculate</button></div>
      </Group>

      <AccountGroup />

      <Group title="iPhone app" note="Install the app with Sideloadly, AltStore or SideStore. It reads prices from this site, so it works anywhere.">
        <div class="pair">
          <Qr text={`comps://connect?url=${encodeURIComponent(site)}`} />
          <div>
            <div class="pair-url num" style={{ fontSize: 14 }}>{site}</div>
            <p class="g-desc" style={{ marginTop: 10, maxWidth: 380 }}>The app is already set to this site. If you ever move it, scan this code from the app's Settings.</p>
            {gh && (
              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                <a class="btn primary sm" href={`${gh}/releases/download/ios-latest/Comps.ipa`}>Download app (.ipa)</a>
                <a class="btn sm" href={`${gh}/releases/tag/ios-latest`} target="_blank" rel="noopener noreferrer">AltStore source</a>
              </div>
            )}
          </div>
        </div>
      </Group>

      <Group title="Appearance">
        <div class="g-row">
          <div class="g-main"><div class="g-title">Theme</div></div>
          <Segmented value={theme} onChange={applyTheme} label="Theme" options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
        </div>
      </Group>
      <p class="faint" style={{ fontSize: 12, marginTop: 28 }}>Prices: TCGplayer via TCGCSV, Cardmarket via TCGdex. Signed in, your collection, watchlist and settings are kept in your account; signed out, they stay in this browser.</p>
    </div>
  );
}

export function SettingsPage() {
  return STATIC ? <HostedSettings /> : <ServerSettings />;
}

function ServerSettings() {
  const { data: s, reload } = useData<S>('/api/settings');
  const { data: st, reload: reloadStatus } = useData<Status>('/api/status', { refresh: 5000 });
  const [g, setG] = useState<S>({});
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('comps.theme') ?? 'system'; } catch { return 'system'; } });
  const [tok, setTok] = useState(token());
  useEffect(() => { if (s) setG({ gradingFee: s.gradingFee, gradingShipping: s.gradingShipping, sellFeePct: s.sellFeePct, sellFixed: s.sellFixed, mtgMinUsd: s.mtgMinUsd, ygoMinUsd: s.ygoMinUsd }); }, [s]);
  useEffect(() => {
    if (location.hash) setTimeout(() => document.querySelector(location.hash)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
  }, []);

  const save = async (patch: S) => {
    try {
      await put('/api/settings', patch);
      invalidate('/api/');
      reload();
      toast('Saved');
    } catch (e) { toast((e as Error).message); }
  };
  const refresh = async (what: string) => {
    const r = await post<{ started: boolean; running?: string }>('/api/refresh', { what });
    toast(r.started ? 'Refresh started' : `Already running: ${r.running}`);
    reloadStatus();
  };
  const applyTheme = (t: string) => {
    setTheme(t);
    try { t === 'system' ? localStorage.removeItem('comps.theme') : localStorage.setItem('comps.theme', t); } catch {}
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
  };

  const games = new Set(String(s?.games ?? '').split(',').filter(Boolean));
  const toggleGame = (k: string) => {
    const next = new Set(games);
    next.has(k) ? next.delete(k) : next.add(k);
    save({ games: [...next].join(',') });
  };
  const urls = st?.lanUrls?.length ? st.lanUrls : [location.origin];
  const pairing = `comps://connect?url=${encodeURIComponent(urls[0])}${token() ? `&token=${encodeURIComponent(token())}` : ''}`;

  return (
    <div class="page settings">
      <Header title="Settings" />
      {!s || !st ? <div class="sk" style={{ height: 300, borderRadius: 14 }} /> : (
        <>
          <Group title="Price data" note="Pokémon, Magic and Yu-Gi-Oh! raw prices work out of the box. Graded prices and live listings need the keys below.">
            <KeyRow label="PriceCharting" k="pricechartingToken" s={s} status={st.providers.pricecharting?.on ? 'on' : 'off'} onSave={save} href="https://www.pricecharting.com/api-documentation"
              desc="Graded prices (PSA 9/10, BGS, CGC, SGC) and sports cards. Powers Raw to Graded. Paid subscription." />
            <KeyRow label="eBay client ID" k="ebayClientId" s={s} status={st.providers.ebay?.on ? 'on' : 'off'} onSave={save} href="https://developer.ebay.com/my/keys"
              desc="Free developer keyset. Finds live Buy It Now listings priced under value." />
            <KeyRow label="eBay client secret" k="ebayClientSecret" s={s} status={st.providers.ebay?.on ? 'on' : 'off'} onSave={save} desc="The Cert ID from the same production keyset." />
            <KeyRow label="Pokémon TCG API" k="pokemontcgApiKey" s={s} status={st.providers.pokemon?.key ? 'on' : 'free'} onSave={save} href="https://dev.pokemontcg.io"
              desc="Optional. Without it the first catalog download is throttled to a few minutes." />
          </Group>

          <Group id="grading" title="Grading costs" note="Used for every expected-value number. Match them to your service tier.">
            <div class="g-grid">
              <Field label="Grading fee per card"><MoneyInput value={g.gradingFee ?? ''} onValue={(x) => setG({ ...g, gradingFee: x })} /></Field>
              <Field label="Shipping & insurance per card"><MoneyInput value={g.gradingShipping ?? ''} onValue={(x) => setG({ ...g, gradingShipping: x })} /></Field>
              <Field label="Selling fee (%)"><input class="input num" inputMode="decimal" value={g.sellFeePct ?? ''} onInput={(e) => setG({ ...g, sellFeePct: (e.target as HTMLInputElement).value })} /></Field>
              <Field label="Fixed fee per sale"><MoneyInput value={g.sellFixed ?? ''} onValue={(x) => setG({ ...g, sellFixed: x })} /></Field>
            </div>
            <div class="g-foot"><button class="btn primary sm" onClick={() => save({ gradingFee: g.gradingFee, gradingShipping: g.gradingShipping, sellFeePct: g.sellFeePct, sellFixed: g.sellFixed })}>Save and recalculate</button></div>
          </Group>

          <Group title="Markets">
            {[['pokemon', 'Pokémon', 'All English cards via the Pokémon TCG API'], ['mtg', 'Magic: The Gathering', `Printings over $${s.mtgMinUsd} via Scryfall`], ['yugioh', 'Yu-Gi-Oh!', `Printings over $${s.ygoMinUsd} via YGOPRODeck`]].map(([k, l, d]) => (
              <div class="g-row">
                <div class="g-main"><div class="g-title">{l}</div><div class="g-desc">{d}</div></div>
                <label class="switch"><input type="checkbox" checked={games.has(k)} onChange={() => toggleGame(k)} /><span /></label>
              </div>
            ))}
            <div class="g-row">
              <div class="g-main"><div class="g-title">Sports cards</div><div class="g-desc">Come from PriceCharting when it's connected.</div></div>
              <span class={`status-pill ${st.providers.pricecharting?.on ? 'on' : 'off'}`}>{st.providers.pricecharting?.on ? 'On' : 'Needs PriceCharting'}</span>
            </div>
          </Group>

          <Group title="Refresh" note={`Catalog every ${s.refreshHours} h, eBay listings every ${s.listingsHours} h. ${num(st.counts.cards)} cards, ${num(st.counts.valued)} prices, ${num(st.counts.listings)} clean listings.`}>
            {st.jobs.length === 0 && <div class="g-row"><div class="g-desc">{st.demo ? 'Sample data mode — the scheduler is off.' : 'No refresh has run yet.'}</div></div>}
            {st.jobs.map((j) => (
              <div class="g-row">
                <div class="g-main">
                  <div class="g-title" style={{ textTransform: 'capitalize' }}>{j.name}</div>
                  <div class="g-desc">{j.status === 'running' ? `Running${j.message ? ` · ${j.message}` : ''}` : j.status === 'error' ? j.message : `${j.items != null ? `${num(j.items)} items · ` : ''}${ago(j.finished_at)}`}</div>
                </div>
                <span class={`dot ${j.status === 'running' ? 'busy' : j.status === 'error' ? 'err' : ''}`} />
              </div>
            ))}
            <div class="g-foot">
              <button class="btn sm" onClick={() => refresh('listings')} disabled={!!st.running || !st.providers.ebay?.on}>Scan listings</button>
              <button class="btn sm" onClick={() => refresh('recompute')} disabled={!!st.running}>Recalculate</button>
              <button class="btn primary sm" onClick={() => refresh('all')} disabled={!!st.running || st.demo}><IconRefresh size={15} />{st.running ? 'Refreshing…' : 'Refresh everything'}</button>
            </div>
          </Group>

          <Group title="iPhone app" note="In the app, open Settings → Connect to server and scan this code, or type the address.">
            <div class="pair">
              <Qr text={pairing} />
              <div>
                {urls.map((u) => <div class="pair-url num">{u}</div>)}
                <p class="g-desc" style={{ marginTop: 10, maxWidth: 360 }}>Your phone and this computer need to be on the same network, unless you host the server somewhere public. If you set <code>COMPS_TOKEN</code>, enter it below so this browser and the code include it.</p>
                <form style={{ display: 'flex', gap: 8, marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); setToken(tok); invalidate('/api/'); toast('Token saved in this browser'); }}>
                  <input class="input sm" type="password" placeholder="Access token" value={tok} onInput={(e) => setTok((e.target as HTMLInputElement).value)} style={{ width: 200 }} aria-label="Access token" />
                  <button class="btn sm">Use token</button>
                </form>
              </div>
            </div>
          </Group>

          <Group title="Appearance">
            <div class="g-row">
              <div class="g-main"><div class="g-title">Theme</div></div>
              <Segmented value={theme} onChange={applyTheme} label="Theme" options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
            </div>
          </Group>
          <p class="faint" style={{ fontSize: 12, marginTop: 28 }}>Comps {st.version} · EUR→USD {st.fx.eurUsd.toFixed(4)} ({st.fx.source})</p>
        </>
      )}
    </div>
  );
}
