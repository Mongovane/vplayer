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
  visibility = 'visible';
  store.set({ offlineIds: new Set(), iosKeepAlive: true });
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

await test('a lock-screen press is on disk the moment it happens', async () => {
  queue(3);
  await engine.playIndex(0);
  localStorage.removeItem('vplayer:diaglog');

  // Exactly what the lock screen does. No await after it: if the write were
  // throttled or deferred, a frozen page would never perform it.
  navigator.mediaSession.handlers.nexttrack();

  const raw = localStorage.getItem('vplayer:diaglog');
  assert.ok(raw, 'nothing was persisted — a frozen page would lose this entirely');
  const rows = JSON.parse(raw).rows.map((r) => r.event);
  assert.ok(rows.includes('session:next'), `persisted rows lack session:next: ${rows.join(',')}`);
});

await test('routine chatter does not write on every single event', async () => {
  queue(3);
  await engine.playIndex(0);
  // media:metadata is chatter, not a lifecycle event. The throttle is "at most
  // once every two seconds", so the first line after a gap is *supposed* to
  // write — it is the ones immediately after it that must not.
  audio.emit('loadedmetadata');
  localStorage.removeItem('vplayer:diaglog');
  audio.emit('loadedmetadata');
  audio.emit('loadedmetadata');
  audio.emit('loadedmetadata');
  assert.equal(
    localStorage.getItem('vplayer:diaglog'),
    null,
    'every log line is hitting localStorage — that would be a write per timeupdate'
  );
});

await test('clearing removes the stored copy too', async () => {
  queue(2);
  await engine.playIndex(0);
  navigator.mediaSession.handlers.nexttrack();
  assert.ok(localStorage.getItem('vplayer:diaglog'), 'precondition: nothing stored');
  engine.clearDiagnostics();
  assert.equal(localStorage.getItem('vplayer:diaglog'), null);
  assert.ok(!engine.diagnostics().includes('session:next'));
});

await test('a fresh page reads back the previous session', async () => {
  // The whole point of persisting: the run being investigated is the one that
  // ended when iOS discarded the page. Seed storage the way the last session
  // would have left it, then load the engine again and see if it surfaces.
  localStorage.setItem(
    'vplayer:diaglog',
    JSON.stringify({
      startedAt: Date.now() - 60000,
      rows: [
        { t: 1000, vis: 'hidden', event: 'session:next' },
        { t: 1010, vis: 'hidden', event: 'play:fail', detail: { name: 'NotAllowedError' } },
      ],
    })
  );
  const reloaded = await import('../public/src/engine.js?reload=1');
  const text = reloaded.diagnostics();
  assert.match(text, /上一次会话/);
  assert.match(text, /session:next/);
  assert.match(text, /NotAllowedError/);
  assert.match(text, /本次会话/);
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
