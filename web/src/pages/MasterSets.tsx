import { useMemo, useState } from 'preact/hooks';
import { useData, post, patch, del, invalidate } from '../lib/api';
import { Link, navigate } from '../lib/router';
import { money, num, cardHref } from '../lib/format';
import type { Holding } from '../lib/types';
import { slotsBySet, ownedMap, withOwned, progress, slotDone, type CatalogIndex, type Slot, type Printing, type Mode, type Progress } from '../lib/masterset';
import { Thumb } from '../components/Thumb';
import { Segmented, Empty, SkRows, Sheet, toast } from '../components/ui';
import { IconChecklist, IconPlus, IconSearch } from '../components/icons';
import { Header } from './shared';

type SetSummary = { id: string; name: string; code: string | null; series: string; released: string | null; top: { id: string; name: string; image: string | null } | null };
type Collection = { items: Holding[] };

// Same request as the Collection page, so both share one load.
const COLLECTION = '/api/collection?days=90';
const MODES = [{ value: 'master' as Mode, label: 'Master set' }, { value: 'base' as Mode, label: 'One of each' }];

function useMode(): [Mode, (m: Mode) => void] {
  const read = (): Mode => { try { return localStorage.getItem('comps.mastersetMode') === 'base' ? 'base' : 'master'; } catch { return 'master'; } };
  const [mode, setMode] = useState<Mode>(read);
  return [mode, (m) => { setMode(m); try { localStorage.setItem('comps.mastersetMode', m); } catch {} }];
}

/** The catalog grouped into card slots, plus what you have. */
function useMasters() {
  const idx = useData<CatalogIndex>('/api/index');
  const col = useData<Collection>(COLLECTION);
  const bySet = useMemo(() => (idx.data ? slotsBySet(idx.data) : null), [idx.data]);
  const owned = useMemo(() => ownedMap(col.data?.items ?? []), [col.data]);
  return { idx: idx.data, bySet, owned, items: col.data?.items ?? [], ready: Boolean(idx.data && col.data), error: idx.error };
}

const pctOf = (p: Progress) => (p.total ? p.owned / p.total : 0);
const pctText = (p: Progress) => {
  const x = pctOf(p);
  return x > 0 && x < 0.01 ? '<1%' : `${Math.floor(x * 100)}%`;
};

