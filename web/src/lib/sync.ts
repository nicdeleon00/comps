// Keeps this browser's collection, card watchlist and settings in step with your
// account — and so with the iPhone app. Each sync downloads only what changed on
// the server since last time, merges (newest change wins per card; deletions
// travel as tombstones), and saves this browser's own changes back.

import { invalidate } from './api';
import { merge, type SyncItem } from './syncMerge';
import { accountsEnabled, currentUser, onAuth, rest, rpc } from './supabase';

export type { SyncItem };

type State = {
  userId?: string;
  cursor?: number;      // newest server change time seen
  synced?: boolean;     // first sync for this account done on this browser
  last?: number;
  error?: string;
  count?: number;
  dirty?: string[];     // cards changed here since the last sync
  dataAt?: number;      // watchlist/settings last changed here
  dataSyncedAt?: number;
};

const STATE_KEY = 'comps.account.sync';
const listeners = new Set<() => void>();

export function syncState(): State {
  try { return JSON.parse(localStorage.getItem(STATE_KEY) ?? '{}') as State; } catch { return {}; }
}
function setState(patch: Partial<State> | null) {
  const next = patch ? { ...syncState(), ...patch } : {};
  try { localStorage.setItem(STATE_KEY, JSON.stringify(next)); } catch {}
  listeners.forEach((l) => l());
}
export function onSync(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** Called by the collection store when cards are added, edited or removed here. */
export function markDirty(ids: string[]) {
  const s = syncState();
  setState({ dirty: [...new Set([...(s.dirty ?? []), ...ids])] });
  syncSoon();
}
/** Called when the card watchlist or settings change here. */
export function markDataChanged() {
  setState({ dataAt: Date.now() });
  syncSoon();
}

// ---------------------------------------------------------------- local storage (shared with static.ts)
type Local = {
  id: string; cardId: string; game: string; name: string; setName: string | null; number: string | null; image: string | null;
  variant: string | null; grader: string | null; grade: string | null; condition: string; quantity: number; costBasis: number | null;
  acquiredAt: string | null; notes: string | null; createdAt: number; updatedAt: number; deleted?: boolean;
  language?: string | null; customValue?: number | null;
};
const LS = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(`comps.${k}`); return v ? (JSON.parse(v) as T) : d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(`comps.${k}`, JSON.stringify(v)); } catch {} },
  del(k: string) { try { localStorage.removeItem(`comps.${k}`); } catch {} },
};

const toItem = (h: Local): SyncItem => ({
  id: h.id, cardId: h.cardId, name: h.name, set: h.setName, number: h.number, image: h.image, variant: h.variant, grader: h.grader, grade: h.grade,
  condition: h.condition || 'NM', quantity: h.quantity, cost: h.costBasis, acquiredAt: h.acquiredAt, notes: h.notes, createdAt: h.createdAt,
  updatedAt: h.updatedAt, ...(h.deleted ? { deleted: true } : {}), language: h.language ?? null, customValue: h.customValue ?? null,
});
const fromItem = (i: SyncItem): Local => ({
  id: i.id, cardId: i.cardId, game: 'pokemon', name: i.name, setName: i.set ?? null, number: i.number ?? null, image: i.image ?? null,
  variant: i.variant ?? null, grader: i.grader ?? null, grade: i.grade ?? null, condition: i.condition || 'NM', quantity: i.quantity || 1,
  costBasis: i.cost ?? null, acquiredAt: i.acquiredAt ?? null, notes: i.notes ?? null, createdAt: i.createdAt ?? i.updatedAt, updatedAt: i.updatedAt,
  ...(i.deleted ? { deleted: true } : {}), language: i.language ?? null, customValue: i.customValue ?? null,
});

type Row = {
  id: string; card_id: string; name: string; set_name: string | null; number: string | null; image: string | null; variant: string | null;
  grader: string | null; grade: string | null; condition: string; quantity: number; cost: number | string | null; acquired_at: string | null;
  notes: string | null; created_at: number | null; updated_at: number; deleted: boolean; synced_at: number;
  language?: string | null; custom_value?: number | string | null;
};
const fromRow = (r: Row): SyncItem => ({
  id: r.id, cardId: r.card_id, name: r.name, set: r.set_name, number: r.number, image: r.image, variant: r.variant, grader: r.grader, grade: r.grade,
  condition: r.condition || 'NM', quantity: r.quantity, cost: r.cost == null ? null : Number(r.cost), acquiredAt: r.acquired_at, notes: r.notes,
  createdAt: r.created_at == null ? undefined : Number(r.created_at), updatedAt: Number(r.updated_at), ...(r.deleted ? { deleted: true } : {}),
  language: r.language ?? null, customValue: r.custom_value == null ? null : Number(r.custom_value),
});
const toRow = (i: SyncItem) => ({
  id: i.id, card_id: i.cardId, name: i.name, set_name: i.set ?? null, number: i.number ?? null, image: i.image ?? null, variant: i.variant ?? null,
  grader: i.grader ?? null, grade: i.grade ?? null, condition: i.condition || 'NM', quantity: i.quantity || 1, cost: i.cost ?? null,
  acquired_at: i.acquiredAt ?? null, notes: i.notes ?? null, created_at: i.createdAt ?? null, updated_at: i.updatedAt, deleted: Boolean(i.deleted),
  language: i.language ?? null, custom_value: i.customValue ?? null,
});

const sameList = (a: SyncItem[], b: SyncItem[]) => {
  if (a.length !== b.length) return false;
  const m = new Map(b.map((x) => [x.id.toLowerCase(), x]));
  return a.every((x) => { const y = m.get(x.id.toLowerCase()); return y && y.updatedAt === x.updatedAt && Boolean(y.deleted) === Boolean(x.deleted); });
};

