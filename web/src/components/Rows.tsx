import type { Deal, Spread, Card } from '../lib/types';
import { Link, setHero } from '../lib/router';
import { money, pct, multiple, cardLine, cardHref, cardApi, signedMoney } from '../lib/format';
import { Thumb } from './Thumb';
import { Delta, Score, GradeBadge } from './ui';
import { Spark } from './Chart';

export function dealReason(d: Deal): string {
  const x = d.data ?? {};
  switch (d.kind) {
    case 'listing': return x.title ? `eBay: ${x.title}` : 'eBay Buy It Now';
    case 'ask': return `${d.data?.source === 'direct' ? 'TCGplayer Direct' : 'Lowest TCGplayer'} ask is ${pct(d.discount, { signed: false })} under market — check condition`;
    case 'xmarket': return `Cardmarket trend €${Number(x.eur).toFixed(2)} ≈ ${money(d.price)}, before shipping and import`;
    case 'momentum': return `EU 7-day average up ${pct((x.accel ?? 1) - 1, { signed: false })} on the month; US price hasn't followed`;
    case 'dip': return `Down ${pct(d.discount, { signed: false })} from its 30-day median of ${money(x.median30)}`;
    default: return d.kindLabel;
  }
}

const heroClick = (id: string) => () => setHero(id);

export function DealRow({ d, i = 0 }: { d: Deal; i?: number }) {
  const c = d.card;
  const graded = d.data?.grader;
  return (
    <Link href={cardHref(c.id)} prefetchUrl={cardApi(c.id)} class="row deal-row enter" style={{ '--i': i }} onClick={heroClick(c.id)}>
      <Thumb card={c} />
      <div class="row-main">
        <div class="row-title"><span class="t">{c.name}</span>{graded && <GradeBadge grader={d.data.grader} grade={d.data.grade} />}</div>
        <div class="row-sub">{cardLine(c)}{d.variantLabel ? ` · ${d.variantLabel}` : ''}</div>
        <div class="row-reason"><span class="badge kind">{d.kindLabel}</span><span class="ellipsis">{dealReason(d)}</span></div>
      </div>
      <div class="row-right deal-prices">
        <div class="row-value">{money(d.price)}</div>
        <div class="row-meta">worth {money(d.value)}</div>
      </div>
      <div class="row-right deal-off">
        <div class="off">−{pct(d.discount, { signed: false, digits: 0 })}</div>
        <div class="row-meta">{signedMoney(d.upside)}</div>
      </div>
      <Score value={d.score} />
    </Link>
  );
}

export function SpreadRow({ s, i = 0 }: { s: Spread; i?: number }) {
  const c = s.card;
  const be = s.breakEven;
  return (
    <Link href={cardHref(c.id)} prefetchUrl={cardApi(c.id)} class="row spread-row enter" style={{ '--i': i }} onClick={heroClick(c.id)}>
      <Thumb card={c} />
      <div class="row-main">
        <div class="row-title"><span class="t">{c.name}</span></div>
        <div class="row-sub">{cardLine(c)}{s.variantLabel ? ` · ${s.variantLabel}` : ''}</div>
        <div class="ladder" aria-hidden="true">
          <span>{money(s.raw)}</span>
          <svg width="14" height="8" viewBox="0 0 14 8"><path d="M1 4h11M9 1l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
          {s.g9 != null && <><span class="muted">9 · {money(s.g9)}</span><span class="faint">/</span></>}
          <b>10 · {money(s.psa10)}</b>
        </div>
      </div>
      <div class="row-right sp-col">
        <div class="row-value">{multiple(s.multiple)}</div>
        <div class="row-meta">10 vs raw</div>
      </div>
      <div class="row-right sp-col sp-be">
        <div class="row-value">{be == null ? 'Never' : pct(be, { signed: false, digits: 0 })}</div>
        <div class="row-meta">{be == null ? 'even at 100% 10s' : be <= 0.005 ? 'no 10 needed' : '10s to break even'}</div>
      </div>
      <div class="row-right sp-profit">
        <div class={`row-value ${s.profit >= 0 ? 'up' : 'down'}`}>{signedMoney(s.profit)}</div>
        <div class="row-meta">EV · {pct(s.roi, { digits: 0 })}</div>
      </div>
    </Link>
  );
}

export function CardRow({ c, i = 0, right }: { c: Card; i?: number; right?: preact.ComponentChildren }) {
  return (
    <Link href={cardHref(c.id)} prefetchUrl={cardApi(c.id)} class="row card-row enter" style={{ '--i': i }} onClick={heroClick(c.id)}>
      <Thumb card={c} />
      <div class="row-main">
        <div class="row-title"><span class="t">{c.name}</span></div>
        <div class="row-sub">{cardLine(c)}</div>
      </div>
      {c.spark && <Spark values={c.spark} />}
      {right ?? (
        <div class="row-right">
          <div class="row-value">{money(c.price)}</div>
          <Delta value={c.change7d} />
        </div>
      )}
    </Link>
  );
}
