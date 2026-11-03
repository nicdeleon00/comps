// Collection sync between this browser and the iPhone app, through a secret
// gist on the owner's GitHub account. Both sides keep a full copy; each sync
// pulls the gist, merges (newest change wins per card, deletions are kept as
// tombstones for 90 days) and pushes back only when something changed.

import { invalidate } from './api';
import { merge, differs, type SyncItem } from './syncMerge';

export type { SyncItem };

type SyncFile = { v: 1; updatedAt: number; items: SyncItem[] };
type State = { token?: string; gist?: string; last?: number; synced?: boolean; error?: string; count?: number };

export const SYNC_FILE = 'comps-collection.json';
const API = 'https://api.github.com';
export const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=gist&description=Comps%20collection%20sync';

// ---------------------------------------------------------------- state
const STATE_KEY = 'comps.sync';
const listeners = new Set<() => void>();

export function syncState(): State {
  try { return JSON.parse(localStorage.getItem(STATE_KEY) ?? '{}') as State; } catch { return {}; }
}
function setState(patch: Partial<State>) {
  const next = { ...syncState(), ...patch };
  try { localStorage.setItem(STATE_KEY, JSON.stringify(next)); } catch {}
  listeners.forEach((l) => l());
}
export function onSync(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
export const isConnected = () => Boolean(syncState().token && syncState().gist);
export const pairLink = (s: State = syncState()) => `comps://sync?token=${encodeURIComponent(s.token ?? '')}&gist=${encodeURIComponent(s.gist ?? '')}`;

// ---------------------------------------------------------------- this browser's collection (same storage as static.ts)
type Local = {
  id: string; cardId: string; game: string; name: string; setName: string | null; number: string | null; image: string | null;
  variant: string | null; grader: string | null; grade: string | null; condition: string; quantity: number; costBasis: number | null;
  acquiredAt: string | null; notes: string | null; createdAt: number; updatedAt: number; deleted?: boolean;
};
const readLocal = (): Local[] => { try { return JSON.parse(localStorage.getItem('comps.holdings') ?? '[]'); } catch { return []; } };
const writeLocal = (list: Local[]) => { try { localStorage.setItem('comps.holdings', JSON.stringify(list)); } catch {} };

const toItem = (h: Local): SyncItem => ({
  id: h.id, cardId: h.cardId, name: h.name, set: h.setName, number: h.number, image: h.image, variant: h.variant, grader: h.grader, grade: h.grade,
  condition: h.condition || 'NM', quantity: h.quantity, cost: h.costBasis, acquiredAt: h.acquiredAt, notes: h.notes, createdAt: h.createdAt,
  updatedAt: h.updatedAt, ...(h.deleted ? { deleted: true } : {}),
});
const fromItem = (i: SyncItem): Local => ({
  id: i.id, cardId: i.cardId, game: 'pokemon', name: i.name, setName: i.set ?? null, number: i.number ?? null, image: i.image ?? null,
  variant: i.variant ?? null, grader: i.grader ?? null, grade: i.grade ?? null, condition: i.condition || 'NM', quantity: i.quantity || 1,
  costBasis: i.cost ?? null, acquiredAt: i.acquiredAt ?? null, notes: i.notes ?? null, createdAt: i.createdAt ?? i.updatedAt, updatedAt: i.updatedAt,
  ...(i.deleted ? { deleted: true } : {}),
});

// ---------------------------------------------------------------- GitHub
class SyncError extends Error {
  constructor(public kind: 'auth' | 'http' | 'network' | 'missing', message: string) { super(message); }
}

async function gh<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API + path, {
      ...init,
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  } catch {
    throw new SyncError('network', "Couldn't reach GitHub");
  }
  if (res.status === 401) throw new SyncError('auth', 'The GitHub key was revoked or expired. Connect again with a new key.');
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') throw new SyncError('http', 'GitHub rate limit reached; trying again shortly.');
  if (res.status === 403) throw new SyncError('auth', 'The GitHub key needs the “gist” permission.');
  if (res.status === 404) throw new SyncError('missing', 'Not found');
  if (!res.ok) throw new SyncError('http', `GitHub answered ${res.status}`);
  return res.json() as Promise<T>;
}

type Gist = { id: string; files: Record<string, { content?: string; truncated?: boolean; raw_url?: string }> };

const emptyFile = (): SyncFile => ({ v: 1, updatedAt: Date.now(), items: [] });