function Bar({ p }: { p: Progress }) {
  const x = pctOf(p);
  return <div class={`ms-bar ${x >= 1 ? 'done' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.owned}><i style={{ width: `${Math.max(x > 0 ? 1.5 : 0, x * 100)}%` }} /></div>;
}

export function MasterSetsPage() {
  const sets = useData<{ items: SetSummary[] }>('/api/sets');
  const m = useMasters();
  const [mode, setMode] = useMode();
  const [q, setQ] = useState('');

  const rows = useMemo(() => {
    if (!m.bySet || !sets.data) return null;
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return sets.data.items.flatMap((s) => {
      const slots = m.bySet!.get(String(s.id));
      if (!slots?.length) return [];
      if (words.length && !words.every((w) => `${s.name} ${s.code ?? ''} ${s.series}`.toLowerCase().includes(w))) return [];
      return [{ s, p: progress(withOwned(slots, m.owned), mode) }];
    });
  }, [m.bySet, m.owned, sets.data, mode, q]);

  const started = (rows ?? []).filter((r) => r.p.owned > 0).sort((a, b) => pctOf(b.p) - pctOf(a.p) || b.p.value - a.p.value);
  const groups = useMemo(() => {
    const g = new Map<string, NonNullable<typeof rows>>();
    for (const r of rows ?? []) {
      if (!g.has(r.s.series)) g.set(r.s.series, []);
      g.get(r.s.series)!.push(r);
    }
    return [...g];
  }, [rows]);

  return (
    <div class="page">
      <Header title="Master Sets">
        <span>Every card in every printing (normal, reverse holo, Poké Ball, Master Ball, Energy Symbol and more), what you have and what's left. Prices are raw market prices.</span>
      </Header>
      <div class="toolbar">
        <Segmented value={mode} options={MODES} onChange={setMode} label="Count" />
        <span class="spacer" />
        <label class="ms-search">
          <IconSearch size={16} />
          <input class="input sm" type="search" placeholder="Find a set" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label="Find a set" />
        </label>
      </div>
      {m.error && <Empty title="Couldn't load the card list">Try again in a moment.</Empty>}
      {!rows && !m.error && <SkRows n={8} />}

      {rows && (
        <section class="section">
          <div class="section-head"><h2>Your sets</h2>{started.length > 0 && <span class="faint" style={{ fontSize: 13 }}>{started.length} started</span>}</div>
          {started.length ? (
            <div class="set-grid">
              {started.map(({ s, p }, i) => (
                <Link href={`/mastersets/${s.id}`} class="set-card ms-card enter" style={{ '--i': Math.min(i, 16) }}>
                  <div class="set-art">{s.top && <Thumb card={{ id: s.top.id, name: s.top.name, game: 'pokemon', image: s.top.image }} size="md" />}</div>
                  <div class="set-main">
                    <div class="set-name">{s.name}</div>
                    <div class="row-sub num">{num(p.owned)} of {num(p.total)} · {pctText(p)}</div>
                    <Bar p={p} />
                    <div class="row-sub num">{p.owned >= p.total ? 'Complete' : `${money(p.toComplete, { whole: true })} to complete`}</div>
                  </div>
                  <div class="set-value num" title="What you have, at raw market prices">{money(p.value, { whole: true })}</div>
                </Link>
              ))}
            </div>
          ) : (
            <div class="panel ms-hint">
              <IconChecklist size={22} />
              <div>
                <div class="g-title">Nothing started yet</div>
                <div class="g-desc">Pick a set below and tap cards to mark the printings you have, or add cards to your collection (scanning with the iPhone app works too). They show up here.</div>
              </div>
            </div>
          )}
        </section>
      )}

      {groups.map(([series, list]) => (
        <section class="section">
          <div class="section-head"><h2>{series}</h2><span class="faint" style={{ fontSize: 13 }}>{list.length} sets</span></div>
          <div class="set-grid">
            {list.map(({ s, p }) => (
              <Link href={`/mastersets/${s.id}`} class="set-card">
                <div class="set-art">{s.top && <Thumb card={{ id: s.top.id, name: s.top.name, game: 'pokemon', image: s.top.image }} size="md" />}</div>
                <div class="set-main">
                  <div class="set-name">{s.name}</div>
                  <div class="row-sub num">{[s.released?.slice(0, 4), `${num(p.total)} ${mode === 'master' ? 'printings' : 'cards'}`, p.owned ? `${pctText(p)} done` : null].filter(Boolean).join(' · ')}</div>
                </div>
                <div class="set-value num" title={mode === 'master' ? 'The whole master set' : 'One of each card, cheapest printing'}>{money(p.full, { whole: true })}</div>
              </Link>
            ))}
          </div>
        </section>
      ))}
      {rows && !rows.length && <Empty icon={<IconChecklist size={26} />} title="No sets match">Try a different name.</Empty>}
    </div>
  );
}

type Filter = 'missing' | 'have' | 'all';

export function MasterSetPage({ id }: { id: string }) {
  const m = useMasters();
  const [mode, setMode] = useMode();
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<'number' | 'price'>('number');
  const [open, setOpen] = useState<string | null>(null);

  const slots = useMemo(() => withOwned(m.bySet?.get(id) ?? [], m.owned), [m.bySet, m.owned, id]);
  const p = useMemo(() => progress(slots, mode), [slots, mode]);
  const shown = useMemo(() => {
    let xs = slots;
    if (filter === 'missing') xs = xs.filter((s) => !slotDone(s, mode));
    if (filter === 'have') xs = xs.filter((s) => s.printings.some((x) => x.have > 0));
    if (sort === 'price') xs = [...xs].sort((a, b) => missingCost(b, mode) - missingCost(a, mode) || worth(b) - worth(a));
    return xs;
  }, [slots, filter, sort, mode]);
  const set = m.idx?.sets[id];
  const slot = open ? slots.find((s) => s.key === open) : null;

  if (m.idx && !set) return <div class="page"><Empty title="Set not found" /></div>;
  const done = p.total > 0 && p.owned >= p.total;

  return (
    <div class="page">
      <Header title={set?.[0] ?? ' '}>
        {set && <>
          <Link href="/mastersets" style={{ color: 'var(--accent)' }}>Master Sets</Link>
          <span class="faint">·</span><span>{set[2]}</span>
          <span class="faint">·</span><span>{set[3]?.slice(0, 4) ?? 'Undated'}</span>
          <span class="faint">·</span><span>{num(slots.length)} cards · {num(slots.reduce((n, s) => n + s.printings.length, 0))} printings</span>
        </>}
      </Header>

      {!m.ready && <SkRows n={6} />}
      {m.ready && (
        <>
          <div class="ms-stats">
            <div class="ms-stat">
              <span>{mode === 'master' ? 'Printings collected' : 'Cards collected'}</span>
              <b class="num">{num(p.owned)}<small> / {num(p.total)}</small></b>
              <Bar p={p} />
              <small class="num">{done ? 'Complete' : `${pctText(p)} · ${num(p.total - p.owned)} to go`}</small>
            </div>
            <div class="ms-stat">
              <span>Your set's value</span>
              <b class="num">{money(p.value)}</b>
              <small>One of each you have, raw</small>
            </div>
            <div class="ms-stat">
              <span>Cost to complete</span>
              <b class="num">{done ? '—' : money(p.toComplete)}</b>
              <small>{p.unpriced ? `${num(p.unpriced)} without a price yet` : mode === 'master' ? 'Every missing printing' : 'Cheapest printing of each'}</small>
            </div>
            <div class="ms-stat">
              <span>{mode === 'master' ? 'Full master set' : 'Full set'}</span>
              <b class="num">{money(p.full)}</b>
              <small>At today's raw prices</small>
            </div>
          </div>

          <div class="toolbar">
            <Segmented value={mode} options={MODES} onChange={setMode} label="Count" />
            <Segmented value={filter} options={[{ value: 'all' as Filter, label: 'All' }, { value: 'missing' as Filter, label: 'Missing' }, { value: 'have' as Filter, label: 'Have' }]} onChange={setFilter} label="Show" />
            <span class="spacer" />
            <select class="select" value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as 'number' | 'price')} aria-label="Sort">
              <option value="number">Card number</option>
              <option value="price">Most to buy</option>
            </select>
          </div>

          {!shown.length && (
            <Empty icon={<IconChecklist size={26} />} title={filter === 'missing' ? 'Nothing missing' : 'None yet'}>
              {filter === 'missing' ? 'You have every card here.' : 'Tap a card to mark the printings you have.'}
            </Empty>
          )}
          <div class="binder ms-binder">
            {shown.map((s, i) => <SlotTile s={s} mode={mode} i={i} onOpen={() => setOpen(s.key)} />)}
          </div>
        </>
      )}
      {slot && <SlotSheet slot={slot} items={m.items} onClose={() => setOpen(null)} />}
    </div>
  );
}

const missingCost = (s: Slot, mode: Mode) => {
  const miss = s.printings.filter((x) => !x.have && x.price != null).map((x) => x.price!);
  if (!miss.length) return 0;
  if (mode === 'base') return s.printings.some((x) => x.have) ? 0 : Math.min(...miss);
  return miss.reduce((a, b) => a + b, 0);
};
const worth = (s: Slot) => Math.max(0, ...s.printings.map((x) => x.price ?? 0));

function SlotTile({ s, mode, i, onOpen }: { s: Slot; mode: Mode; i: number; onOpen: () => void }) {
  const any = s.printings.some((x) => x.have > 0);
  const done = slotDone(s, mode);
  const cost = missingCost(s, mode);
  return (
    <button type="button" class={`binder-card ms-slot enter ${any ? '' : 'none'} ${done ? 'done' : ''}`} style={{ '--i': Math.min(i, 24) }} onClick={onOpen}
      aria-label={`${s.name} #${s.number}: ${s.printings.filter((x) => x.have).length} of ${s.printings.length} printings`}>
      <div class="ms-art">
        <Thumb card={{ id: s.cardId, name: s.name, game: 'pokemon', image: s.image, number: s.number }} size="lg" />
        {done && <span class="ms-done" aria-hidden="true">✓</span>}
      </div>
      <div class="binder-meta">
        <div class="binder-name ellipsis">{s.name}</div>
        <div class="binder-row">
          <span class="faint num">#{s.number}</span>
          <b class="num">{done ? <span class="up">Have</span> : money(cost)}</b>
        </div>
        <div class="pchips">
          {s.printings.map((x) => <span class={`pchip ${x.have ? 'have' : ''}`} title={`${x.label}${x.have ? ' · have' : ''}`}>{x.short}</span>)}
        </div>
      </div>
    </button>
  );
}

