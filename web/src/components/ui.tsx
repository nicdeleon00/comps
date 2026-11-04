import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { render } from 'preact';
import { pct, money } from '../lib/format';
import { IconX } from './icons';

export function Delta({ value, pill = false, digits = 1 }: { value: number | null | undefined; pill?: boolean; digits?: number }) {
  if (value == null || !Number.isFinite(value)) return <span class="delta flat">—</span>;
  const dir = Math.abs(value) < 0.0005 ? 'flat' : value > 0 ? 'up' : 'down';
  return (
    <span class={`delta ${dir} ${pill ? 'pill' : ''}`}>
      {dir !== 'flat' && (
        <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true" style={{ transform: dir === 'down' ? 'rotate(180deg)' : undefined }}>
          <path d="M5 1.2L9 7.8H1z" fill="currentColor" />
        </svg>
      )}
      <span class="sr">{dir === 'up' ? 'up' : dir === 'down' ? 'down' : ''}</span>
      {pct(Math.abs(value), { signed: false, digits })}
    </span>
  );
}

/** Deal score 0–100 as a small ring. */
export function Score({ value }: { value: number }) {
  const r = 16;
  const c = 2 * Math.PI * r;
  const [shown, setShown] = useState(0);
  useEffect(() => { const id = requestAnimationFrame(() => setShown(value)); return () => cancelAnimationFrame(id); }, [value]);
  const color = value >= 60 ? 'var(--up)' : value >= 40 ? 'var(--accent)' : 'var(--label-3)';
  return (
    <div class="score" style={{ '--sc': color }} title={`Deal score ${value} of 100`} aria-label={`Score ${value}`}>
      <svg width="38" height="38" viewBox="0 0 38 38" aria-hidden="true">
        <circle class="track" cx="19" cy="19" r={r} fill="none" stroke-width="3" />
        <circle class="val" cx="19" cy="19" r={r} fill="none" stroke-width="3" stroke-dasharray={c} stroke-dashoffset={c * (1 - shown / 100)} />
      </svg>
      <span>{value}</span>
    </div>
  );
}

