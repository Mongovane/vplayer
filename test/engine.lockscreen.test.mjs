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
    this.muted = false;
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

/** Blob object urls handed out, and which are still live. */
const blobs = { made: [], live: new Set() };
let fetchBytes = 1024;
class FakeBlob {
  constructor(size) { this.size = size; }
}
/**
 * Don't subclass jsdom's URL to add the object-url statics.
 *
 * `class extends dom.window.URL {}` sent jsdom's own IDL brand checks into
 * unbounded recursion the moment anything else touched a global — the failure
 * surfaced as a stack overflow inside Performance.now, nowhere near the cause.
 * A plain object with the two statics the engine actually calls is enough.
 */
let blobSeq = 0;
const FakeURL = {
  createObjectURL(b) {
    const u = `blob:vplayer/${(blobSeq += 1)}-${b.size}`;
    blobs.made.push(u);
    blobs.live.add(u);
    return u;
  },
  revokeObjectURL(u) { blobs.live.delete(u); },
};

/** Node 22 defines `navigator` as a getter-only global, so it has to be redefined. */
function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
}

defineGlobal('window', dom.window);
defineGlobal('document', dom.window.document);

/** jsdom's visibilityState is read-only, and the whole subject is being hidden. */
let visibility = 'visible';
Object.defineProperty(dom.window.document, 'visibilityState', {
  get: () => visibility,
  configurable: true,
});
const setVisible = (v) => {
  visibility = v;
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
};
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
// Deliberately NOT jsdom's performance. Its implementation calls the *global*
// performance.now() internally, so installing it as the global makes it call
// itself — an unbounded recursion that surfaced as a stack overflow with no
// application frames in the trace at all. Node's own performance is fine.
defineGlobal('URL', FakeURL);
defineGlobal('AudioContext', undefined);
defineGlobal('indexedDB', undefined);
defineGlobal('fetch', async (url) => {
  fetches.push(String(url));
  return {
    ok: true,
    headers: { get: (h) => (h === 'content-length' ? String(fetchBytes) : null) },
    body: { cancel: () => {}, getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {} }) },
    blob: async () => new FakeBlob(fetchBytes),
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
  // Go through the real transition rather than just setting the flag: coming
  // back into view is what restores a retired play control, and without it a
  // test that retires one leaves `handlers.pause` null for everything after —
  // which is exactly how three of these first failed.
  setVisible('visible');
  store.set({ offlineIds: new Set(), iosKeepAlive: true, iosRetirePlay: true });
  blobs.made.length = 0;
  fetchBytes = 1024;
  audio.log.length = 0;
  audio.rejectPlay = null;
  fetches.length = 0;
  stubApi.reset();
  stubOffline.reset();
}

/**
 * Report a fully buffered, playing track and drive timeupdate until a blob
 * appears, or give up.
 *
 * Not a single emit: warmNeighbours has a re-entrancy guard, and a warm pass
 * scheduled by the *previous* test's playIndex can still be in flight when the
 * next one starts — which made one test fail on its own precondition. Polling
 * removes that coupling without slowing every test down with a fixed wait.
 */
