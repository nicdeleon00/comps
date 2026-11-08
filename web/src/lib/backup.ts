// Your collection as files you keep: JSON (everything) and CSV (opens in Excel or Google Sheets).
import type { Holding } from './types';

const FIELDS = ['id', 'cardId', 'name', 'setName', 'number', 'variant', 'grader', 'grade', 'condition', 'quantity',
  'costBasis', 'acquiredAt', 'notes', 'createdAt', 'updatedAt', 'value', 'total', 'image'] as const;

function save(name: string, type: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}

const cell = (v: unknown) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Downloads the collection as a JSON and a CSV file. Returns how many cards were saved. */
export function downloadBackup(items: Holding[]): number {
  const day = new Date().toISOString().slice(0, 10);
  const cards = items.reduce((n, h) => n + (h.quantity || 1), 0);
  const rows = items.map((h) => Object.fromEntries(FIELDS.map((f) => [f, (h as unknown as Record<string, unknown>)[f] ?? null])));
  save(`comps-backup-${day}-${cards}-cards.json`, 'application/json',
    JSON.stringify({ exportedAt: new Date().toISOString(), cards, lines: rows.length, holdings: rows }, null, 1));
  const csv = [FIELDS.join(','), ...rows.map((r) => FIELDS.map((f) => cell(r[f])).join(','))].join('\n');
  setTimeout(() => save(`comps-backup-${day}-${cards}-cards.csv`, 'text/csv', csv), 400);
  return cards;
}
