import { useMemo, useState } from 'preact/hooks';
import { useListings, type Listing } from '../lib/marketplace';
import { Link } from '../lib/router';
import { money, ago, cardHref } from '../lib/format';
import { Thumb } from './Thumb';
import { Segmented, Empty, SkRows } from './ui';
import { IconTag } from './icons';

const ZIP = `${import.meta.env.BASE_URL}comps-marketplace.zip`;
type Show = 'deals' | 'all';
const worthText = (l: Listing) => (l.value != null ? money(l.value) : l.low != null ? `${money(l.low)}+` : '—');

/** Deals → Marketplace: card listings priced on Facebook Marketplace, with a Buy link for each. */
export function MarketplaceFinds() {
  const { items, ext, setupMissing } = useListings();
  const [show, setShow] = useState<Show>('deals');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'upside' | 'discount' | 'recent' | 'price'>('upside');

  const list = useMemo(() => {
    let xs = (items ?? []).filter((l) => l.status === 'active' || l.status === 'pending');
    if (show === 'deals') xs = xs.filter((l) => l.deal);
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length) xs = xs.filter((l) => words.every((w) => `${l.card.name} ${l.card.set} ${l.title} ${l.location ?? ''}`.toLowerCase().includes(w)));
    const up = (l: Listing) => (l.value ?? l.low ?? 0) - l.price;
    const by = {
      upside: (a: Listing, b: Listing) => up(b) - up(a),
      discount: (a: Listing, b: Listing) => (b.discount ?? -9) - (a.discount ?? -9),
      recent: (a: Listing, b: Listing) => b.seenAt - a.seenAt,
      price: (a: Listing, b: Listing) => a.price - b.price,
    }[sort];
    return [...xs].sort(by);
  }, [items, show, q, sort]);
  const dealCount = (items ?? []).filter((l) => l.deal).length;

  return (
    <>
      <ExtensionBar ext={ext} />
      {setupMissing && <p class="faint" style={{ fontSize: 13 }}>Shared Marketplace deals aren't switched on yet: the site owner runs <code>supabase/schema.sql</code> in Supabase once.</p>}
      <div class="toolbar">
        <Segmented value={show} label="Show" onChange={setShow}
          options={[{ value: 'deals' as Show, label: 'Under value', count: dealCount || undefined }, { value: 'all' as Show, label: 'All priced', count: items?.length || undefined }]} />
        <input class="input sm" type="search" placeholder="Card or city" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label="Filter by card or city" style={{ width: 170 }} />
        <span class="spacer" />
        <select class="select" value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as typeof sort)} aria-label="Sort">
          <option value="upside">Most money saved</option>
          <option value="discount">Deepest discount</option>
          <option value="recent">Newest</option>
          <option value="price">Lowest price</option>
        </select>
      </div>
      {!items && <SkRows n={5} />}
      {items && !list.length && (
        <Empty icon={<IconTag size={26} />} title={items.length ? 'Nothing matches' : 'No Marketplace listings yet'}>
          {items.length ? 'Try "All priced" or a different search.' : ext.installed ? 'Press "Find deals for me" above and they show up here in a minute or two.' : 'Add the free extension above and press "Find deals for me".'}
        </Empty>
      )}
      <div class="mp-list">
        {list.map((l) => <ListingRow l={l} onHide={l.mine ? () => ext.remove(l.id) : undefined} />)}
      </div>
    </>
  );
}

export function ListingRow({ l, onHide, compact = false }: { l: Listing; onHide?: () => void; compact?: boolean }) {
  return (
    <div class="row mp-row" key={l.id}>
      {!compact && (
        <Link href={cardHref(l.card.id)} class="mp-art" aria-label={`${l.card.name} prices`}>
          <Thumb card={{ id: l.card.id, name: l.card.name, game: 'pokemon', image: l.card.image }} />
        </Link>
      )}
      <div class="row-main">
        {!compact && <div class="row-title"><Link href={cardHref(l.card.id)}>{l.card.name}</Link>{l.grade && <span class="badge">{l.grade}</span>}</div>}
        {!compact && <div class="row-sub ellipsis">{l.card.set} #{l.card.number}{l.confident ? '' : ' · check it’s this card'}</div>}
        <div class={`row-sub ellipsis ${compact ? '' : 'faint'}`} title={l.title}>“{l.title}”</div>
        <div class="row-sub faint ellipsis">{[l.location, `seen ${ago(l.seenAt)}`, l.status === 'pending' ? 'pending sale' : null, l.mine ? 'found by you' : null].filter(Boolean).join(' · ')}</div>
      </div>
      <div class="mp-nums num">
        <b>{money(l.price)}</b>
        <span class="faint">worth {worthText(l)}</span>
        {l.discount != null && Math.abs(l.discount) >= 0.05 && <span class={l.deal ? 'up' : l.discount < -0.15 ? 'down' : 'faint'}>{Math.round(Math.abs(l.discount) * 100)}% {l.discount > 0 ? 'under' : 'over'}</span>}
      </div>
      <div class="mp-actions">
        <a class="btn sm primary" href={l.url} target="_blank" rel="noopener noreferrer">Buy ↗</a>
        {onHide && <button class="btn sm" onClick={onHide} aria-label="Hide this listing">Hide</button>}
      </div>
    </div>
  );
}

function ExtensionBar({ ext }: { ext: ReturnType<typeof useListings>['ext'] }) {
  const [open, setOpen] = useState(false);
  if (ext.installed === null) return null;
  if (!ext.installed) {
    return (
      <div class="panel mp-install">
        <div class="mp-install-head">
          <div>
            <div class="g-title">Find these deals yourself, near you</div>
            <div class="g-desc">The free Comps extension for Chrome or Edge puts a price on every card listing on Facebook Marketplace and finds the deals for you with one button.</div>
          </div>
          <button class="btn primary" onClick={() => setOpen(!open)}>{open ? 'Hide steps' : 'Get the extension'}</button>
        </div>
        {open && (
          <ol class="mp-steps">
            <li><a class="btn primary sm" href={ZIP} download>Download</a> and open the file so it unzips into a folder.</li>
            <li>Paste <code>chrome://extensions</code> into the address bar and switch on <b>Developer mode</b> (top right).</li>
            <li>Press <b>Load unpacked</b> and pick the <b>comps-marketplace</b> folder. Done — come back here and press <b>Find deals for me</b>.</li>
          </ol>
        )}
      </div>
    );
  }
  const scan = ext.scan;
  return (
    <div class="panel mp-ext">
      <div class="mp-ext-main">
        <div class="g-title">{scan?.running ? `Searching Marketplace for “${scan.queries[scan.qi]}” (${scan.qi + 1} of ${scan.queries.length})` : 'Extension connected'}</div>
        <div class="g-desc">
          {scan?.running ? `${scan.priced} cards priced, ${scan.deals} deals so far. You can keep using your computer.`
            : scan?.note === 'blocked' ? 'Couldn’t see any listings. Log in to Facebook in this browser, then try again.'
            : ext.lastScan ? `Last search ${ago(ext.lastScan.at)}: ${ext.lastScan.priced} cards priced, ${ext.lastScan.deals} deals.`
            : 'Press the button: it opens Marketplace, scrolls through the newest listings near you and prices every card.'}
          {!ext.share && ' Sharing is off, so only you see what it finds.'}
        </div>
      </div>
      {scan?.running ? <button class="btn" onClick={ext.stop}>Stop</button> : <button class="btn primary" onClick={ext.start}>▶ Find deals for me</button>}
    </div>
  );
}
