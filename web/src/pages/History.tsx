import { useMemo, useState } from 'preact/hooks';
import { useData, del, invalidate } from '../lib/api';
import { Link, setHero } from '../lib/router';
import { money, cardHref, cardApi } from '../lib/format';
import type { Holding, CollectionSummary } from '../lib/types';
import { sessions, byDay, dayTitle, type AddSession } from '../lib/history';
import { Thumb } from '../components/Thumb';
import { GradeBadge, Empty, SkRows, toast } from '../components/ui';
import { HoldingSheet } from '../components/HoldingSheet';
import { IconChevron, IconHistory, IconPencil, IconSearch } from '../components/icons';
import { Header } from './shared';

type Res = { items: Holding[]; summary: CollectionSummary };

const cards = (n: number) => `${n} card${n === 1 ? '' : 's'}`;
const time = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
/** Every word has to appear in the card's name, set or number. */
const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const matches = (h: Holding, words: string[]) => {
  const n = (h.number ?? '').toLowerCase();
  const hay = fold(`${h.name} ${h.setName ?? ''} ${n} #${n} ${n.replace(/^0+/, '')}`);
  return words.every((w) => hay.includes(w));
};
const thumbCard = (h: Holding) => ({ id: h.cardId, name: h.name, game: h.game, image: h.imageUrl, set: h.setName ?? undefined, number: h.number ?? undefined });

/**
 * Everything added to the collection, one entry per "Add to Collection" (a scan session in
 * the iPhone app, a binder page, a card added by hand), so a scan can be checked and fixed.
 */
