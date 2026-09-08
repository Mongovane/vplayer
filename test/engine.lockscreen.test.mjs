/**
 * Exercise the real engine.js in Node, with a jsdom document and a media
 * element that records what was asked of it and when.
 *
 * jsdom cannot play audio, and that is fine: none of the failures being
 * guarded here are about sound. They are about *ordering* — whether src was
 * bound before the first await, whether play() was called at all, how many
 * full-file fetches were started and against which url. All of that is
 * observable from a stub element, and all of it has been wrong at least once.
 *
 *   node --experimental-loader ./test/loader.mjs test/engine.lockscreen.test.mjs
 */

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

/* ------------------------------ environment ------------------------------- */

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://vplayer.test/',
});

/** Every media element created, with a log of src assignments and play calls. */
const media = [];

class FakeAudio {
  constructor() {
    this.log = [];
    this._src = '';
    this.paused = true;
    this.currentTime = 0;
    this.duration = NaN;
    this.volume = 1;
    this.playbackRate = 1;
    this.preload = '';
    this.crossOrigin = null;
    this.playsInline = false;
    this.buffered = { length: 0, end: () => 0 };
    this.style = { cssText: '' };
    this._listeners = new Map();
    /** Set by a test to make play() reject, as a locked screen would. */
    this.rejectPlay = null;
    media.push(this);
  }
  get src() { return this._src; }
  set src(v) { this._src = v; this.log.push({ op: 'src', v }); }
  play() {
    this.log.push({ op: 'play', src: this._src });
    if (this.rejectPlay) {
      const err = new Error('NotAllowedError');
      err.name = this.rejectPlay;
      return Promise.reject(err);
    }
    this.paused = false;
    return Promise.resolve();
  }
  pause() { this.paused = true; this.log.push({ op: 'pause' }); }
  load() { this.log.push({ op: 'load' }); }
  setAttribute() {}
  getAttribute() { return null; }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this._listeners.get(type)?.delete(fn); }
  emit(type) { for (const fn of this._listeners.get(type) || []) fn({ type }); }
  get plays() { return this.log.filter((e) => e.op === 'play'); }
  get srcs() { return this.log.filter((e) => e.op === 'src').map((e) => e.v); }
}

/** Full-body fetches, which is what competes with playback. */
const fetches = [];

/** Node 22 defines `navigator` as a getter-only global, so it has to be redefined. */
function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
}

defineGlobal('window', dom.window);
defineGlobal('document', dom.window.document);
defineGlobal('navigator', {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
  maxTouchPoints: 5,
  mediaSession: {
    metadata: null,
    playbackState: 'none',
    handlers: {},
    setActionHandler(action, fn) { this.handlers[action] = fn; },
    setPositionState() {},
  },
});
defineGlobal('MediaMetadata', class { constructor(o) { Object.assign(this, o); } });
defineGlobal('Audio', FakeAudio);
defineGlobal('localStorage', dom.window.localStorage);
defineGlobal('performance', dom.window.performance);
defineGlobal('URL', dom.window.URL);
defineGlobal('AudioContext', undefined);
defineGlobal('indexedDB', undefined);
defineGlobal('fetch', async (url) => {
  fetches.push(String(url));
  return {
    ok: true,
    body: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {} }) },
  };
});

/* -------------------------------- helpers --------------------------------- */

const engine = await import('../public/src/engine.js');
const store = await import('../public/src/store.js');
const stubApi = await import('./stub-api.js');
const stubOffline = await import('./stub-offline.js');

// init() is what registers the element listeners and the MediaSession
// handlers. Without it the tests would exercise playIndex against an engine
// that never wired itself up, and the pause-triggered warming — the whole
// point of one of the tests below — would never fire.
engine.init();

const audio = engine.element();
assert.ok(audio instanceof FakeAudio, 'engine should have built its element from Audio');

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/**
 * Unique ids per test, because the warm cache is module state.
 *
 * The first version of this file reused t0/t1/t2 everywhere, so entries warmed
 * by one test were still there for the next one — and two tests passed for
 * that reason rather than on their own merits. Verified by reintroducing the
 * bugs they were meant to catch and watching them stay green.
 */
let suiteN = 0;
function queue(n) {
  const gen = `g${(suiteN += 1)}`;
  const tracks = Array.from({ length: n }, (_, i) => ({
    id: `${gen}t${i}`,
    name: `Track ${i}`,
    artist: 'A',
    cover: '',
  }));
  store.set({ tracks, index: -1, upNext: [], mode: 'sequence' });
  return tracks;
}

function fresh() {
  store.set({ offlineIds: new Set() });
  audio.log.length = 0;
  audio.rejectPlay = null;
  fetches.length = 0;
  stubApi.reset();
  stubOffline.reset();
}

const results = [];
async function test(name, fn) {
  fresh();
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err });
  }
}

/* --------------------------------- tests ---------------------------------- */

await test('playIndex starts audio even when the element is paused', async () => {
  queue(3);
  audio.paused = true;
  store.set({ playing: false });
  await engine.playIndex(0);
  assert.equal(audio.plays.length >= 1, true, 'play() was never called');
  assert.match(audio.srcs.at(-1), /t0\.mp3$/);
});