// ---------------------------------------------------------------- sync
let running: Promise<void> | null = null;

function syncNow(): Promise<void> {
  if (running) return running;
  running = (async () => {
    const user = currentUser();
    if (!accountsEnabled || !user) return;
    let s = syncState();
    if (s.userId !== user.id) {
      // First time this account syncs in this browser: what's here gets merged in.
      setState(null);
      setState({ userId: user.id });
      s = syncState();
    }
    const dirtyAtStart = new Set(s.dirty ?? []);
    try {
      if (!s.synced) LS.del('sync'); // an old GitHub gist sync token, no longer used

      // 1. What changed on the server (a 5 s overlap guards against slow commits).
      const rows: Row[] = [];
      let after = Math.max(0, (s.cursor ?? 0) - 5000);
      for (;;) {
        const page = await rest<Row[]>(`holdings?select=*&synced_at=gt.${after}&order=synced_at.asc&limit=1000`);
        rows.push(...page);
        if (page.length < 1000) break;
        after = Number(page[page.length - 1].synced_at);
      }
      const remote = rows.map(fromRow);
      const localRaw = LS.get<Local[]>('holdings', []);
      const local = localRaw.map(toItem);

      // 2. Merge (on the first sync, the same card added on both before signing in is kept once).
      const merged = merge(local, remote, { firstSync: !s.synced, preferLocal: false });
      const remoteById = new Map(remote.map((r) => [r.id.toLowerCase(), r]));
      const toPush = merged.filter((m) => {
        const r = remoteById.get(m.id);
        if (r) return m.updatedAt > r.updatedAt || (Boolean(m.deleted) && !r.deleted);
        return !s.synced || dirtyAtStart.has(m.id) || dirtyAtStart.has(m.id.toUpperCase());
      });
      const changedHere = !sameList(merged, local);
      if (changedHere) LS.set('holdings', merged.map(fromItem));

      // 3. Save this browser's changes.
      for (let i = 0; i < toPush.length; i += 500) {
        await rpc('upsert_holdings', { items: toPush.slice(i, i + 500).map(toRow) });
      }

      // 4. Watchlist and settings: newest wins as a whole.
      const dataChanged = await syncUserData(s);

      const cursor = rows.reduce((m, r) => Math.max(m, Number(r.synced_at)), s.cursor ?? 0);
      const stillDirty = (syncState().dirty ?? []).filter((id) => !dirtyAtStart.has(id));
      setState({ cursor, synced: true, last: Date.now(), error: undefined, count: merged.filter((m) => !m.deleted).length, dirty: stillDirty });
      if (changedHere || dataChanged) invalidate('/api/');
    } catch (e) {
      setState({ error: (e as Error).message });
    }
  })().finally(() => { running = null; });
  return running;
}

type DataRow = { watchlist: unknown[]; settings: Record<string, unknown>; updated_at: number };

async function syncUserData(s: State): Promise<boolean> {
  const [row] = await rest<DataRow[]>('user_data?select=watchlist,settings,updated_at');
  const localWatch = LS.get<any[]>('watchlist', []);
  const localSettings = LS.get<Record<string, unknown>>('settings', {});
  const changedHere = (s.dataAt ?? 0) > (s.dataSyncedAt ?? 0);
  const now = Date.now();
  const save = (watchlist: unknown[], settings: Record<string, unknown>) =>
    rest('user_data', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ watchlist, settings, updated_at: now }) });

  if (!row) {
    if (localWatch.length || Object.keys(localSettings).length) await save(localWatch, localSettings);
    setState({ dataSyncedAt: now });
    return false;
  }
  if (!s.synced) {
    // First sync on this browser: keep both watchlists; the account's settings win unless it has none.
    const key = (w: any) => `${w.cardId}|${w.variant ?? ''}`;
    const union = [...(row.watchlist as any[])];
    for (const w of localWatch) if (!union.some((x) => key(x) === key(w))) union.push(w);
    const settings = Object.keys(row.settings ?? {}).length ? row.settings : localSettings;
    LS.set('watchlist', union);
    LS.set('settings', settings);
    if (union.length !== row.watchlist.length || settings !== row.settings) await save(union, settings);
    setState({ dataSyncedAt: now });
    return true;
  }
  if (changedHere) {
    await save(localWatch, localSettings);
    setState({ dataSyncedAt: now });
    return false;
  }
  if (Number(row.updated_at) > (s.dataSyncedAt ?? 0)) {
    LS.set('watchlist', row.watchlist ?? []);
    LS.set('settings', row.settings ?? {});
    setState({ dataSyncedAt: Number(row.updated_at) });
    return true;
  }
  return false;
}

/** Signing out removes this account's copy from the browser (it's safe in the account). */
export function forgetLocalData() {
  LS.del('holdings');
  LS.del('watchlist');
  setState(null);
  invalidate('/api/');
}

let soon: ReturnType<typeof setTimeout> | undefined;
/** After a local change: save shortly, batching quick edits. */
function syncSoon() {
  if (!accountsEnabled || !currentUser()) return;
  clearTimeout(soon);
  soon = setTimeout(() => { syncNow(); }, 1500);
}

let started = false;
/** Automatic: on load, on sign-in, when the tab comes back, every 30 s while it's open, and right after changes. */
export function startSync() {
  if (started || !accountsEnabled) return;
  started = true;
  const tick = () => {
    if (!currentUser() || document.visibilityState !== 'visible') return;
    if (Date.now() - (syncState().last ?? 0) > 10_000) syncNow();
  };
  tick();
  onAuth(() => { if (currentUser()) syncNow(); });
  addEventListener('focus', tick);
  addEventListener('online', tick);
  document.addEventListener('visibilitychange', tick);
  setInterval(tick, 30_000);
}