async function warmUntilBlob({ tries = 14 } = {}) {
  audio.duration = 200;
  audio.currentTime = 5;
  audio.buffered = { length: 1, end: () => 200 };
  // Drive it from the pause handler rather than timeupdate. timeupdate's byte
  // pass is throttled to once every five seconds and that clock is module
  // state, so a test that ran moments earlier silences the next one — which is
  // exactly how two of these failed on their own preconditions. The pause path
  // is unthrottled, and it is the scenario being fixed anyway.
  audio.paused = true;
  audio.emit('pause');
  for (let i = 0; i < tries; i += 1) {
    await tick(150);
    if (blobs.made.length) return true;
  }
  return false;
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

await test('a warmed neighbour ends up held as a blob, not just cached', async () => {
  queue(3);
  await engine.playIndex(0);
  assert.ok(
    await warmUntilBlob(),
    'nothing was retained — filling the HTTP cache does nothing for a media element on iOS'
  );
});

await test('a blob-warmed track is handed to the element as blob:', async () => {
  const tracks = queue(3);
  await engine.playIndex(0);
  assert.ok(await warmUntilBlob(), 'precondition: nothing was warmed');

  fresh();
  stubApi.setSongDelay(5000);
  engine.next();
  await Promise.resolve();
  const src = audio.srcs.at(-1);
  assert.ok(
    String(src).startsWith('blob:'),
    `element was given ${src} — a network url cannot be bound from a locked screen`
  );
  assert.notEqual(tracks.length, 0);
});

await test('an oversized track is skipped rather than held in memory', async () => {
  queue(3);
  fetchBytes = 200 * 1024 * 1024; // bigger than any sane warm
  await engine.playIndex(0);
  const got = await warmUntilBlob({ tries: 8 });
  assert.equal(got, false, 'a 200MB track was pulled into a blob');
  assert.ok(fetches.length > 0, 'precondition: the warmer never even tried');
});

await test('evicting a warm entry revokes its blob', async () => {
  queue(16);
  audio.duration = 200;
  audio.currentTime = 5;
  audio.buffered = { length: 1, end: () => 200 };

  // Walk the queue, forcing a blob per stop via the unthrottled pause path, so
  // there are comfortably more blobs than the map can hold.
  for (let i = 0; i < 12; i += 1) {
    await engine.playIndex(i);
    audio.paused = true;
    audio.emit('pause');
    await tick(220);
  }
  await tick(300);

  assert.ok(blobs.made.length > 3, `only ${blobs.made.length} blobs made — test is not exercising eviction`);
  const leaked = [...blobs.live];
  // At most WARM_BLOB_MAX entries may hold bytes at any moment. Anything beyond
  // that was either never capped or was evicted without being revoked — on iOS
  // that is retained file-backed storage that never comes back.
  assert.ok(
    leaked.length <= 3,
    `${blobs.made.length} blobs made, ${leaked.length} still live — cap or revoke is not working`
  );
});



/* ----------------------------- basic transport ----------------------------- */

await test('pausing updates the store, so the button changes', async () => {
  // Nothing asserted this, which is how a bulk edit could leave
  // `if (keepAlive) store.set({ playing: false })` in the pause listener and
  // still pass every test: the audio stopped, the icon did not change, and
  // pressing again resumed — so it read as "the button does nothing".
  queue(3);
  await engine.playIndex(0);
  audio.paused = false;
  store.set({ playing: true });

  await engine.toggle();
  assert.equal(audio.paused, true, 'toggle() did not pause the element');
  audio.emit('pause');
  assert.equal(store.get().playing, false, 'store.playing stayed true after a pause');
});

await test('resuming updates the store too', async () => {
  queue(3);
  await engine.playIndex(0);
  audio.paused = true;
  store.set({ playing: false });

  await engine.toggle();
  assert.equal(audio.paused, false, 'toggle() did not resume');
  audio.emit('play');
  audio.emit('playing');
  assert.equal(store.get().playing, true, 'store.playing stayed false after resuming');
});

await test('a foreground pause keeps the transport intact', async () => {
  queue(3);
  await engine.playIndex(0);
  audio.paused = false;
  await engine.toggle();
  audio.emit('pause');
  assert.equal(engine.playControlsAvailable(), true, 'retired the play control in the foreground');
  assert.equal(engine.holdingSession(), false, 'held a foreground pause');
});

/* ------------------------- lock-screen session hold ------------------------ */

/** Put the engine into "playing, out of view" — the state a lock screen is. */
async function playHidden(index = 0) {
  await engine.playIndex(index);
  audio.paused = false;
  audio.currentTime = 40;
  audio.duration = 200;
  audio.buffered = { length: 1, end: () => 200 };
  setVisible('hidden');
  await tick(20);
}

await test('a lock-screen pause is held, not taken', async () => {
  queue(4);
  await playHidden(1);
  navigator.mediaSession.handlers.pause();
  assert.equal(audio.paused, false, 'the element was stopped — this is what kills the session');
  assert.equal(audio.muted, true, 'held but not muted, so it is still audible');
  assert.equal(store.get().playing, false, 'the app should still consider itself paused');
  assert.equal(navigator.mediaSession.playbackState, 'paused');
});

await test('the playhead does not drift while held', async () => {
  queue(4);
  await playHidden(1);
  navigator.mediaSession.handlers.pause();
  // Time passes, as it does for a still-decoding element.
  audio.currentTime = 46;
  audio.emit('timeupdate');
  assert.ok(audio.currentTime <= 41, `playhead ran to ${audio.currentTime} — the track is playing on`);
});

await test('resuming from the lock screen just unmutes; no play() to refuse', async () => {
  queue(4);
  await playHidden(1);
  navigator.mediaSession.handlers.pause();
  audio.log.length = 0;
  audio.rejectPlay = 'NotAllowedError'; // any play() call here would fail
  navigator.mediaSession.handlers.play();
  assert.equal(audio.muted, false, 'still muted after resume');
  assert.equal(audio.plays.length, 0, 'called play() on an element that never stopped');
  assert.equal(store.get().playing, true);
});

await test('next while held unmutes before binding, so no silent head', async () => {
  queue(4);
  await playHidden(1);
  navigator.mediaSession.handlers.pause();
  await tick(1500); // let the neighbours warm
  navigator.mediaSession.handlers.nexttrack();
  await Promise.resolve();
  assert.equal(audio.muted, false, 'the new track started muted');
  assert.ok(audio.plays.length >= 1, 'never started the new track');
});

await test('the hold gives up after its time limit', async () => {
  queue(4);
  await playHidden(1);
  navigator.mediaSession.handlers.pause();
  assert.equal(engine.holdingSession(), true, 'precondition: not holding');
  // Reach past the cap the only way the engine can notice: a timeupdate.
  const realNow = Date.now;
  Date.now = () => realNow() + 6 * 60 * 1000;
  try {
    audio.emit('timeupdate');
  } finally {
    Date.now = realNow;
  }
  assert.equal(engine.holdingSession(), false, 'still holding after six minutes');
  assert.equal(audio.paused, true, 'gave up holding but left the element running');
  assert.equal(audio.muted, false);
});

await test('coming back into view stops holding and pauses for real', async () => {
  queue(4);
  await playHidden(1);
  navigator.mediaSession.handlers.pause();
  assert.equal(engine.holdingSession(), true, 'precondition: not holding');
  setVisible('visible');
  await tick(20);
  assert.equal(engine.holdingSession(), false);
  assert.equal(audio.paused, true, 'a muted decoder is still running in the foreground');
  assert.equal(audio.muted, false);
});

await test('the setting is honoured, and a foreground pause is never held', async () => {
  queue(4);
  store.set({ iosKeepAlive: false });
  await playHidden(1);
  navigator.mediaSession.handlers.pause();
  assert.equal(audio.paused, true, 'held despite the setting being off');

  fresh();
  queue(4);
  await engine.playIndex(1);
  audio.paused = false;
  audio.currentTime = 40;
  // Visible: a real pause works here, so holding would only waste battery.
  navigator.mediaSession.handlers.pause();
  assert.equal(audio.paused, true, 'held a pause taken in the foreground');
});

await test('a hold engages even when the platform paused the element first', async () => {
  queue(4);
  await playHidden(1);
  // What WebKit actually does: pause the element, then invoke the handler, and
  // dispatch the DOM pause event afterwards. A `!audio.paused` precondition is
  // therefore always false here — which is how the hold managed never to
  // engage once on a real phone.
  audio.paused = true;
  audio.log.length = 0; // so only what the handler does counts
  navigator.mediaSession.handlers.pause();
  await Promise.resolve();
  assert.equal(engine.holdingSession(), true, 'declined because the element was already stopped');
  assert.equal(audio.muted, true, 'held without muting');
  assert.equal(audio.plays.length, 1, 'never restarted the element, so the session is gone');

  // And the DOM pause event, which WebKit dispatches ~20ms later as its own
  // pause catching up. Tearing the hold down here would undo it every time.
  audio.emit('pause');
  assert.equal(engine.holdingSession(), true, 'the late DOM pause event tore the hold down');
  assert.equal(audio.muted, true);
});

await test('a hold that cannot restart leaves an honest paused state', async () => {
  queue(4);
  await playHidden(1);
  audio.paused = true;
  audio.rejectPlay = 'NotAllowedError';
  navigator.mediaSession.handlers.pause();
  await tick(20);
  assert.equal(engine.holdingSession(), false, 'still claims to be holding after the restart failed');
  assert.equal(audio.muted, false, 'left the element muted with nothing running');
});

await test('a replayed burst of transport presses collapses to one', async () => {
  queue(20);
  await engine.playIndex(5);
  await tick(1500);
  fresh();
  // Six presses in the same millisecond, as delivered on unlock.
  const h = navigator.mediaSession.handlers;
  h.nexttrack(); h.previoustrack(); h.previoustrack();
  h.nexttrack(); h.previoustrack(); h.nexttrack();
  await Promise.resolve();
  assert.ok(
    audio.srcs.length <= 1,
    `${audio.srcs.length} source assignments from one burst — each aborts the last`
  );
});

await test('a deliberate double-tap is not swallowed', async () => {
  queue(20);
  await engine.playIndex(5);
  await tick(1500);
  fresh();
  navigator.mediaSession.handlers.nexttrack();
  await tick(260); // slower than a replayed queue, faster than idle
  navigator.mediaSession.handlers.nexttrack();
  await Promise.resolve();
  assert.equal(store.get().index, 7, `landed on ${store.get().index}, so a real press was dropped`);
});

await test('a real lock-screen pause takes the play control away', async () => {
  queue(4);
  store.set({ iosKeepAlive: false }); // so the pause is a real one
  await playHidden(1);
  navigator.mediaSession.handlers.pause();
  audio.paused = true;
  audio.emit('pause');
  assert.equal(engine.playControlsAvailable(), false, 'left a play button that cannot work');
  assert.equal(navigator.mediaSession.handlers.play, null, 'the play handler is still registered');
  // prev/next must survive: they are the two that still do something.
  assert.equal(typeof navigator.mediaSession.handlers.previoustrack, 'function');
  assert.equal(typeof navigator.mediaSession.handlers.nexttrack, 'function');
});

await test('the play control comes back in the foreground', async () => {
  queue(4);
  store.set({ iosKeepAlive: false });
  await playHidden(1);
  navigator.mediaSession.handlers.pause();
  audio.paused = true;
  audio.emit('pause');
  assert.equal(engine.playControlsAvailable(), false, 'precondition: control was not retired');
  setVisible('visible');
  await tick(20);
  assert.equal(engine.playControlsAvailable(), true);
  assert.equal(typeof navigator.mediaSession.handlers.play, 'function');
});

await test('a held pause keeps the play control, since it still works', async () => {
  queue(4);
  await playHidden(1); // iosKeepAlive defaults on
  navigator.mediaSession.handlers.pause();
  await Promise.resolve();
  assert.equal(engine.holdingSession(), true, 'precondition: the hold did not engage');
  audio.emit('pause'); // the platform's own pause catching up
  assert.equal(engine.playControlsAvailable(), true, 'retired a control that would have worked');
});

await test('retiring can be turned off', async () => {
  queue(4);
  store.set({ iosKeepAlive: false, iosRetirePlay: false });
  await playHidden(1);
  navigator.mediaSession.handlers.pause();
  audio.paused = true;
  audio.emit('pause');
  assert.equal(engine.playControlsAvailable(), true, 'retired despite the setting being off');
  store.set({ iosRetirePlay: true });
});

await test('warmBlob falls back to /api/stream when direct cross-origin fetch is blocked', async () => {
  queue(3);
  const origFetch = globalThis.fetch;
  globalThis.location = { href: 'https://vplayer.test/', origin: 'https://vplayer.test' };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://cdn.test/')) {
      throw new TypeError('Failed to fetch (CSP or CORS)');
    }
    return origFetch(url, init);
  };
  try {
    await engine.playIndex(0);
    const got = await warmUntilBlob();
    assert.equal(got, true, 'warmBlob did not fall back to the same-origin stream relay');
    assert.ok(
      fetches.some((u) => u.startsWith('/api/stream?url=')),
      'expected a relayed fetch via /api/stream'
    );
  } finally {
    globalThis.fetch = origFetch;
    delete globalThis.location;
  }
});

