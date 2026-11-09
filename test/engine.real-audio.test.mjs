import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://vplayer.test/',
});

const media = [];

class FakeRealAudio {
  constructor() {
    this.log = [];
    this._src = '';
    this.paused = true;
    this.muted = false;
    this.loop = false;
    this.currentTime = 0;
    this.duration = 240;
    this.volume = 1;
    this.playbackRate = 1;
    this.preload = '';
    this.crossOrigin = null;
    this.playsInline = false;
    this.buffered = { length: 0, end: () => 0 };
    this.style = { cssText: '' };
    this._listeners = new Map();
    media.push(this);
  }
  get src() { return this._src; }
  set src(v) { this._src = v; this.log.push({ op: 'src', v }); }
  play() {
    this.paused = false;
    this.log.push({ op: 'play', src: this._src, muted: this.muted });
    this.emit('play');
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.log.push({ op: 'pause', src: this._src });
    if (this.fireAsyncPauseOnMethod) {
      queueMicrotask(() => this.emit('pause'));
    }
  }
  load() { this.log.push({ op: 'load' }); }
  setAttribute() {}
  getAttribute() { return null; }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this._listeners.get(type)?.delete(fn); }
  emit(type) { for (const fn of this._listeners.get(type) || []) fn({ type }); }
}

const silentBlobs = [];
class FakeBlob {
  constructor(parts = [], opts = {}) {
    this.parts = parts;
    this.type = opts.type || '';
    const buf = parts[0];
    this.bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(0);
    silentBlobs.push(this);
  }
}

let blobSeq = 0;
const FakeURL = {
  createObjectURL: (b) => b?.type === "audio/wav" ? `blob:silent-wav-${++blobSeq}` : `blob:warm-song-${++blobSeq}`,
  revokeObjectURL: () => {},
};

const handlers = {};
const mediaSession = {
  metadata: null,
  playbackState: 'none',
  positionState: null,
  setActionHandler(action, fn) {
    if (fn) handlers[action] = fn;
    else delete handlers[action];
  },
  setPositionState(s) { this.positionState = s; },
};

function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
}

defineGlobal('window', dom.window);
defineGlobal('document', dom.window.document);
defineGlobal('localStorage', dom.window.localStorage);
defineGlobal('CustomEvent', dom.window.CustomEvent);
defineGlobal('HTMLAudioElement', FakeRealAudio);
defineGlobal('Audio', FakeRealAudio);
defineGlobal('Blob', FakeBlob);
defineGlobal('URL', Object.assign(dom.window.URL, FakeURL));
defineGlobal('MediaMetadata', class { constructor(init) { Object.assign(this, init); } });
defineGlobal('navigator', {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15',
  maxTouchPoints: 5,
  mediaSession,
  wakeLock: null,
});
defineGlobal('fetch', async (url) => {
  const u = String(url);
  if (u.includes('/api/resolve')) {
    await new Promise((r) => setTimeout(r, 25));
    return new Response(
      JSON.stringify({ ok: true, data: { url: 'https://cdn.test/chart-song.mp3', duration: 205, level: 'exhigh' } }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }
  return new Response('audio-data', { status: 200 });
});

const stubApi = await import('./stub-api.js');
const store = await import('../public/src/store.js');
const engine = await import('../public/src/engine.js');
engine.init();
const audio = media[0];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err });
  }
}

