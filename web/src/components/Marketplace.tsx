import { useMemo, useState } from 'preact/hooks';
import { useMarketplace, type Find } from '../lib/marketplace';
import { Link } from '../lib/router';
import { money, ago, cardHref } from '../lib/format';
import { Thumb } from './Thumb';
import { Segmented, Empty, SkRows } from './ui';
import { IconTag, IconX } from './icons';

const ZIP = `${import.meta.env.BASE_URL}comps-marketplace.zip`;
type Show = 'deals' | 'all';

/** Deals → Marketplace: listings the browser extension priced while you scrolled. */
export function MarketplaceFinds() {
  const mp = useMarketplace();
  const [show, setShow] = useState<Show>('deals');
  const [sort, setSort] = useState<'upside' | 'discount' | 'recent'>('upside');

  const list = useMemo(() => {
    let xs = mp.finds.filter((f) => f.price != null);
    if (show === 'deals') xs = xs.filter((f) => f.discount != null && f.discount >= 0.15);
    const up = (f: Find) => (f.value ?? 0) - (f.price ?? 0);
    const by = { upside: (a: Find, b: Find) => up(b) - up(a), discount: (a: Find, b: Find) => (b.discount ?? -9) - (a.discount ?? -9), recent: (a: Find, b: Find) => b.seenAt - a.seenAt }[sort];
    return [...xs].sort(by);
  }, [mp.finds, show, sort]);

  if (mp.installed === null) return <SkRows n={4} />;
  if (!mp.installed) return <Install />;

  return (
    <>
      <div class="toolbar">
        <Segmented value={show} label="Show" onChange={setShow}
          options={[{ value: 'deals' as Show, label: 'Under value' }, { value: 'all' as Show, label: 'All priced' }]} />
        <span class="spacer" />
        <select class="select" value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as typeof sort)} aria-label="Sort">
          <option value="upside">Most upside ($)</option>
          <option value="discount">Deepest discount</option>
          <option value="recent">Recently seen</option>
        </select>
        {mp.finds.length > 0 && <button class="btn sm" onClick={() => confirm('Clear every Marketplace listing the extension has saved?') && mp.clear()}>Clear</button>}
      </div>
      {!mp.enabled && <p class="faint" style={{ margin: '0 0 12px' }}>Prices on Marketplace are switched off. <button class="btn sm" onClick={() => mp.setEnabled(true)}>Turn on</button></p>}
      {!list.length && (
        <Empty icon={<IconTag size={26} />} title={mp.finds.length ? 'Nothing under value yet' : 'No listings yet'}>
          Open <a href="https://www.facebook.com/marketplace/search/?query=pokemon%20card" target="_blank" rel="noopener">Facebook Marketplace</a>, search for Pokémon cards and scroll.
          Listings with a card number in the title (like 199/165) get priced and show up here.
        </Empty>
      )}
      <div class="mp-list">
        {list.map((f) => (
          <div class="row mp-row" key={f.id}>
            <Link href={cardHref(f.card.id)} class="mp-art" aria-label={`${f.card.name} prices`}>
              <Thumb card={{ id: f.card.id, name: f.card.name, game: 'pokemon', image: f.card.image }} />
            </Link>
            <div class="row-main">
              <a class="row-title ellipsis" href={f.url} target="_blank" rel="noopener" title={f.title}>{f.title}</a>
              <div class="row-sub ellipsis">
                <Link href={cardHref(f.card.id)}>{f.card.name}</Link> · {f.card.set} #{f.card.number}{f.grade ? ` · ${f.grade}` : ''}
              </div>
              <div class="row-sub faint ellipsis">{[f.location, `seen ${ago(f.seenAt)}`, f.confident ? null : 'check the card'].filter(Boolean).join(' · ')}</div>
            </div>
            <div class="mp-nums num">
              <b>{money(f.price)}</b>
              <span class="faint">worth {f.value != null ? money(f.value) : '—'}</span>
              {f.discount != null && <span class={f.discount >= 0.15 ? 'up' : f.discount <= -0.15 ? 'down' : 'faint'}>{Math.round(Math.abs(f.discount) * 100)}% {f.discount >= 0 ? 'under' : 'over'}</span>}
            </div>
            <button class="btn icon sm" onClick={() => mp.remove(f.id)} aria-label="Hide this listing"><IconX size={14} /></button>
          </div>
        ))}
      </div>
    </>
  );
}

function Install() {
  return (
    <div class="panel mp-install">
      <div class="g-title">See Comps prices while you browse Facebook Marketplace</div>
      <p class="g-desc">
        The free Comps for Marketplace extension for Chrome (or Edge, Brave) puts a price tag on each Pokémon card listing as you scroll, and sends the
        underpriced ones here. It only reads the listings already on your screen: it never scrolls, clicks or messages anyone by itself, and what it saves stays in your browser.
      </p>
      <ol class="mp-steps">
        <li><a class="btn primary sm" href={ZIP} download>Download the extension</a> and unzip it.</li>
        <li>Open <code>chrome://extensions</code> and turn on <b>Developer mode</b> (top right).</li>
        <li>Click <b>Load unpacked</b> and pick the unzipped folder.</li>
        <li>Open Facebook Marketplace, search for Pokémon cards and scroll. Come back to this page to see the deals.</li>
      </ol>
      <p class="faint" style={{ fontSize: 13, margin: 0 }}>Computer browsers only; phones don't run extensions.</p>
    </div>
  );
}