await test('resuming from a held pause after an OS interruption restarts the paused element', async () => {
  queue(4);
  await playHidden(1);
  navigator.mediaSession.handlers.pause();
  assert.equal(engine.holdingSession(), true);
  // Simulate an OS phone call or AirPods disconnect pausing the element mid-hold.
  audio.paused = true;
  audio.log.length = 0;
  navigator.mediaSession.handlers.play();
  assert.equal(audio.muted, false);
  assert.equal(audio.plays.length, 1, 'did not restart an element that the OS paused during hold');
  assert.equal(store.get().playing, true);
});

await test('a coverless track still publishes fallback lock-screen artwork', async () => {
  queue(2);
  await engine.playIndex(0);
  const art = navigator.mediaSession.metadata?.artwork || [];
  assert.ok(art.length > 0, 'coverless track published empty artwork to MediaSession');
  assert.match(art[0].src, /vane-192\.png$/);
});

await test('toggle starts upNext when the main queue is empty', async () => {
  store.set({
    tracks: [],
    upNext: [{ id: '991', name: 'Song 991', artist: 'Artist' }],
    index: -1,
    track: null,
    playing: false,
  });
  await engine.toggle();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(store.get().tracks.length, 1);
  assert.equal(store.get().index, 0);
  assert.equal(store.get().upNext.length, 0);
  assert.equal(store.get().track?.id, '991');
});

