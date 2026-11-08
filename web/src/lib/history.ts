// History: the collection grouped by when cards were added. One "Add to Collection" (a scan
// session in the iPhone app, a binder page, or one card added by hand) saves all its cards
// within a split second, and the add time travels with each card when it syncs, so the
// website and the app (AddHistory in ios/Comps/Views/HistoryView.swift) group them the same.
// No imports, so it can be unit-tested with Node directly.

/** Cards added within this long of each other were added together. */
export const GAP_MS = 5000;

type Added = { id: string; createdAt: number; quantity: number; total?: number | null };

export type AddSession<T extends Added> = {
  id: string;
  start: number;
  /** In the order they were added, which for a scan is the order they were scanned. */
  items: T[];
  cards: number;
  value: number;
};

/** Newest first. */
export function sessions<T extends Added>(list: T[], gap = GAP_MS): AddSession<T>[] {
  const out: AddSession<T>[] = [];
  let run: T[] = [];
  const close = () => {
    if (!run.length) return;
    out.push({
      id: run[0].id, start: run[0].createdAt, items: run,
      cards: run.reduce((n, h) => n + (h.quantity || 1), 0),
      value: Math.round(run.reduce((n, h) => n + (h.total ?? 0), 0) * 100) / 100,
    });
    run = [];
  };
  for (const h of [...list].sort((a, b) => a.createdAt - b.createdAt)) {
    const last = run[run.length - 1];
    if (last && h.createdAt - last.createdAt > gap) close();
    run.push(h);
  }
  close();
  return out.reverse();
}

const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** Sessions grouped by the (local) day they were added, newest first. */
export function byDay<T extends Added>(list: AddSession<T>[]): { day: number; sessions: AddSession<T>[] }[] {
  const out: { day: number; sessions: AddSession<T>[] }[] = [];
  for (const s of list) {
    const day = startOfDay(s.start);
    const last = out[out.length - 1];
    if (last && last.day === day) last.sessions.push(s);
    else out.push({ day, sessions: [s] });
  }
  return out;
}

export function dayTitle(day: number, now = Date.now()): string {
  const today = startOfDay(now);
  if (day === today) return 'Today';
  if (day === startOfDay(today - 12 * 3_600_000)) return 'Yesterday';
  const d = new Date(day);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { weekday: 'long', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}
