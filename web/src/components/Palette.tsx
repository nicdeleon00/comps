// ⌘K search. Opens as a navigator, or as a picker (e.g. "add to collection").
import { useEffect, useRef, useState } from 'preact/hooks';
import { get, prefetch } from '../lib/api';
import { navigate } from '../lib/router';
import { money, cardLine, cardHref, cardApi, GAME_LABEL } from '../lib/format';
import type { Card } from '../lib/types';
import { Thumb } from './Thumb';
import { IconSearch } from './icons';

export type PaletteOpts = { onPick?: (c: Card) => void; placeholder?: string };

export function openPalette(opts: PaletteOpts = {}) {
  window.dispatchEvent(new CustomEvent('comps:palette', { detail: opts }));
}

export function Palette({ opts, onClose }: { opts: PaletteOpts; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Card[]>([]);
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  const close = () => { setClosing(true); setTimeout(onClose, 130); };

  useEffect(() => {
    input.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setItems([]); return; }
    const my = ++seq.current;
    setBusy(true);
    const t = setTimeout(() => {
      get<{ items: Card[] }>(`/api/search?q=${encodeURIComponent(term)}&limit=20`).then((r) => {
        if (my !== seq.current) return;
        setItems(r.items);
        setSel(0);
      }).catch(() => {}).finally(() => my === seq.current && setBusy(false));
    }, 110);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    list.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
    const c = items[sel];
    if (c && !opts.onPick) prefetch(cardApi(c.id));
  }, [sel, items]);

  const choose = (c: Card) => {
    close();
    if (opts.onPick) opts.onPick(c);
    else navigate(cardHref(c.id));
  };

  return (
    <>
      <div class={`scrim ${closing ? 'out' : ''}`} onClick={close} />
      <div class={`sheet palette ${closing ? 'out' : ''}`} role="dialog" aria-modal="true" aria-label="Search cards"
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
          else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
          else if (e.key === 'Enter' && items[sel]) { e.preventDefault(); choose(items[sel]); }
        }}>
        <div class="palette-input">
          <IconSearch size={20} />
          <input ref={input} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} placeholder={opts.placeholder ?? 'Search cards, sets, players'}
            aria-label="Search" autocomplete="off" spellcheck={false} role="combobox" aria-expanded={items.length > 0} aria-controls="palette-list" />
          {busy && <span class="faint" style={{ fontSize: 12 }}>Searching…</span>}
        </div>
        <div class="palette-results" ref={list} id="palette-list" role="listbox">
          {items.length === 0 && (
            <div class="palette-hint">{q.trim().length < 2 ? 'Try “Charizard 4/102”, “Sheoldred”, or “Luka Prizm”.' : busy ? '' : 'No cards match. The catalog fills in after the first refresh.'}</div>
          )}
          {items.map((c, i) => (
            <button type="button" class="row" data-i={i} role="option" aria-selected={i === sel} onMouseMove={() => setSel(i)} onClick={() => choose(c)}>
              <Thumb card={c} />
              <div class="row-main" style={{ textAlign: 'left' }}>
                <div class="row-title"><span class="t">{c.name}</span></div>
                <div class="row-sub">{cardLine(c)} · {GAME_LABEL[c.game]}</div>
              </div>
              <div class="row-right"><div class="row-value">{money(c.price)}</div></div>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