await test('upNext splices at index 0 when the queue is loaded but unstarted (index === -1)', async () => {
  store.set({
    tracks: [
      { id: '101', name: 'Song 101', artist: 'Artist' },
      { id: '102', name: 'Song 102', artist: 'Artist' },
    ],
    upNext: [{ id: '992', name: 'Song 992', artist: 'Artist' }],
    index: -1,
    track: null,
    playing: false,
  });
  engine.next();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(store.get().index, 0);
  assert.equal(store.get().tracks[0].id, '992');
  assert.equal(store.get().tracks.length, 3);
});

await test('DOM play/playing events from enterKeepAlive keep MediaSession playing for iOS 5s survival while store stays paused', async () => {
  queue(4);
  await playHidden(1);
  // WebKit pauses the element first, then invokes the MediaSession pause handler.
  audio.paused = true;
  navigator.mediaSession.handlers.pause();
  // When enterKeepAlive() calls audio.play(), real WebKit dispatches 'play' and 'playing'.
  audio.emit('play');
  audio.emit('playing');
  assert.equal(engine.holdingSession(), true, 'hold was lost');
  assert.equal(store.get().playing, false, 'DOM play event during keepAlive set store.playing to true');
  assert.equal(navigator.mediaSession.playbackState, 'paused', 'DOM play event flipped lock screen back to playing');
  assert.equal(engine.resumePoint(), 40, 'DOM playing event wiped pausedAt during keepAlive');

  // An immediate (<180ms) duplicate pause command in the same burst stays in keepAlive.
  navigator.mediaSession.handlers.pause();
  assert.equal(audio.paused, false, 'duplicate pause while held stopped the element');
  assert.equal(engine.holdingSession(), true);

  // Now press play on the lock screen to resume.
  navigator.mediaSession.handlers.play();
  assert.equal(engine.holdingSession(), false);
  assert.equal(audio.muted, false, 'still muted after resume');
  assert.equal(store.get().playing, true);
  assert.equal(navigator.mediaSession.playbackState, 'playing');
});