export function HistoryPage() {
  const { data, loading } = useData<Res>('/api/collection?days=30');
  // Cards of the sessions that are open; null until one is toggled (the newest starts open).
  const [open, setOpen] = useState<Set<string> | null>(null);
  const [editing, setEditing] = useState<Holding | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const words = fold(query).split(/\s+/).filter(Boolean);
  const all = useMemo(() => byDay(sessions(data?.items ?? [])), [data]);
  // Searching: only the adds with a matching card, each showing just those cards, all open.
  const days = useMemo(() => {
    if (!words.length) return all;
    return all.map((d) => ({ ...d, sessions: d.sessions.map((s) => ({ ...s, items: s.items.filter((h) => matches(h, words)) })).filter((s) => s.items.length) }))
      .filter((d) => d.sessions.length);
  }, [all, query]);
  const found = words.length ? days.reduce((n, d) => n + d.sessions.reduce((m, s) => m + s.items.reduce((k, h) => k + (h.quantity || 1), 0), 0), 0) : 0;
  const newest = all[0]?.sessions[0];

  const isOpen = (s: AddSession<Holding>) => words.length > 0 || (open ? s.items.some((h) => open.has(h.id)) : s.id === newest?.id);
  const toggle = (s: AddSession<Holding>) => {
    const next = new Set(open ?? newest?.items.map((h) => h.id) ?? []);
    if (isOpen(s)) s.items.forEach((h) => next.delete(h.id));
    else s.items.forEach((h) => next.add(h.id));
    setOpen(next);
  };

  const removeAll = async (s: AddSession<Holding>) => {
    if (!confirm(`Remove all ${cards(s.cards)} added at ${time(s.start)} from your collection?`)) return;
    setBusy(true);
    try {
      for (const h of s.items) await del(`/api/collection/${h.id}`);
      invalidate('/api/');
      toast(`Removed ${cards(s.cards)}`);
    } catch (e) {
      toast((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div class="page">
      <Header title="History">
        <span>Every time cards were added, newest first. Open one to check what a scan added and fix it.</span>
      </Header>

      {data && data.items.length > 0 && (
        <div class="toolbar">
          <div class="input-wrap hist-search">
            <span class="prefix"><IconSearch size={14} /></span>
            <input class="input" type="search" placeholder="Find a card you added: name, set or number" value={query}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)} aria-label="Search History" />
          </div>
          {words.length > 0 && <span class="muted">{found} card{found === 1 ? '' : 's'} found</span>}
        </div>
      )}
      {words.length > 0 && !days.length && <Empty icon={<IconSearch size={26} />} title="No cards match">Try fewer words, or the card number.</Empty>}

      {loading && !data && <SkRows n={6} />}

      {data && !data.items.length && (
        <Empty icon={<IconHistory size={26} />} title="Nothing added yet" action={<Link class="btn primary" href="/">Go to Collection</Link>}>
          Cards you scan with the iPhone app or add here show up in History, grouped by each time you added them.
        </Empty>
      )}

      {days.map((d) => (
        <section class="section hist-day" key={d.day}>
          <div class="section-head">
            <h2>{dayTitle(d.day)}</h2>
            <span class="muted num">{cards(d.sessions.reduce((n, s) => n + s.cards, 0))} · {money(d.sessions.reduce((n, s) => n + s.value, 0))}</span>
          </div>
          <div class="hist-list">
            {d.sessions.map((s) => {
              const opened = isOpen(s);
              const names = s.items.slice(0, 3).map((h) => h.name).join(', ') + (s.items.length > 3 ? ` +${s.items.length - 3} more` : '');
              return (
                <div class={`panel hist-session ${opened ? 'open' : ''}`} key={s.id}>
                  <button class="hist-head" onClick={() => toggle(s)} aria-expanded={opened}>
                    <div class="hist-fan" aria-hidden="true">
                      {s.items.slice(0, 4).map((h, i) => <span style={{ '--i': i }}><Thumb card={thumbCard(h)} size="md" banner={h.language === 'zh' ? 'Chinese' : undefined} /></span>)}
                    </div>
                    <div class="row-main">
                      <div class="row-title"><span class="t">{s.cards === 1 ? s.items[0].name : cards(s.cards)}</span></div>
                      <div class="row-sub">{time(s.start)} · {s.cards === 1 ? [s.items[0].setName, s.items[0].number && `#${s.items[0].number}`].filter(Boolean).join(' · ') : names}</div>
                    </div>
                    <div class="row-right"><div class="row-value">{money(s.value)}</div></div>
                    <IconChevron size={18} class="hist-chev" />
                  </button>
                  {opened && (
                    <div class="hist-body">
                      <div class="hist-tools">
                        <span class="muted">{words.length ? 'The matching cards from this add. Edit a card to fix it.' : 'In the order they were added. Edit a card to fix the card itself, its printing, grade or quantity.'}</span>
                        {!words.length && <button class="btn sm" style={{ color: 'var(--down)' }} disabled={busy} onClick={() => removeAll(s)}>Remove all</button>}
                      </div>
                      {s.items.map((h, i) => (
                        <div class="row hist-row enter" style={{ '--i': i }} key={h.id}>
                          <Link href={cardHref(h.cardId)} prefetchUrl={cardApi(h.cardId)} class="holding-link" onClick={() => setHero(h.cardId)}>
                            <Thumb card={thumbCard(h)} banner={h.language === 'zh' ? 'Chinese' : undefined} />
                            <div class="row-main">
                              <div class="row-title"><span class="t">{h.name}</span>{h.language === 'zh' && <span class="lang-pill">Chinese</span>}{h.quantity > 1 && <span class="qty">×{h.quantity}</span>}</div>
                              <div class="row-sub">{h.setName}{h.number ? ` · #${h.number}` : ''}</div>
                            </div>
                          </Link>
                          <GradeBadge grader={h.grader} grade={h.grade} condition={h.condition} />
                          <div class="row-right"><div class="row-value">{money(h.total)}</div></div>
                          <button class="btn icon sm" onClick={() => setEditing(h)} aria-label={`Fix ${h.name}`} title="Fix this card"><IconPencil size={15} /></button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {editing && <HoldingSheet cardId={editing.cardId} holding={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