function SlotSheet({ slot, items, onClose }: { slot: Slot; items: Holding[]; onClose: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (x: Printing, fn: () => Promise<unknown>, msg: string) => {
    setBusy(`${x.cardId}|${x.variant}`);
    try { await fn(); invalidate('/api/'); toast(msg); } catch (e) { toast((e as Error).message); }
    setBusy(null);
  };
  const add = (x: Printing) => run(x, () => post('/api/collection', { cardId: x.cardId, variant: x.variant, condition: 'NM', quantity: 1 }), `Added ${slot.name} · ${x.label}`);
  const remove = (x: Printing) => {
    // Take one raw copy first (the newest); graded copies only after asking.
    const copies = items.filter((h) => h.cardId === x.cardId && h.variantResolved === x.variant)
      .sort((a, b) => Number(Boolean(a.grader)) - Number(Boolean(b.grader)) || b.createdAt - a.createdAt);
    const h = copies[0];
    if (!h) return;
    if (h.grader && !confirm(`Remove your ${h.grader} ${h.grade ?? ''} ${slot.name} from your collection?`)) return;
    run(x, () => (h.quantity > 1 ? patch(`/api/collection/${h.id}`, { quantity: h.quantity - 1 }) : del(`/api/collection/${h.id}`)), `Removed one ${slot.name} · ${x.label}`);
  };
  const have = slot.printings.filter((x) => x.have).length;

  return (
    <Sheet title={`${slot.name} · #${slot.number}`} onClose={onClose} class="ms-sheet"
      footer={(close) => (
        <button class="btn" onClick={() => { close(); setTimeout(() => navigate(cardHref(slot.cardId)), 200); }}>Prices &amp; history</button>
      )}>
      <div class="ms-sheet-body">
        <div class="ms-sheet-art"><Thumb card={{ id: slot.cardId, name: slot.name, game: 'pokemon', image: slot.image, imageLarge: slot.imageLarge, number: slot.number }} size="lg" large eager /></div>
        <div class="ms-sheet-main">
          <div class="row-sub">{[slot.rarity, `${have} of ${slot.printings.length} printings`].filter(Boolean).join(' · ')}</div>
          <ul class="ms-printings">
            {slot.printings.map((x) => {
              const k = `${x.cardId}|${x.variant}`;
              return (
                <li class={x.have ? 'have' : ''}>
                  <span class={`pchip ${x.have ? 'have' : ''}`} aria-hidden="true">{x.short}</span>
                  <div class="ms-p-main">
                    <div class="ms-p-name">{x.label}</div>
                    <div class="row-sub num">{x.price != null ? money(x.price) : 'No price yet'}</div>
                  </div>
                  {x.have ? (
                    <div class="stepper" role="group" aria-label={`${x.label} copies`}>
                      <button class="btn icon sm" disabled={busy === k} onClick={() => remove(x)} aria-label={`Remove one ${x.label}`}>−</button>
                      <span class="num">{x.have}</span>
                      <button class="btn icon sm" disabled={busy === k} onClick={() => add(x)} aria-label={`Add one ${x.label}`}>+</button>
                    </div>
                  ) : (
                    <button class="btn sm primary" disabled={busy === k} onClick={() => add(x)}><IconPlus size={15} />Have it</button>
                  )}
                </li>
              );
            })}
          </ul>
          <p class="faint ms-note">Marking a printing adds a near-mint copy to your collection; edit it there for condition, grade or cost.</p>
        </div>
      </div>
    </Sheet>
  );
}
