import { useState, useRef, useEffect } from 'preact/hooks';
import type { Card } from '../lib/types';

const GAME_VAR: Record<string, string> = { pokemon: 'var(--c-pokemon)', mtg: 'var(--c-mtg)', yugioh: 'var(--c-yugioh)', sports: 'var(--c-sports)', other: 'var(--c-other)' };

type ThumbCard = Pick<Card, 'name' | 'game'> & Partial<Pick<Card, 'image' | 'imageLarge' | 'set' | 'number' | 'year' | 'id'>>;

/**
 * Card image with a typeset fallback (sports cards and anything without art
 * get a slab-label style tile instead of a broken image).
 */
export function Thumb({ card, size = 'sm', large = false, hero = false, eager = false }: { card: ThumbCard; size?: 'sm' | 'md' | 'lg'; large?: boolean; hero?: boolean; eager?: boolean }) {
  const src = large ? card.imageLarge ?? card.image : card.image;
  const [state, setState] = useState<'loading' | 'ok' | 'err'>(src ? 'loading' : 'err');
  const img = useRef<HTMLImageElement>(null);
  useEffect(() => {
    setState(src ? 'loading' : 'err');
  }, [src]);
  useEffect(() => {
    // Cached images can finish before hydration attaches onLoad.
    if (img.current?.complete && img.current.naturalWidth) setState('ok');
  }, [src]);
  const showPh = state !== 'ok';
  return (
    <div class={`thumb ${size === 'sm' ? '' : size} ${size === 'sm' ? 'sm-hide' : ''}`} style={{ '--g': GAME_VAR[card.game] ?? 'var(--c-other)', ...(hero ? { viewTransitionName: 'hero' } : {}) }}>
      {showPh && (
        <div class="ph" aria-hidden="true">
          <div class="ph-label">
            <span class="ph-set">{[card.year, card.set].filter(Boolean).join(' ')}</span>
            {card.number && <span class="ph-num">#{card.number}</span>}
          </div>
          <div class="ph-mono">{(card.name.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase()}</div>
          <div class="ph-name">{card.name}</div>
        </div>
      )}
      {src && state !== 'err' && (
        <img ref={img} src={src} alt={card.name} loading={eager ? 'eager' : 'lazy'} decoding="async" class={state === 'ok' ? 'ok' : ''}
          onLoad={() => setState('ok')} onError={() => setState('err')} />
      )}
    </div>
  );
}

/** Large card with pointer tilt and a moving sheen, like holding it under a light. */
export function TiltCard({ card, hero }: { card: ThumbCard; hero?: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const raf = useRef(0);
  const move = (e: PointerEvent) => {
    const r = el.current!.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const s = el.current!.style;
      s.transition = 'transform 120ms ease-out';
      s.transform = `perspective(900px) rotateY(${x * 14}deg) rotateX(${-y * 14}deg) scale(1.02)`;
      s.setProperty('--mx', `${(x + 0.5) * 100}%`);
      s.setProperty('--my', `${(y + 0.5) * 100}%`);
      s.setProperty('--sheen', '1');
    });
  };
  const leave = () => {
    cancelAnimationFrame(raf.current);
    const s = el.current!.style;
    s.transition = 'transform var(--spring-dur) var(--spring)';
    s.transform = '';
    s.setProperty('--sheen', '0');
  };
  return (
    <div class="tilt" ref={el} onPointerMove={(e) => e.pointerType === 'mouse' && move(e)} onPointerLeave={leave}>
      <Thumb card={card} size="lg" large hero={hero} eager />
      <div class="sheen" aria-hidden="true" />
    </div>
  );
}