await test('skipping prev/next after a lock-screen pause does not seek the new track to the old pause mark', async () => {
  queue(4);
  await playHidden(1); // playing track 1 at 40s
  await tick(1500); // warm neighbours
  audio.paused = true;
  navigator.mediaSession.handlers.pause();
  audio.emit('play');
  assert.equal(engine.resumePoint(), 40, 'precondition: pause mark recorded at 40s');

  // Press nexttrack on the lock screen after pausing.
  navigator.mediaSession.handlers.nexttrack();
  await Promise.resolve();
  // New track starts at 0:00 and fires 'play' and 'playing'.
  audio.currentTime = 0;
  audio.emit('play');
  audio.emit('playing');
  assert.equal(store.get().index, 2);
  assert.equal(audio.muted, false, 'new track remained muted');
  assert.equal(audio.paused, false, 'new track is paused');
  assert.equal(
    audio.currentTime,
    0,
    `new track was sought to ${audio.currentTime}s (the previous track's pause mark!), which stalls unbuffered streams`
  );
});

await test('a stale DOM pause event from the old track during lock-screen nexttrack does not retire controls', async () => {
  queue(4);
  await playHidden(1);
  await tick(1500);
  navigator.mediaSession.handlers.nexttrack();
  await Promise.resolve();
  assert.equal(audio.paused, false);
  // Old track's teardown dispatches a late pause event while the new track is already playing.
  audio.emit('pause');
  assert.equal(engine.playControlsAvailable(), true, 'stale pause event retired lock-screen play controls');
  assert.equal(navigator.mediaSession.playbackState, 'playing', 'stale pause event flipped playbackState to paused');
});

