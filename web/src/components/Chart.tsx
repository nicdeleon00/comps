// Hand-rolled SVG charts: one series, hairline grid, crosshair that snaps to
// the nearest day, a value-first tooltip, and an end dot with a surface ring.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { money, longDate, shortDate } from '../lib/format';

export type Pt = { d: string; v: number };

function niceTicks(min: number, max: number, count = 4) {
  if (min === max) { min *= 0.9; max *= 1.1; }
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const err = step0 / mag;
  const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { lo, hi, ticks, step };
}

/** Axis labels: in full under 10,000; compact above, with enough precision to stay distinct. */
function tickFormat(step: number, max: number) {
  const usd = (d: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: d, maximumFractionDigits: d });
  if (max >= 10000 && step >= 1000) {
    const f = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: step % 1000 === 0 ? 0 : 1 });
    return (v: number) => '$' + f.format(v);
  }
  const f = usd(step >= 1 ? 0 : 2);
  return (v: number) => f.format(v);
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export function AreaChart({ points, height = 240, tone = 'auto', onScrub, format = money, label }: {
  points: Pt[]; height?: number; tone?: 'auto' | 'up' | 'down' | 'accent'; onScrub?: (p: Pt | null) => void; format?: (v: number) => string; label: string;
}) {
  const [wrap, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const [len, setLen] = useState(0);
  const pad = { t: 12, r: 58, b: 26, l: 0 };
  const W = Math.max(0, width);
  const H = height;
  const iw = Math.max(1, W - pad.l - pad.r);
  const ih = H - pad.t - pad.b;

  const geo = useMemo(() => {
    if (!points.length || !W) return null;
    const vals = points.map((p) => p.v);
    const { lo, hi, ticks, step } = niceTicks(Math.min(...vals), Math.max(...vals));
    const fmt = tickFormat(step, hi);
    const x = (i: number) => pad.l + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw);
    const y = (v: number) => pad.t + ih - ((v - lo) / (hi - lo || 1)) * ih;
    let d = '';
    points.forEach((p, i) => { d += `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`; });
    const area = `${d}L${x(points.length - 1).toFixed(1)},${pad.t + ih}L${x(0).toFixed(1)},${pad.t + ih}Z`;
    return { x, y, d, area, ticks, lo, hi, fmt };
  }, [points, W, H]);

  const dataKey = points.length ? `${points[0].d}-${points.length}-${points[points.length - 1].v}` : '';
  useEffect(() => { if (pathRef.current) setLen(pathRef.current.getTotalLength()); }, [dataKey, W]);

  const first = points[0]?.v ?? 0;
  const last = points[points.length - 1]?.v ?? 0;
  const dir = tone === 'auto' ? (last >= first ? 'up' : 'down') : tone;
  const color = dir === 'up' ? 'var(--up)' : dir === 'down' ? 'var(--down)' : 'var(--accent)';

  const pick = (clientX: number) => {
    if (!geo || !wrap.current) return;
    const r = wrap.current.getBoundingClientRect();
    const rel = Math.min(Math.max(clientX - r.left - pad.l, 0), iw);
    const i = Math.round((rel / iw) * (points.length - 1));
    setHover(i);
    onScrub?.(points[i]);
  };
  const clear = () => { setHover(null); onScrub?.(null); };

  const xLabels = useMemo(() => {
    if (points.length < 2) return [];
    const idx = [0, Math.floor((points.length - 1) / 2), points.length - 1];
    return idx.map((i) => ({ i, t: shortDate(points[i].d) }));
  }, [points]);

  const hp = hover != null ? points[hover] : null;
  const tipX = hover != null && geo ? geo.x(hover) : 0;

  return (
    <div class="chart" ref={wrap} style={{ height: H }}
      onPointerMove={(e) => pick(e.clientX)} onPointerDown={(e) => pick(e.clientX)} onPointerLeave={clear}
      tabIndex={0} role="img" aria-label={label}
      onKeyDown={(e) => {
        if (!points.length) return;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          const i = Math.min(points.length - 1, Math.max(0, (hover ?? points.length - 1) + (e.key === 'ArrowRight' ? 1 : -1)));
          setHover(i); onScrub?.(points[i]);
        }
      }}
      onBlur={clear}>
      {geo && (
        <svg width={W} height={H}>
          <g class="grid">
            {geo.ticks.map((t) => <line x1={pad.l} x2={pad.l + iw} y1={Math.round(geo.y(t)) + 0.5} y2={Math.round(geo.y(t)) + 0.5} />)}
          </g>
          <g class="axis">
            {geo.ticks.map((t) => <text x={W - 2} y={geo.y(t) + 4} text-anchor="end">{geo.fmt(t)}</text>)}
            {xLabels.map(({ i, t }, k) => <text x={geo.x(i)} y={H - 6} text-anchor={k === 0 ? 'start' : k === xLabels.length - 1 ? 'end' : 'middle'}>{t}</text>)}
          </g>
          <path class="area" d={geo.area} fill={color} key={'a' + dataKey} />
          <path ref={pathRef} class={`line ${len ? 'draw' : ''}`} d={geo.d} stroke={color} key={'l' + dataKey} style={{ '--len': len }} />
          {hover == null && <circle class="end-dot" cx={geo.x(points.length - 1)} cy={geo.y(last)} r="4.5" fill={color} />}
          {hp && (
            <g>
              <line class="cross" x1={tipX} x2={tipX} y1={pad.t} y2={pad.t + ih} />
              <circle class="end-dot" cx={tipX} cy={geo.y(hp.v)} r="5" fill={color} />
            </g>
          )}
        </svg>
      )}
      {hp && (
        <div class="tip" style={{ left: Math.min(Math.max(tipX, 60), W - 60), top: -6 }}>
          <strong>{format(hp.v)}</strong>{longDate(hp.d)}
        </div>
      )}
    </div>
  );
}

export function Spark({ values, width = 64, height = 24 }: { values: number[]; width?: number; height?: number }) {
  if (!values || values.length < 2) return <svg width={width} height={height} aria-hidden="true" />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * (width - 2) + 1).toFixed(1)},${(height - 2 - ((v - min) / span) * (height - 4)).toFixed(1)}`).join(' ');
  const up = values[values.length - 1] >= values[0];
  return (
    <svg width={width} height={height} aria-hidden="true">
      <polyline points={pts} fill="none" stroke={up ? 'var(--up)' : 'var(--down)'} stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
    </svg>
  );
}