async function findOrCreateGist(token: string): Promise<string> {
  for (let page = 1; page <= 5; page++) {
    const list = await gh<Gist[]>(token, `/gists?per_page=100&page=${page}`);
    const hit = list.find((g) => g.files && SYNC_FILE in g.files);
    if (hit) return hit.id;
    if (list.length < 100) break;
  }
  const created = await gh<Gist>(token, '/gists', {
    method: 'POST',
    body: JSON.stringify({ description: 'Comps collection — synced by the Comps app and website', public: false, files: { [SYNC_FILE]: { content: JSON.stringify(emptyFile()) } } }),
  });
  return created.id;
}

async function readGist(token: string, id: string): Promise<SyncFile> {
  const g = await gh<Gist>(token, `/gists/${id}`);
  const f = g.files[SYNC_FILE];
  if (!f) return emptyFile();
  let text = f.content ?? '';
  if (f.truncated && f.raw_url) text = await (await fetch(f.raw_url, { cache: 'no-store' })).text();
  try {
    const parsed = JSON.parse(text) as SyncFile;
    return { v: 1, updatedAt: parsed.updatedAt ?? 0, items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch {
    return emptyFile();
  }
}

async function writeGist(token: string, id: string, items: SyncItem[]) {
  const file: SyncFile = { v: 1, updatedAt: Date.now(), items };
  await gh(token, `/gists/${id}`, { method: 'PATCH', body: JSON.stringify({ files: { [SYNC_FILE]: { content: JSON.stringify(file) } } }) });
}

// ---------------------------------------------------------------- public API
let running: Promise<void> | null = null;

/** Connects with a GitHub key that has the gist permission. Finds or creates the sync gist, then syncs. */
export async function connect(token: string, gist?: string) {
  const t = token.trim();
  let id: string;
  try {
    id = gist || (await findOrCreateGist(t));
  } catch (e) {
    throw new Error(e instanceof SyncError && e.kind === 'missing' ? 'That key can’t use gists. Create it with the “gist” box ticked.' : (e as Error).message);
  }
  setState({ token: t, gist: id, synced: false, error: undefined });
  await syncNow();
  const s = syncState();
  if (s.error) throw new Error(s.error);
}

export function disconnect() {
  try { localStorage.removeItem(STATE_KEY); } catch {}
  listeners.forEach((l) => l());
}

export function syncNow(): Promise<void> {
  if (running) return running;
  running = (async () => {
    let s = syncState();
    if (!s.token || !s.gist) return;
    try {
      let remote: SyncFile;
      try {
        remote = await readGist(s.token, s.gist);
      } catch (e) {
        // The gist was deleted on GitHub: start a new one from this browser's copy.
        if (!(e instanceof SyncError) || e.kind !== 'missing') throw e;
        setState({ gist: await findOrCreateGist(s.token) });
        s = syncState();
        remote = await readGist(s.token!, s.gist!);
      }
      const localRaw = readLocal();
      const merged = merge(localRaw.map(toItem), remote.items, { firstSync: !s.synced, preferLocal: false });
      const next = merged.map(fromItem);
      const changedHere = differs(merged, localRaw.map(toItem));
      if (changedHere) writeLocal(next);
      if (differs(merged, remote.items)) await writeGist(s.token!, s.gist!, merged);
      setState({ last: Date.now(), synced: true, error: undefined, count: merged.filter((i) => !i.deleted).length });
      if (changedHere) invalidate('/api/');
    } catch (e) {
      setState({ error: (e as Error).message });
    }
  })().finally(() => { running = null; });
  return running;
}

let soon: ReturnType<typeof setTimeout> | undefined;
/** After a local change: push shortly, batching quick edits. */
export function syncSoon() {
  if (!isConnected()) return;
  clearTimeout(soon);
  soon = setTimeout(() => { syncNow(); }, 1500);
}

let started = false;
/** Syncs on load, when the tab comes back, and every minute while it's visible. */
export function startSync() {
  if (started) return;
  started = true;
  const tick = () => {
    if (!isConnected() || document.visibilityState !== 'visible') return;
    const last = syncState().last ?? 0;
    if (Date.now() - last > 20_000) syncNow();
  };
  tick();
  addEventListener('focus', tick);
  document.addEventListener('visibilitychange', tick);
  setInterval(tick, 60_000);
}