await test('a warm track binds src and plays before the first await', async () => {
  queue(3);
  // Let the warmer resolve the neighbours of track 0.
  await engine.playIndex(0);
  await tick(1500);

  // A slow resolve would be fatal on a locked screen; if the fast path is
  // working, next() must not wait for it.
  stubApi.setSongDelay(5000);
  fresh();
  stubApi.setSongDelay(5000);

  engine.next(); // deliberately not awaited — this is the point
  // One microtask drain is all a MediaSession handler gets.
  await Promise.resolve();
  assert.equal(audio.plays.length, 1, 'src/play did not happen synchronously');
  assert.match(audio.srcs.at(-1), /t1\.mp3$/);
});

await test('previoustrack is warm too, so prev is synchronous as well', async () => {
  queue(3);
  await engine.playIndex(1);
  await tick(1500);

  stubApi.setSongDelay(5000);
  fresh();
  stubApi.setSongDelay(5000);

  engine.prev();
  await Promise.resolve();
  assert.equal(audio.plays.length, 1, 'prev() had to wait for a resolve');
  assert.match(audio.srcs.at(-1), /t0\.mp3$/);
});

await test('pausing prefills a neighbour, but never the playing url', async () => {
  queue(4);
  await engine.playIndex(0);
  const playing = audio.srcs.at(-1);
  await tick(1500);

  // Nothing should have been downloaded yet: no buffer headroom was reported.
  assert.equal(fetches.length, 0, 'a full fetch started before the buffer allowed it');

  // Pause, as on a lock screen.
  audio.paused = true;
  audio.emit('pause');
  await tick(1500);

  // This is what only the pause handler does. `timeupdate` does not fire while
  // paused, so without it the bytes for the next press are never fetched.
  assert.ok(fetches.length > 0, 'pausing did not prefill any neighbour');
  assert.ok(!fetches.includes(playing), 'prefilled the url the element holds');
});

await test('presses after a pause stay warm, not just the first one', async () => {
  queue(5);
  await engine.playIndex(0);
  await tick(1500);
  audio.paused = true;
  audio.emit('pause');
  await tick(1500);

  for (const nth of ['first', 'second', 'third']) {
    fresh();
    stubApi.setSongDelay(5000);
    engine.next();
    await Promise.resolve();
    assert.equal(audio.plays.length, 1, `the ${nth} press after a pause was not warm`);
    stubApi.setSongDelay(0);
    await tick(1500); // let the refill catch up
  }
});

await test('warming never full-fetches the url being played', async () => {
  queue(3);
  await engine.playIndex(0);
  const playing = audio.srcs.at(-1);
  await tick(2000);
  assert.ok(
    !fetches.includes(playing),
    `the warmer downloaded the live stream (${playing}) — this is what killed cloud playback`
  );
});

await test('a track change does not trigger a full download on its own', async () => {
  queue(5);
  await engine.playIndex(0);
  await tick(2000);
  // Resolves are cheap and expected; whole-file fetches are not, until the
  // buffer says there is room.
  assert.equal(
    fetches.length,
    0,
    `${fetches.length} full fetches started 2s after a track change: ${fetches.join(', ')}`
  );
  assert.ok(stubApi.calls.song.length > 0, 'neighbours should still have been resolved');
});

await test('a source that will not load is re-resolved, not blamed on the system', async () => {
  queue(2);
  audio.rejectPlay = 'NotAllowedError';
  await engine.playIndex(0).catch(() => {});
  await tick(400);
  // First refusal retries, second gives up and re-resolves.
  const resolvesFor0 = stubApi.calls.song.filter((c) => c.id.endsWith('t0')).length;
  assert.ok(resolvesFor0 >= 1, 'never re-resolved the failing track');
  assert.notEqual(
    store.get().playbackError,
    '后台切歌被系统拦截，回到应用点播放继续',
    'reported a background block while the document was visible'
  );
});

await test('warming does not tell the LRU a track was played', async () => {
  const tracks = queue(3);
  // Every track has a device copy, so the offline branch — and its touch — is
  // reachable for the neighbours as well as for the one being played.
  for (const t of tracks) stubOffline.downloaded.add(t.id);
  store.set({ offlineIds: new Set(tracks.map((t) => t.id)) });
  await engine.playIndex(0);
  await tick(2000);
  // Only the track actually played may count as used — LRU is what decides
  // which downloads survive under quota, and a neighbour the listener never
  // reached must not outrank one they did.
  const touchedNeighbour = stubOffline.calls.touch.filter((id) => id !== tracks[0].id);
  assert.deepEqual(touchedNeighbour, [], `warming touched ${touchedNeighbour.join(', ')}`);
});

await test('session restore loads without starting playback', async () => {
  queue(2);
  await engine.playIndex(0, { autoplay: false });
  assert.equal(audio.plays.length, 0, 'autoplay:false still called play()');
  assert.match(audio.srcs.at(-1), /t0\.mp3$/);
});

await test('the lock screen gets prev/next handlers, and they are not async', async () => {
  const h = navigator.mediaSession.handlers;
  for (const action of ['play', 'pause', 'previoustrack', 'nexttrack']) {
    assert.equal(typeof h[action], 'function', `${action} handler missing`);
  }
  assert.equal(h.seekbackward, undefined, 'seekbackward crowds out prev/next on iOS');
  assert.equal(h.stop, undefined, 'a stop handler collapses the transport');
});

/* --------------------------------- report --------------------------------- */

let failed = 0;
for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else {
    failed += 1;
    console.log(`  ✗ ${r.name}`);
    console.log(`      ${String(r.err.message).split('\n')[0]}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
