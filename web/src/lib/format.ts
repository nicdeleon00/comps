const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = new Intl.NumberFormat('en-US');

export function money(v: number | null | undefined, opts: { whole?: boolean } = {}): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (opts.whole || Math.abs(v) >= 1000) return usd0.format(v);
  return usd2.format(v);
}

export function signedMoney(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return (v >= 0 ? '+' : '−') + money(Math.abs(v));
}

export function pct(v: number | null | undefined, { signed = true, digits = 1 } = {}): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = Math.abs(v * 100).toFixed(Math.abs(v) >= 10 ? 0 : digits);
  if (!signed) return `${s}%`;
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${s}%`;
}

export function multiple(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)}×`;
}

export const num = (v: number) => int.format(v);

export function ago(ts: number | null | undefined): string {
  if (!ts) return 'never';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function shortDate(d: string): string {
  const dt = new Date(d + 'T00:00:00Z');
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function longDate(d: string): string {
  const dt = new Date(d + 'T00:00:00Z');
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export const GAME_LABEL: Record<string, string> = { pokemon: 'Pokémon', mtg: 'Magic', yugioh: 'Yu-Gi-Oh!', sports: 'Sports', other: 'Other' };

export const GRADE_LABEL: Record<string, string> = {
  raw: 'Raw', g7: 'Grade 7', g8: 'Grade 8', g9: 'PSA 9', g95: 'Grade 9.5', psa10: 'PSA 10', bgs10: 'BGS 10', cgc10: 'CGC 10', sgc10: 'SGC 10',
};

export function cardLine(c: { set?: string | null; number?: string | null; total?: string | null; year?: number | null; game?: string }) {
  const parts: string[] = [];
  if (c.set) parts.push(c.set);
  if (c.number) parts.push(c.total ? `${c.number}/${c.total}` : `#${c.number}`);
  return parts.join(' · ');
}

export const cardHref = (id: string) => `/card/${encodeURIComponent(id)}`;
export const cardApi = (id: string) => `/api/cards/${encodeURIComponent(id)}`;
