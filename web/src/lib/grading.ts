// Client copy of server/src/engine/grading.js so the calculator updates live.
import type { Costs, Grades, Outcome } from './types';

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const r2 = (x: number) => Math.round(x * 100) / 100;

export interface EV { cost: number; ev: number; profit: number; roi: number; breakEven: number | null; outcomes: Outcome[]; if10: number }

export function gradeEV(raw: number, g: Grades, c: Costs, r: { p10: number; p9: number; p8: number }): EV | null {
  const v10 = g.psa10;
  if (!(raw > 0) || !v10) return null;
  const v9 = g.g9 ?? null;
  const v8 = g.g8 ?? (v9 != null ? Math.min(v9, raw * 1.15) : raw);
  const vLow = g.g7 != null ? Math.min(g.g7, v8) : Math.min(raw * 0.9, v8);
  const net = (v: number) => v * (1 - c.sellFeePct) - c.sellFixed;
  const p10 = clamp(r.p10);
  const p9 = clamp(r.p9, 0, 1 - p10);
  const p8 = clamp(r.p8, 0, 1 - p10 - p9);
  const pLow = Math.max(0, 1 - p10 - p9 - p8);
  const outcomes = [
    { grade: '10', p: p10, value: v10 },
    { grade: '9', p: p9, value: v9 ?? v8 },
    { grade: '8', p: p8, value: v8 },
    { grade: '≤7', p: pLow, value: vLow },
  ].map((o) => ({ ...o, net: net(o.value) }));
  const cost = raw + c.fee + c.shipping;
  const ev = outcomes.reduce((s, o) => s + o.p * o.net, 0);
  const rest = 1 - p10;
  const nonTen = rest > 0 ? outcomes.slice(1).reduce((s, o) => s + (o.p / rest) * o.net, 0) : outcomes[1].net;
  const ten = outcomes[0].net;
  const breakEven = ten > cost ? clamp((cost - nonTen) / (ten - nonTen)) : null;
  return { cost: r2(cost), ev: r2(ev), profit: r2(ev - cost), roi: (ev - cost) / cost, breakEven, outcomes: outcomes.map((o) => ({ ...o, net: r2(o.net) })), if10: r2(ten - cost) };
}
