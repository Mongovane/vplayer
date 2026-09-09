/**
 * Every store key the client reads has to exist in store.js.
 *
 * Written after `s.playlist` shipped. There is no `playlist` key — the queue is
 * `tracks` — but `playlistName` and `playlistId` are real, which is exactly why
 * the wrong one read as correct in review. In production the spread threw "not
 * iterable" on every favourites change, so the automatic-offline sweep never
 * ran once, and the only trace was a console line inside a listener that
 * store.js catches on purpose.
 *
 * eslint cannot help here: `s.playlist` is a valid property access on a valid
 * object. This is the same kind of check as check-dom-contract.mjs — an id in
 * the HTML, a key in the store, both invisible to a linter and both load-
 * bearing.
 *
 *   node scripts/check-store-contract.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'public/src';
const STORE = join(SRC, 'store.js');

const store = readFileSync(STORE, 'utf8');

/**
 * The keys of the exported state object.
 *
 * Read from the `const state = { ... }` literal by taking every line whose
 * first token is `identifier:` at one level of indentation. Crude on purpose:
 * a real parse would need a JS parser as a dependency, and the file is
 * hand-written in a consistent style that a regex handles honestly. If it ever
 * stops being handled honestly, this check fails loudly rather than passing
 * vacuously — see the sanity floor below.
 */
function storeKeys(text) {
  const start = text.search(/^const state = \{$/m);
  if (start === -1) throw new Error('store.js: could not find `const state = {`');
  const rest = text.slice(start);
  const end = rest.search(/^\};$/m);
  if (end === -1) throw new Error('store.js: could not find the end of `state`');
  const body = rest.slice(0, end);

  const keys = new Set();
  for (const line of body.split('\n')) {
    const m = /^ {2}([A-Za-z_$][\w$]*):/.exec(line);
    if (m) keys.add(m[1]);
  }
  return keys;
}

const keys = storeKeys(store);

// A floor, so a refactor that breaks the extraction cannot make this check pass
// by finding nothing to check against.
if (keys.size < 20) {
  console.error(`store.js — only found ${keys.size} state keys; the extraction is broken`);
  process.exit(1);
}

/**
 * Drop comments before scanning.
 *
 * Not cosmetic: the first run of this check reported `s.playlist` and
 * `store.get().member`, and both were comments *explaining* those exact
 * mistakes. A checker that flags the note describing a bug is a checker people
 * turn off.
 *
 * The `[^:]` guard on line comments is there to keep `https://` in a string
 * from eating the rest of the line. Comments inside string literals would
 * still confuse this; nothing in this codebase has one, and the sanity floor
 * below catches the case where stripping goes wrong badly enough to matter.
 */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * Reads of the form `store.get().foo` and `<local>.foo` where the local came
 * from `store.get()`.
 *
 * The second form is the one that matters — `const s = store.get()` then
 * `s.playlist` is how the bug got in — so any local assigned from store.get()
 * is tracked per file.
 */
function readsIn(source) {
  const text = stripComments(source);
  const hits = [];

  for (const m of text.matchAll(/store\.get\(\)\.([A-Za-z_$][\w$]*)/g)) {
    hits.push({ key: m[1], via: 'store.get().' });
  }

  const locals = new Set();
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*store\.get\(\)\s*;/g)) {
    locals.add(m[1]);
  }
  for (const name of locals) {
    const re = new RegExp(`\\b${name}\\.([A-Za-z_$][\\w$]*)`, 'g');
    for (const m of text.matchAll(re)) hits.push({ key: m[1], via: `${name}.` });
  }

  // store.on(['a', 'b']) subscribes to keys too, and a typo there is worse than
  // a throw: it fails silently forever.
  for (const m of text.matchAll(/store\.on\(\s*(\[[^\]]*\]|'[^']*')/g)) {
    for (const k of m[1].matchAll(/'([^']+)'/g)) hits.push({ key: k[1], via: 'store.on' });
  }

  return hits;
}

/** Methods and helpers on the store module, not state keys. */
const NOT_STATE = new Set([
  'get', 'set', 'on', 'nextIndex', 'reset', 'toggleFavorite', 'isFavorite',
  'length', 'map', 'filter', 'forEach', 'find', 'slice', 'push', 'has', 'size',
  'id', 'name', 'artist', 'album', 'cover', 'url', 'level', 'source',
]);

const problems = [];
let checked = 0;

for (const file of readdirSync(SRC).filter((f) => f.endsWith('.js'))) {
  if (file === 'store.js') continue;
  const text = readFileSync(join(SRC, file), 'utf8');
  for (const { key, via } of readsIn(text)) {
    if (NOT_STATE.has(key)) continue;
    checked += 1;
    if (!keys.has(key)) problems.push(`${SRC}/${file} — ${via}${key} is not a store key`);
  }
}

if (problems.length) {
  console.error(`store contract broken (${problems.length}):\n`);
  for (const p of [...new Set(problems)]) console.error(`  ${p}`);
  console.error(`\nkeys store.js actually has:\n  ${[...keys].sort().join(', ')}`);
  process.exit(1);
}

console.log(
  `public/src — store contract holds (${keys.size} keys, ${checked} reads across the client)`
);
