import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessions, byDay, dayTitle, GAP_MS } from '../../web/src/lib/history.ts';

const h = (id, createdAt, quantity = 1, total = 1) => ({ id, createdAt, quantity, total });
const T = new Date(2026, 10, 8, 15, 0, 0).getTime();

test('one Add to Collection is one session, in the order the cards were added', () => {
  const list = [h('c', T + 40), h('a', T), h('b', T + 20)];
  const s = sessions(list);
  assert.equal(s.length, 1);
  assert.deepEqual(s[0].items.map((x) => x.id), ['a', 'b', 'c']);
  assert.equal(s[0].start, T);
});

test('a pause longer than the gap starts a new session; newest first', () => {
  const s = sessions([h('a', T), h('b', T + 100), h('c', T + 100 + GAP_MS + 1), h('d', T + 3_600_000)]);
  assert.deepEqual(s.map((x) => x.items.map((i) => i.id)), [['d'], ['c'], ['a', 'b']]);
});

test('counts cards by quantity and adds up value', () => {
  const [s] = sessions([h('a', T, 3, 1.5), h('b', T + 1, 1, 2.25), h('c', T + 2, 2, null)]);
  assert.equal(s.cards, 6);
  assert.equal(s.value, 3.75);
});

test('sessions group by day, and days get friendly names', () => {
  const now = new Date(2026, 10, 8, 20, 0, 0).getTime();
  const yesterday = new Date(2026, 10, 7, 23, 30, 0).getTime();
  const days = byDay(sessions([h('a', T), h('b', T + 3_600_000), h('c', yesterday)]));
  assert.equal(days.length, 2);
  assert.equal(days[0].sessions.length, 2);
  assert.equal(dayTitle(days[0].day, now), 'Today');
  assert.equal(dayTitle(days[1].day, now), 'Yesterday');
  assert.notEqual(dayTitle(new Date(2026, 9, 1).getTime(), now), 'Yesterday');
});

test('empty in, empty out', () => {
  assert.deepEqual(sessions([]), []);
  assert.deepEqual(byDay([]), []);
});