await test('IS_REAL_AUDIO enterKeepAlive plays non-zero ±1 LSB WAV carrier with muted=false so iOS Lock Screen never shows 未在播放', async () => {
  store.set({
    tracks: [{ id: 'kw:101', name: 'Real iOS Song', artist: 'Singer', duration: 210 }],
    index: 0,
  });
  await engine.playIndex(0);
  audio.currentTime = 42;
  audio.duration = 210;
  audio.emit('playing');

  // Lock the screen (hidden) and simulate AirPods stem squeeze (mediaSession pause)
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  await wait(220);
  assert.ok(handlers.pause, 'mediaSession pause handler must be registered');
  handlers.pause();

  assert.equal(store.get().playing, false, 'store.playing must be false while in keepAlive');
  assert.equal(mediaSession.playbackState, 'paused', 'mediaSession.playbackState must be paused');
  assert.equal(audio.muted, false, 'audio.muted MUST stay false or iOS WebKit drops NowPlaying into 未在播放');
  assert.equal(audio.paused, false, 'audio element MUST stay playing the silent WAV carrier');
  assert.match(audio.src, /^blob:silent-wav-/, 'audio.src must switch to the silent WAV blob URL');
  assert.ok(silentBlobs.length >= 1, 'getSilentBlobUrl must construct a WAV Blob');
  const wav = silentBlobs[silentBlobs.length - 1].bytes;
  assert.equal(wav[44], 127, 'WAV sample 0 must be 127 (-1 LSB), not digital zero 128');
  assert.equal(wav[45], 129, 'WAV sample 1 must be 129 (+1 LSB), not digital zero 128');
});

await test('IS_REAL_AUDIO resumeFromKeepAlive restores original song URL and playhead synchronously', async () => {
  await wait(220);
  handlers.play();
  assert.equal(store.get().playing, true, 'handlers.play() must synchronously resume from keepAlive');
  assert.doesNotMatch(audio.src, /^blob:silent-wav-/, 'audio.src must restore the real song URL');
  assert.equal(audio.paused, false, 'audio must be playing');
});

await test('IS_REAL_AUDIO AirPods ear removal (OS native pause when hidden) enters keepAlive and ignores trailing mediaSession pause within 1800ms', async () => {
  const realNow = Date.now;
  let fakeNow = realNow() + 5000;
  Date.now = () => fakeNow;
  try {
    audio.currentTime = 68;
    store.set({ loading: false });

    // Simulate OS-level pause when removing AirPods while hidden
    audio.paused = true;
    audio.emit('pause');

    assert.equal(store.get().playing, false, 'OS ear-removal pause must transition store.playing to false');
    assert.equal(audio.paused, false, 'enterKeepAlive({ fromOsPause: true }) must immediately start silent WAV carrier');
    assert.equal(audio.muted, false, 'audio.muted must remain false during OS-pause keepAlive');

    // Trailing mediaSession pause within 1800ms (removing 2nd AirPod) must NOT toggle resume
    fakeNow += 400;
    handlers.pause();
    assert.equal(store.get().playing, false, 'removing 2nd AirPod must NOT resume song playback');
  } finally {
    Date.now = realNow;
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  }
});

await test('Switching from a playing song at 75s to an un-warmed Chart song starts at 0:00 instead of jumping to 75s', async () => {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  store.set({
    tracks: [
      { id: '163:song1', source: '163', name: 'Playing Song', artist: 'A', duration: 240 },
      { id: 'qq:chart_unwarmed_999', source: 'qq', name: 'Chart Song', artist: 'B', duration: 205 },
    ],
    index: 0,
    playing: true,
    elapsed: 75.4,
  });
  audio.paused = false;
  audio.currentTime = 75.4;
  audio.duration = 240;
  audio.fireAsyncPauseOnMethod = true;
  stubApi.setSongDelay(25);

  const p = engine.playIndex(1);
  // While resolveTrack is awaiting, even if timeupdate/pause fire on the old element, elapsed & pausedAt must stay 0
  audio.emit('timeupdate');
  await p;
  stubApi.setSongDelay(0);
  audio.fireAsyncPauseOnMethod = false;

  // Simulate new stream loading metadata and starting playback at 0.0s
  audio.currentTime = 0;
  audio.duration = 205;
  audio.emit('loadedmetadata');
  audio.emit('playing');

  assert.equal(audio.currentTime, 0, 'New chart song must start from 0:00, not seek to old song playhead 75.4s');
  assert.equal(engine.resumePoint(), 0, 'pausedAt must remain 0 after switching to new chart song');
  assert.equal(store.get().elapsed, 0, 'store.elapsed must remain 0 at start of new chart song');
});

let failed = 0;
for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else {
    failed += 1;
    console.log(`  ✗ ${r.name}`);
    console.log(`      ${r.err.stack}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