/** iOS-style segmented control with a spring-animated thumb. */
export function Segmented<T extends string>({ value, options, onChange, scroll = false, label }: {
  value: T; options: { value: T; label: string; count?: number }[]; onChange: (v: T) => void; scroll?: boolean; label?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  const first = useRef(true);
  useLayoutEffect(() => {
    const el = wrap.current?.querySelector<HTMLButtonElement>(`button[data-v="${CSS.escape(value)}"]`);
    if (!el || !wrap.current) return;
    setThumb({ x: el.offsetLeft, w: el.offsetWidth });
    if (scroll) {
      // Scroll only this row sideways (scrollIntoView would also move the page behind a card panel).
      const box = wrap.current;
      const left = el.offsetLeft - 8, right = el.offsetLeft + el.offsetWidth + 8;
      const target = left < box.scrollLeft ? left : right > box.scrollLeft + box.clientWidth ? right - box.clientWidth : null;
      if (target != null) box.scrollTo({ left: Math.max(0, target), behavior: first.current ? 'auto' : 'smooth' });
    }
    first.current = false;
  }, [value, options.map((o) => o.label + (o.count ?? '')).join()]);
  return (
    <div class={`seg ${scroll ? 'scroll' : ''}`} ref={wrap} role="radiogroup" aria-label={label}>
      {thumb && <span class="seg-thumb" style={{ width: thumb.w, transform: `translateX(${thumb.x}px)` }} />}
      {options.map((o) => (
        <button type="button" role="radio" aria-checked={o.value === value} data-v={o.value} onClick={() => onChange(o.value)}>
          {o.label}{o.count != null && <span class="c">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Chips<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string; color?: string }[]; onChange: (v: T) => void }) {
  return (
    <div class="chips" role="group">
      {options.map((o) => (
        <button type="button" class="chip" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.color && <i class="swatch" style={{ background: o.color }} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

const GRADER_COLOR: Record<string, string> = { PSA: 'var(--psa)', BGS: 'var(--bgs)', CGC: 'var(--cgc)', SGC: 'var(--sgc)' };

export function GradeBadge({ grader, grade, condition }: { grader?: string | null; grade?: string | null; condition?: string | null }) {
  if (grader && grade) return <span class="badge grade" style={{ '--gc': GRADER_COLOR[grader.toUpperCase()] ?? 'var(--label)' }}>{grader.toUpperCase()} {grade}</span>;
  return <span class="badge">Raw{condition && condition !== 'NM' ? ` · ${condition}` : ''}</span>;
}

/** Counts up to a new value — used for headline prices. */
export function Counter({ value, format = money }: { value: number | null | undefined; format?: (v: number) => string }) {
  const [shown, setShown] = useState(value ?? 0);
  const from = useRef(value ?? 0);
  useEffect(() => {
    if (value == null) return;
    const start = performance.now();
    const a = from.current;
    const b = value;
    if (a === b || matchMedia('(prefers-reduced-motion: reduce)').matches) { setShown(b); from.current = b; return; }
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / 700);
      const e = 1 - Math.pow(1 - k, 4);
      setShown(a + (b - a) * e);
      if (k < 1) raf = requestAnimationFrame(tick);
      else from.current = b;
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); from.current = b; };
  }, [value]);
  if (value == null) return <>—</>;
  return <>{format(shown)}</>;
}

export function Empty({ icon, title, children, action }: { icon?: ComponentChildren; title: string; children?: ComponentChildren; action?: ComponentChildren }) {
  return (
    <div class="empty fade">
      {icon && <div class="icon-wrap">{icon}</div>}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function SkRows({ n = 6 }: { n?: number }) {
  return (
    <div>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} style={{ display: 'flex', gap: 14, alignItems: 'center', padding: '10px 0', opacity: 1 - i * 0.12 }}>
          <div class="sk" style={{ width: 44, height: 61, borderRadius: 3 }} />
          <div style={{ flex: 1 }}>
            <div class="sk" style={{ width: '42%', height: 13, marginBottom: 8 }} />
            <div class="sk" style={{ width: '26%', height: 11 }} />
          </div>
          <div class="sk" style={{ width: 64, height: 14 }} />
        </div>
      ))}
    </div>
  );
}

/** Modal sheet: centered on desktop, bottom sheet with drag-to-dismiss on phones. */
export function Sheet({ title, onClose, children, footer, class: cls = '' }: { title?: string; onClose: () => void; children: ComponentChildren; footer?: (close: () => void) => ComponentChildren; class?: string }) {
  const [closing, setClosing] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y0: number; dy: number } | null>(null);
  const close = () => { setClosing(true); setTimeout(onClose, 190); };
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && close();
    addEventListener('keydown', k);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = panel.current?.querySelector<HTMLElement>('input, select, textarea, button:not(.sheet-x)');
    focusable?.focus({ preventScroll: true });
    return () => { removeEventListener('keydown', k); document.body.style.overflow = prev; };
  }, []);
  const onDown = (e: PointerEvent) => {
    if (innerWidth > 700 || (e.target as HTMLElement).closest('input,select,textarea,button,a')) return;
    drag.current = { y0: e.clientY, dy: 0 };
  };
  const onMove = (e: PointerEvent) => {
    if (!drag.current || !panel.current) return;
    const dy = Math.max(0, e.clientY - drag.current.y0);
    drag.current.dy = dy;
    panel.current.style.transition = 'none';
    panel.current.style.transform = `translateY(${dy}px)`;
  };
  const onUp = () => {
    if (!drag.current || !panel.current) return;
    const { dy } = drag.current;
    drag.current = null;
    panel.current.style.transition = 'transform var(--spring-dur) var(--spring)';
    if (dy > 110) { panel.current.style.transform = 'translateY(100%)'; setTimeout(onClose, 220); }
    else panel.current.style.transform = '';
  };
  return (
    <>
      <div class={`scrim ${closing ? 'out' : ''}`} onClick={close} />
      <div class={`sheet ${cls} ${closing ? 'out' : ''}`} ref={panel} role="dialog" aria-modal="true" aria-label={title}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <div class="grabber" />
        {title && (
          <div class="sheet-head">
            <h3>{title}</h3>
            <button class="btn icon sm sheet-x" onClick={close} aria-label="Close"><IconX size={16} /></button>
          </div>
        )}
        {children}
        {footer && <div class="sheet-foot">{footer(close)}</div>}
      </div>
    </>
  );
}

let toastTimer = 0;
export function toast(message: string) {
  let host = document.getElementById('toast-host');
  if (!host) { host = document.createElement('div'); host.id = 'toast-host'; document.body.appendChild(host); }
  clearTimeout(toastTimer);
  render(null, host);
  render(<div class="toast" role="status">{message}</div>, host);
  toastTimer = window.setTimeout(() => render(null, host!), 2400);
}

export function Field({ label, children, hint }: { label: string; children: ComponentChildren; hint?: ComponentChildren }) {
  return (
    <label class="field">
      <span>{label}</span>
      {children}
      {hint && <small class="faint" style={{ fontSize: 12 }}>{hint}</small>}
    </label>
  );
}

export function MoneyInput(props: Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "value"> & { value: string | number; onValue: (v: string) => void }) {
  const { value, onValue, ...rest } = props;
  return (
    <div class="input-wrap">
      <span class="prefix">$</span>
      <input class="input num" inputMode="decimal" value={value} onInput={(e) => onValue((e.target as HTMLInputElement).value)} {...rest} />
    </div>
  );
}
