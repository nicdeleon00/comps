// Merge rules for collection sync. The iPhone app (CollectionSync.swift) uses the same rules.
// No imports, so it can be unit-tested with Node directly.

export type SyncItem = {
  id: string;
  cardId: string;
  name: string;
  set?: string | null;
  number?: string | null;
  image?: string | null;
  variant?: string | null;
  grader?: string | null;
  grade?: string | null;
  condition: string;
  quantity: number;
  cost?: number | null;
  acquiredAt?: string | null;
  notes?: string | null;
  createdAt?: number;
  updatedAt: number;
  deleted?: boolean;
};
const KEEP_TOMBSTONES = 90 * 86_400_000;

export const keyOf = (i: SyncItem) => [i.cardId, i.variant ?? '', i.grader ?? '', i.grade ?? '', i.condition || 'NM'].join('|');

/**
 * Newest change wins per card. On a device's first sync, the same card that exists
 * on both sides under different ids (added on each before signing in) is kept once.
 */
export function merge(local: SyncItem[], remote: SyncItem[], opts: { firstSync: boolean; preferLocal: boolean; now?: number }): SyncItem[] {
  const now = opts.now ?? Date.now();
  const norm = (i: SyncItem) => ({ ...i, id: i.id.toLowerCase() });
  const L = local.map(norm), R = remote.map(norm);
  const byId = new Map<string, SyncItem>();
  for (const r of R) byId.set(r.id, r);
  for (const l of L) {
    const r = byId.get(l.id);
    if (!r || l.updatedAt > r.updatedAt || (l.updatedAt === r.updatedAt && l.deleted && !r.deleted)) byId.set(l.id, l);
  }
  if (opts.firstSync) {
    const localIds = new Set(L.map((i) => i.id)), remoteIds = new Set(R.map((i) => i.id));
    const live = [...byId.values()].filter((i) => !i.deleted);
    const pool = new Map<string, SyncItem[]>();
    for (const r of live.filter((i) => remoteIds.has(i.id) && !localIds.has(i.id))) {
      const k = keyOf(r);
      pool.set(k, [...(pool.get(k) ?? []), r]);
    }
    for (const l of live.filter((i) => localIds.has(i.id) && !remoteIds.has(i.id))) {
      const twin = pool.get(keyOf(l))?.shift();
      if (!twin) continue;
      const drop = opts.preferLocal ? twin : l;
      byId.set(drop.id, { ...drop, deleted: true, updatedAt: now });
    }
  }
  return [...byId.values()].filter((i) => !i.deleted || now - i.updatedAt < KEEP_TOMBSTONES);
}

/** True when the gist needs the merged list written back. */
export function differs(merged: SyncItem[], remote: SyncItem[]) {
  if (merged.length !== remote.length) return true;
  const r = new Map(remote.map((i) => [i.id.toLowerCase(), i]));
  return merged.some((m) => {
    const x = r.get(m.id);
    return !x || x.updatedAt !== m.updatedAt || Boolean(x.deleted) !== Boolean(m.deleted);
  });
}
