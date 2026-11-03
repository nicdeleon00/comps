import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merge, differs } from '../../web/src/lib/syncMerge.ts';

const item = (id, cardId, updatedAt, extra = {}) => ({ id, cardId, name: cardId, condition: 'NM', quantity: 1, updatedAt, ...extra });
const now = 1_800_000_000_000;

test('sync: newest change wins per card, both directions', () => {
  const local = [item('a', 'tcg:1', 200, { quantity: 3 }), item('b', 'tcg:2', 100)];
  const remote = [item('a', 'tcg:1', 100), item('b', 'tcg:2', 300, { quantity: 5 }), item('c', 'tcg:3', 150)];
  const m = merge(local, remote, { firstSync: false, preferLocal: true, now });
  const by = Object.fromEntries(m.map((i) => [i.id, i]));
  assert.equal(by.a.quantity, 3, 'local edit is newer');
  assert.equal(by.b.quantity, 5, 'remote edit is newer');
  assert.ok(by.c, 'card added elsewhere arrives');
  assert.ok(differs(m, remote), 'remote needs the local edit');
  assert.ok(!differs(m, m.map((i) => ({ ...i }))));
});

test('sync: deletions travel as tombstones and expire after 90 days', () => {
  const local = [item('a', 'tcg:1', now - 500, { deleted: true })];
  const remote = [item('a', 'tcg:1', now - 900), item('old', 'tcg:9', now - 100 * 86_400_000, { deleted: true })];
  const m = merge(local, remote, { firstSync: false, preferLocal: true, now });
  assert.equal(m.find((i) => i.id === 'a').deleted, true);
  assert.ok(!m.find((i) => i.id === 'old'), 'old tombstone dropped');
});

test('sync: ids match regardless of case (iOS uppercases UUIDs)', () => {
  const m = merge([item('ABC-1', 'tcg:1', 100)], [item('abc-1', 'tcg:1', 200, { quantity: 2 })], { firstSync: false, preferLocal: true, now });
  assert.equal(m.length, 1);
  assert.equal(m[0].quantity, 2);
});

test('sync: first sync keeps one copy of cards that exist on both sides under different ids', () => {
  // The browser imported the phone's CSV earlier, so the same cards exist under new ids.
  const phone = [item('p1', 'tcg:1', 100), item('p2', 'tcg:2', 100), item('p3', 'tcg:2', 100)];
  const browser = [item('w1', 'tcg:1', 120), item('w2', 'tcg:2', 120), item('w4', 'tcg:4', 120)];
  // Browser connects first: its copies go up as-is.
  const fromBrowser = merge(browser, [], { firstSync: true, preferLocal: false, now });
  // Phone connects next and prefers its own copies.
  const m = merge(phone, fromBrowser, { firstSync: true, preferLocal: true, now });
  const live = m.filter((i) => !i.deleted).map((i) => i.id).sort();
  assert.deepEqual(live, ['p1', 'p2', 'p3', 'w4'], 'one copy per card; two real copies of tcg:2 both kept; browser-only card kept');
  // Back on the browser, the duplicates it held are now deleted.
  const back = merge(fromBrowser, m, { firstSync: false, preferLocal: false, now });
  assert.deepEqual(back.filter((i) => !i.deleted).map((i) => i.id).sort(), ['p1', 'p2', 'p3', 'w4']);
});
