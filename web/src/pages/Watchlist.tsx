import { useData, put, del, invalidate } from '../lib/api';
import { Link, setHero } from '../lib/router';
import { money, pct, cardLine, cardHref, cardApi } from '../lib/format';
import type { Card } from '../lib/types';
import { Thumb } from '../components/Thumb';
import { Delta, Empty, SkRows, toast } from '../components/ui';
import { openPalette } from '../components/Palette';
import { IconPlus, IconStar, IconX } from '../components/icons';
import { Header } from './shared';

type Item = { card: Card; variant: string; variantLabel: string; target: number | null; bestAsk: number | null; hit: boolean; createdAt: number };

export function WatchlistPage() {
  const { data, loading } = useData<{ items: Item[] }>('/api/watchlist');
  const add = () => openPalette({
    placeholder: 'Find a card to watch',
    onPick: async (c) => { await put('/api/watchlist', { cardId: c.id }); invalidate('/api/'); toast(`Watching ${c.name}`); },
  });
  const remove = async (it: Item) => {
    await del(`/api/watchlist/${encodeURIComponent(it.card.id)}?variant=${encodeURIComponent(it.variant)}`);
    invalidate('/api/');
  };
  const items = data?.items ?? [];
  const hits = items.filter((i) => i.hit).length;

  return (
    <div class="page">
      <Header title="Watchlist" actions={<button class="btn primary" onClick={add}><IconPlus size={17} />Watch a card</button>}>
        {data && <span>{items.length} card{items.length === 1 ? '' : 's'}{hits ? ` · ${hits} at or under target` : ''} · scanned for live listings first</span>}
      </Header>
      {loading && !data && <SkRows n={5} />}
      {data && !items.length && (
        <Empty icon={<IconStar size={26} />} title="Nothing watched yet" action={<button class="btn primary" onClick={add}>Find a card</button>}>
          Watch cards you want to buy. They get priority in the eBay scan, and you can set a target price.
        </Empty>
      )}
      {items.map((it, i) => {
        const dist = it.target && it.card.price ? it.card.price / it.target - 1 : null;
        return (
          <div class="row watch-row enter" style={{ '--i': i }}>
            <Link href={cardHref(it.card.id)} prefetchUrl={cardApi(it.card.id)} class="holding-link" onClick={() => setHero(it.card.id)}>
              <Thumb card={it.card} />
              <div class="row-main">
                <div class="row-title"><span class="t">{it.card.name}</span>{it.hit && <span class="badge accent">At target</span>}</div>
                <div class="row-sub">{cardLine(it.card)}{it.variantLabel ? ` · ${it.variantLabel}` : ''}</div>
              </div>
            </Link>
            <div class="row-right w-target">
              <div class="row-value" style={{ fontSize: 14 }}>{it.target ? money(it.target) : '—'}</div>
              <div class="row-meta">{dist == null ? 'no target' : dist <= 0 ? 'under target' : `${pct(dist, { signed: false, digits: 0 })} above`}</div>
            </div>
            <div class="row-right">
              <div class="row-value">{money(it.card.price)}</div>
              <Delta value={it.card.change7d} />
            </div>
            <button class="btn icon sm" onClick={() => remove(it)} aria-label={`Stop watching ${it.card.name}`}><IconX size={15} /></button>
          </div>
        );
      })}
    </div>
  );
}