await test('walking past WARM_BLOB_MAX tracks still warms every new neighbour as a blob:', async () => {
  queue(8);
  audio.duration = 200;
  audio.currentTime = 15;
  audio.buffered = { length: 1, end: () => 200 };

  for (let i = 0; i < 5; i += 1) {
    await engine.playIndex(i);
    audio.paused = true;
    audio.emit('pause');
    await tick(300);
    await warmUntilBlob();
  }

  // Now at track 4 (the 5th track, well past WARM_BLOB_MAX = 3). Pressing next
  // to go to track 5 must still bind a local blob: URL, not an HTTP URL.
  fresh();
  stubApi.setSongDelay(5000);
  engine.next();
  await Promise.resolve();
  const src = audio.srcs.at(-1);
  assert.ok(
    String(src).startsWith('blob:'),
    `track 5 was given ${src} instead of a blob: after walking past WARM_BLOB_MAX`
  );
  assert.ok(blobs.live.size <= 3, `held ${blobs.live.size} blobs (> WARM_BLOB_MAX)`);
});

await test('dragging the lock-screen progress bar (seekto) seeks accurately and survives resume', async () => {
  queue(4);
  store.set({ iosKeepAlive: false });
  await playHidden(1); // playing at 40s, duration 200s
  // Pause at 40s on the lock screen
  navigator.mediaSession.handlers.pause();
  audio.paused = true;
  audio.emit('pause');
  assert.equal(engine.resumePoint(), 40);

  // Drag the lock-screen scrubber to 135s
  navigator.mediaSession.handlers.seekto({ seekTime: 135 });
  assert.equal(audio.currentTime, 135, 'seekto did not move audio.currentTime to 135s');
  assert.equal(store.get().elapsed, 135, 'seekto did not update store.elapsed');
  assert.equal(engine.resumePoint(), 135, 'seekto did not update pausedAt to the scrubbed position');

  // Resume playback: must continue from 135s, not reload src or jump back to 40s
  const srcsBefore = audio.srcs.length;
  setVisible('visible');
  await tick(20);
  navigator.mediaSession.handlers.play();
  audio.emit('play');
  audio.emit('playing');
  assert.equal(audio.srcs.length, srcsBefore, 'play handler reassigned audio.src and destroyed the seek position');
  assert.equal(audio.currentTime, 135, `playback jumped to ${audio.currentTime}s instead of staying at 135s`);
  store.set({ iosKeepAlive: true });
});

