/**
 * Which copy gets dropped when the device runs out of room.
 *
 * Downloads and automatic copies share one ceiling — one number to understand,
 * one number to set — and that only works if the two are not interchangeable
 * when the ceiling is reached. The failure this guards against is concrete: an
 * album downloaded for a flight vanishing to make room for something heard once
 * on the way to work. A plain LRU pass does exactly that, because the album has
 * not been played in a week and the commute has.
 *
 *   node test/eviction.test.mjs
 */

import assert from 'node:assert/strict';

// The ordering is pure and exported for this reason: the rest of offline.js
// needs IndexedDB, which node does not have, and this is the part worth
// testing.
const { evictionOrder } = await import('../public/src/offline.js');

const DAY = 86_400_000;
const now = 1_700_000_000_000;

/** `pinned` left undefined on purpose in some rows — see the legacy case. */
const rec = (id, { pinned, played, saved } = {}) => ({
  id,
  pinned,
  lastPlayed: played === undefined ? undefined : now - played * DAY,
  savedAt: saved === undefined ? undefined : now - saved * DAY,
});

const order = (rows) => evictionOrder(rows).map((r) => r.id);

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err });
  }
}

test('an automatic copy goes before a download, however recently it was played', () => {
  const rows = [
    // The flight album: deliberate, untouched for a week.
    rec('album', { pinned: true, played: 7 }),
    // This morning's commute: automatic, played an hour ago.
    rec('commute', { pinned: false, played: 0 }),
  ];
  assert.deepEqual(order(rows), ['commute', 'album']);
});

test('within the automatic copies, least recently played goes first', () => {
  const rows = [
    rec('b', { pinned: false, played: 1 }),
    rec('c', { pinned: false, played: 30 }),
    rec('a', { pinned: false, played: 5 }),
  ];
  assert.deepEqual(order(rows), ['c', 'a', 'b']);
});

test('downloads still fall back to LRU among themselves', () => {
  // Once the automatic copies are gone the ceiling may still be exceeded, and
  // something deliberate has to go. Oldest use is the least bad choice.
  const rows = [
    rec('recent', { pinned: true, played: 1 }),
    rec('stale', { pinned: true, played: 90 }),
  ];
  assert.deepEqual(order(rows), ['stale', 'recent']);
});

test('a record from before auto-caching counts as deliberate', () => {
  // Existing devices have records with no `pinned` field at all. Treating a
  // missing flag as automatic would make the first tight-quota moment after
  // upgrading delete a library nobody agreed to lose.
  const rows = [
    rec('legacy', { played: 60 }), // pinned: undefined
    rec('cached', { pinned: false, played: 0 }),
  ];
  assert.deepEqual(order(rows), ['cached', 'legacy']);
});

test('never played falls back to when it was saved', () => {
  const rows = [
    rec('newer', { pinned: false, saved: 2 }),
    rec('older', { pinned: false, saved: 40 }),
  ];
  assert.deepEqual(order(rows), ['older', 'newer']);
});

test('a played copy outranks one that was only ever saved', () => {
  // savedAt stands in for lastPlayed, so the two have to be comparable rather
  // than sorted into separate buckets.
  const rows = [
    rec('saved-long-ago', { pinned: false, saved: 10 }),
    rec('played-today', { pinned: false, played: 0, saved: 10 }),
  ];
  assert.deepEqual(order(rows), ['saved-long-ago', 'played-today']);
});

test('the input array is left alone', () => {
  // evictTo iterates the result while deleting; a sort in place would be a
  // quiet way to corrupt a caller's list.
  const rows = [rec('b', { pinned: false, played: 1 }), rec('a', { pinned: false, played: 9 })];
  const before = rows.map((r) => r.id);
  evictionOrder(rows);
  assert.deepEqual(rows.map((r) => r.id), before);
});

test('an empty store produces an empty order', () => {
  assert.deepEqual(order([]), []);
});

let failed = 0;
for (const r of results) {
  if (r.ok) console.log(`  \u2713 ${r.name}`);
  else {
    failed += 1;
    console.log(`  \u2717 ${r.name}`);
    console.log(`      ${String(r.err.message).split('\n')[0]}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
