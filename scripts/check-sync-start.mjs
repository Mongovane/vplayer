/**
 * Guard the one invariant the iOS lock screen depends on.
 *
 * A MediaSession action handler carries the user-gesture authorisation that
 * lets a backgrounded page start audio. That authorisation does not survive
 * being handed back to the event loop, so on the warm path playIndex must
 * reach `audio.play()` without awaiting anything first.
 *
 * This cannot be tested at runtime here: the behaviour only exists on a real
 * locked iOS screen, and every substitute — jsdom, a desktop browser, a
 * foreground tab — starts audio happily either way. So the invariant is
 * checked where it actually lives, in the order of the statements.
 *
 * It has regressed once already. `const wasPlaying = !audio.paused ||
 * s.playing` looked like a safety check and was in fact the bug: after a pause
 * on a locked screen both halves are false, so prev/next loaded the track and
 * declined to start it, and the retry that covers a refused background start
 * was gated on the same expression.
 *
 *   node scripts/check-sync-start.mjs
 */

import { readFile } from 'node:fs/promises';

const FILE = 'public/src/engine.js';
const raw = await readFile(FILE, 'utf8');

/**
 * Blank out comments, keeping every byte position.
 *
 * Ordering checks compare offsets, so nothing may shift. And they have to run
 * on stripped source: the prose explaining *why* there must be no await before
 * play() contains the word "await", and the first version of this script
 * dutifully flagged its own explanation.
 */
function stripComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === '//') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (two === '/*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

const src = stripComments(raw);

const problems = [];

/** The `{ ... }` block starting at or after `from`, by brace matching. */
function blockAt(from) {
  const open = src.indexOf('{', from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * Body of a function, skipping its parameter list.
 *
 * Brace-matching from the declaration is not enough: a destructured parameter
 * like `({ autoplay = true } = {})` opens a brace before the body does, and
 * matching that one returns the parameter object as the "body" — which reports
 * that playIndex never calls play(), a false alarm that would train someone to
 * ignore this script. Walk the parens first, then take the block.
 */
function bodyOf(decl) {
  const head = src.indexOf(decl);
  if (head < 0) return null;
  const paren = src.indexOf('(', head);
  if (paren < 0) return null;
  let depth = 0;
  for (let i = paren; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) return blockAt(i);
    }
  }
  return null;
}

/** Body of an `audio.addEventListener('name', ...)` callback. */
function listenerOf(name) {
  const at = src.indexOf(`audio.addEventListener('${name}'`);
  return at < 0 ? null : blockAt(at);
}

/* 1. playIndex must start audio before its first await. ------------------- */

const playIndex = bodyOf('export async function playIndex');
if (!playIndex) {
  problems.push('playIndex not found — this check needs updating');
} else {
  const firstPlay = playIndex.indexOf('audio.play()');
  const firstAwait = playIndex.search(/\bawait\b/);
  if (firstPlay < 0) {
    problems.push('playIndex never calls audio.play()');
  } else if (firstAwait >= 0 && firstAwait < firstPlay) {
    problems.push(
      'playIndex awaits before its first audio.play().\n' +
        '  A locked iOS screen will advance the track and make no sound.\n' +
        '  The warm-cache lookup and the src assignment must both come first.'
    );
  }
}

/* 2. Starting audio must not be conditional on the element's current state. */

if (playIndex && /!audio\.paused\s*\|\|/.test(playIndex)) {
  problems.push(
    'playIndex derives play-intent from `!audio.paused`.\n' +
      '  That is false after a pause, which is exactly when prev/next need to\n' +
      '  start audio. Intent belongs in the `autoplay` argument.'
  );
}

/* 3. The MediaSession handlers must stay synchronous. --------------------- */

const bindSession = bodyOf('function bindSession');
if (!bindSession) {
  problems.push('bindSession not found — this check needs updating');
} else {
  for (const action of ['play', 'previoustrack', 'nexttrack']) {
    const m = bindSession.match(new RegExp(`${action}:\\s*(async\\s*)?\\(`));
    if (!m) {
      problems.push(`bindSession has no ${action} handler`);
    } else if (m[1]) {
      problems.push(
        `the ${action} handler is async.\n` +
          '  An async handler yields before it does anything, which forfeits the\n' +
          '  gesture that permits background audio.'
      );
    }
  }
  if (/setActionHandler/.test(bindSession) === false) {
    problems.push('bindSession registers no handlers');
  }
}

/* 4. Warming must be reachable while paused. ------------------------------ */

const onPause = listenerOf('pause');
if (!onPause) {
  problems.push("no audio 'pause' listener found — this check needs updating");
} else if (!/scheduleWarm|warmNeighbours/.test(onPause)) {
  problems.push(
    'the pause handler does not re-warm.\n' +
      '  timeupdate does not fire while paused, so without this the cache empties\n' +
      '  after one press and every press after it has to reach the network.'
  );
}

/* 5. Bulk-edit damage. ---------------------------------------------------- */

/**
 * A statement absorbed into a braceless `if` on the line above it.
 *
 * This is what a regex-driven bulk edit leaves behind, and it has happened:
 * removing `log(...)` from `if (keepAlive) log('...');` left a dangling `if`
 * that swallowed the next line, so `store.set({ playing: false })` only ran
 * while the session was held — the audio paused and the button never changed.
 *
 * Semantically valid JavaScript, so eslint, `node --check` and every test at
 * the time all passed. The fingerprint is the run of spaces where the deleted
 * call used to sit, which no hand-written line has.
 */
for (const [i, line] of raw.split('\n').entries()) {
  if (/\b(if|for|while)\s*\([^)]*\)[ \t]{2,}\S/.test(line)) {
    problems.push(
      `line ${i + 1} looks like a bulk edit swallowed a statement:\n` +
        `    ${line.trim()}\n` +
        `  A braceless control statement with a gap before its body is the shape\n` +
        `  left when a call was deleted from between them.`
    );
  }
}

/* 6. Warming must retain the bytes, not just fill the HTTP cache. --------- */

const warmBlob = bodyOf('async function warmBlob');
if (!warmBlob) {
  problems.push('warmBlob not found — this check needs updating');
} else if (!/createObjectURL/.test(warmBlob)) {
  problems.push(
    'warmBlob does not create an object url.\n' +
      '  A media element on iOS does not load through the Fetch API cache, so\n' +
      '  draining a response and discarding it warms nothing. The bytes have to\n' +
      '  be kept as a blob — that is the only source a locked screen will bind.'
  );
}

if (playIndex && !/blob:/.test(playIndex)) {
  problems.push(
    'playIndex never prefers a blob: url.\n' +
      '  A warm entry can hold one, and on a locked screen it is the only url\n' +
      '  the element will accept.'
  );
}

/* ------------------------------------------------------------------------ */

if (problems.length) {
  console.error(`\n${FILE} — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  process.exit(1);
}

console.log(`${FILE} — synchronous-start invariant holds`);