await test('rapid multi-track skipping on the lock screen stays synchronous across 4 consecutive skips', async () => {
  queue(8);
  await engine.playIndex(0);
  await tick(1500); // let Pass One warm 4 tracks ahead

  stubApi.setSongDelay(5000);
  for (let step = 1; step <= 4; step++) {
    fresh();
    stubApi.setSongDelay(5000);
    await tick(250); // respect 200ms burst guard
    navigator.mediaSession.handlers.nexttrack();
    await Promise.resolve();
    assert.equal(audio.plays.length, 1, `skip #${step} was not synchronous`);
    assert.match(audio.srcs.at(-1), new RegExp(`t${step}\\.mp3$`));
  }
});

await test('lock screen metadata updates with live synchronized lyrics on timeupdate and seekto', async () => {
  queue(2);
  await engine.playIndex(0);
  store.set({
    lyrics: [
      { time: 0, words: '第一句歌词' },
      { time: 10, words: '正在唱的第二句歌词' },
      { time: 25, words: '第三句高潮歌词' },
    ],
    lyricIndex: -1,
  });
  audio.duration = 180;
  audio.currentTime = 12;
  audio.emit('timeupdate');
  assert.equal(navigator.mediaSession.metadata.title, '正在唱的第二句歌词');
  assert.equal(navigator.mediaSession.metadata.artist, 'Track 0 · A');

  // Scrubbing on the lock screen immediately updates the lock-screen lyric line too
  navigator.mediaSession.handlers.seekto({ seekTime: 30 });
  assert.equal(navigator.mediaSession.metadata.title, '第三句高潮歌词');
  assert.equal(navigator.mediaSession.metadata.artist, 'Track 0 · A');
});

await test('setVolume adjusts volume and toggles mute at zero without affecting keepAlive', async () => {
  queue(2);
  await engine.playIndex(0);
  engine.setVolume(0);
  assert.equal(store.get().volume, 0);
  assert.equal(audio.muted, true, 'volume 0 should mute the element');
  engine.setVolume(0.75);
  assert.equal(store.get().volume, 0.75);
  assert.equal(audio.volume, 0.75);
  assert.equal(audio.muted, false, 'restoring volume > 0 should unmute');
});

await test('random mode prev() returns to previously played tracks in history stack', async () => {
  queue(6);
  store.set({ mode: 'random' });
  await engine.playIndex(0);
  await engine.playIndex(3);
  await engine.playIndex(5);
  assert.equal(store.get().index, 5);
  await engine.prev();
  assert.equal(store.get().index, 3, 'first prev() in random mode returns to track 3');
  await engine.prev();
  assert.equal(store.get().index, 0, 'second prev() in random mode returns to track 0');
  store.set({ mode: 'sequence' });
});


await test("autoOffline defaults to off and invalid quality 128k is normalized to standard", async () => {
  assert.equal(store.get().autoOffline, "off", "autoOffline must default to off so member login does not mass-download");
  store.set({ quality: "128k" });
  assert.equal(store.get().quality, "standard", "invalid 128k quality key should normalize to standard");
  store.set({ quality: "auto" });
});

await test("a media error during session restore (autoplay: false) does not auto-play or trigger skipBroken", async () => {
  queue(3);
  await engine.playIndex(0, { autoplay: false });
  audio.log.length = 0;
  audio.emit("error");
  await tick(100);
  assert.equal(audio.plays.length, 0, "error during session restore should never start playback");
  assert.equal(store.get().index, 0, "error during session restore should not skip to next track");
});

await test("a failing synchronous cloud-library shortcut (/api/library/audio/:id) evicts the stub from libraryIds and recovers via api.song", async () => {
  const tracks = queue(2);
  store.set({ libraryIds: new Set([tracks[0].id]) });
  await engine.playIndex(0);
  assert.match(audio.srcs.at(-1), /\/api\/library\/audio\//, "precondition: bound library shortcut");

  // Simulate 404 media error on the library stub
  audio.emit("error");
  await tick(120);
  assert.equal(store.get().libraryIds.has(tracks[0].id), false, "failed library stub should be evicted from libraryIds");
  assert.match(audio.srcs.at(-1), /t0\.mp3$/, "should recover via api.song()");
});

await test("tapping the lock-screen || button a second time while held (invoking handlers.pause) toggles out of keepAlive and resumes sound", async () => {
  queue(4);
  await playHidden(1); // playing track 1 at 40s in background
  audio.paused = true;
  navigator.mediaSession.handlers.pause();
  audio.emit("play");
  audio.emit("playing");
  assert.equal(engine.holdingSession(), true, "precondition: keepAlive engaged");
  assert.equal(audio.muted, true, "precondition: muted during keepAlive");

  // Wait >180ms (e.g., listener waits 6 seconds on the lock screen)
  await tick(220);

  // Because iOS lock screen continues drawing || while the muted decoder runs,
  // tapping the center button to resume causes WebKit to pause <audio>, invoke
  // handlers.pause(), and dispatch a delayed DOM pause event ~20ms later.
  audio.log.length = 0;
  audio.paused = true;
  navigator.mediaSession.handlers.pause();
  assert.equal(engine.holdingSession(), false, "second tap on || did not exit keepAlive");
  assert.equal(audio.muted, false, "second tap on || left the element muted (no sound)");
  assert.equal(audio.paused, false, "second tap on || did not restart the element");
  assert.equal(audio.plays.length, 1, "did not call audio.play() inside the pause-toggle gesture");
  assert.equal(store.get().playing, true, "store.playing was not restored to true");

  // Delayed DOM pause event (~20ms later) must not undo the resume or retire controls.
  await tick(20);
  audio.emit("pause");
  assert.equal(store.get().playing, true, "late DOM pause event flipped store.playing back to false");
  assert.equal(engine.playControlsAvailable(), true, "late DOM pause event retired lock-screen controls");
  assert.equal(audio.muted, false);
});

await test("waiting/suspend events during keepAlive do not abort neighbour blob warming for prev/next after >5s", async () => {
  queue(4);
  await playHidden(1);
  navigator.mediaSession.handlers.pause();
  assert.equal(engine.holdingSession(), true);
  // Emit waiting and suspend while warming is in flight during keepAlive
  audio.emit("waiting");
  audio.emit("suspend");
  for (let i = 0; i < 12 && !blobs.made.length; i += 1) {
    await tick(150);
  }
  assert.ok(blobs.made.length > 0, "waiting/suspend during keepAlive aborted neighbour blob warming");

  // Pressing nexttrack after >5s hold binds a local blob: synchronously and unmutes
  fresh();
  stubApi.setSongDelay(5000);
  navigator.mediaSession.handlers.nexttrack();
  await Promise.resolve();
  assert.ok(String(audio.srcs.at(-1)).startsWith("blob:"), "nexttrack after hold did not bind a blob: URL");
  assert.equal(audio.muted, false);
});

/* --------------------------------- report --------------------------------- */

let failed = 0;
for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else {
    failed += 1;
    console.log(`  ✗ ${r.name}`);
    console.log(String(r.err.stack).split("\n").slice(0,1).join("\n"));
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
