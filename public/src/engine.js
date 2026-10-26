/**
 * engine.js — the audio path.
 *
 * Two behaviours carried over from the old build because they were right:
 *   1. Audio first. The playable url is fetched and handed to the element
 *      before lyrics or artwork are touched, so nothing blocks sound.
 *   2. Monotonic request tokens. Rapid skipping used to let a slow response
 *      from track 3 overwrite the state of track 5; every async step re-checks
 *      that it is still the newest request before writing anything.
 */

import * as store from './store.js';
import * as api from './api.js';
import * as offline from './offline.js';

/**
 * iOS suspends an AudioContext the moment the app is backgrounded, and once an
 * element has been routed through createMediaElementSource its output goes
 * through that context permanently — so the spectrum ring costs all audio the
 * second you switch apps. There is no way to have both on iOS, so the ring is
 * the thing that gets dropped.
 *
 * iPadOS reports itself as a Mac, hence the touch-point check.
 */
const IS_IOS =
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

const WANT_ANALYSER = !IS_IOS;

/**
 * A diagnostics log used to live here: a persisted ring buffer of engine
 * events, surfaced through a panel in settings. It did its job — it is what
 * identified that WebKit pauses the element before invoking the transport
 * handler, and that presses made while the page is suspended arrive in a burst
 * on unlock — and it is removed now that those answers are in the code itself.
 * `git log` has it if it is ever wanted back.
 */

// One-time cleanup of what the log left in storage.
try { localStorage.removeItem('vplayer:diaglog'); } catch { /* nothing to remove */ }

/**
 * One media element, and only one.
 *
 * A two-element arrangement did fix the sound on a locked screen, but it broke
 * the lock screen itself: iOS binds the now-playing session to a single element
 * in the document, and with two candidates it attached to the wrong (silent)
 * one — the transport showed that element's paused state while the other played,
 * and its buttons controlled the element making no sound.
 *
 * The blob experiment is what corrected the underlying theory. Playing a
 * `blob:` url assigns src at the moment of the change too, and that worked
 * fine while locked. So assigning a source is not what a locked screen
 * objects to — reaching for the *network* is. Hence: one element for correct
 * session binding, and the next track's bytes fetched into the HTTP cache
 * beforehand so the assignment resolves locally.
 */
const audio = new Audio();
audio.preload = 'auto';
// Required for inline playback on iOS; without it Safari can take the element
// fullscreen or refuse to start.
audio.setAttribute('playsinline', '');
audio.playsInline = true;
// Only needed so the analyser can read samples. Where there is no analyser it
// is pure downside — a CDN that omits CORS headers would block playback.
if (WANT_ANALYSER) audio.crossOrigin = 'anonymous';

// A detached media element is unreliable on iOS: Safari treats an element in
// the document as the page's audio and keeps it running when backgrounded.
//
// It must not be display:none, and this is subtler than it looks: the UA
// stylesheet gives an <audio> without a `controls` attribute `display: none`,
// so appending it and styling only position/opacity still computes to none.
// iOS then treats it as not really present — it starts, but won't reliably keep
// playing in the background or bind the lock-screen transport to it.
audio.setAttribute('aria-hidden', 'true');
audio.style.cssText =
  'display:block;position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1';
if (document.body) document.body.append(audio);
else document.addEventListener('DOMContentLoaded', () => document.body.append(audio), { once: true });

let token = 0;
let controller = null;
let analyser = null;
/** The element→context node, kept so it can be unrouted when backgrounded. */
let analyserSource = null;
let audioCtx = null;
let freq = null;
let wakeLock = null;
/** Whether the current load is intended to play (false during session restore). */
let wantPlay = false;
/** Re-entrancy guard so overlapping media error events cannot race each other. */
let errorHandling = false;

export function element() {
  return audio;
}

/**
 * Where playback was last paused, or 0 if it wasn't.
 *
 * The element's own currentTime is unreliable after a pause on a locked iOS
 * screen: the media resource may have been released and reloaded from the
 * start. This is the value to resume from.
 */
export function resumePoint() {
  return pausedAt;
}

/* -------------------------- cover → --wind tinting ------------------------- */

/**
 * The old build fed the cover's dominant colour into --primary-color, so the
 * entire interface changed hue per track and brand recognition evaporated.
 * Here exactly one variable moves, and its lightness and chroma are clamped in
 * oklch so a muddy sleeve can't wash out the panel.
 */
async function tintFromCover(url) {
  if (!url) return;
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = url;
    await img.decode();

    const n = 24;
    const canvas = document.createElement('canvas');
    canvas.width = n;
    canvas.height = n;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, n, n);
    const { data } = ctx.getImageData(0, 0, n, n);

    // Average in linear space, weighted toward saturated pixels — a mean over
    // sRGB bytes on a mostly-black sleeve returns grey every time.
    let r = 0;
    let g = 0;
    let b = 0;
    let weight = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      const pr = data[i] / 255;
      const pg = data[i + 1] / 255;
      const pb = data[i + 2] / 255;
      const max = Math.max(pr, pg, pb);
      const min = Math.min(pr, pg, pb);
      const sat = max - min;
      const w = 0.15 + sat * 2.2;
      r += pr * pr * w;
      g += pg * pg * w;
      b += pb * pb * w;
      weight += w;
    }
    if (!weight) return;
    const to255 = (v) => Math.round(Math.sqrt(v / weight) * 255);

    const tint = `rgb(${to255(r)} ${to255(g)} ${to255(b)})`;
    // Clamp through oklch: keep the hue, force a usable lightness and chroma.
    document.documentElement.style.setProperty(
      '--wind',
      `oklch(from ${tint} clamp(0.62, l, 0.78) clamp(0.07, c, 0.15) h)`
    );
  } catch {
    /* cross-origin or decode failure — keep the previous tint */
  }
}

/* -------------------------------- analyser --------------------------------- */

/**
 * Wired lazily on first play: constructing an AudioContext before a gesture
 * leaves it suspended on iOS, and an unused context still costs battery.
 */
function ensureAnalyser() {
  if (!WANT_ANALYSER || analyser || !window.AudioContext) return;
  try {
    audioCtx = new AudioContext();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.82;
    analyserSource = audioCtx.createMediaElementSource(audio);
    analyserSource.connect(analyser);
    analyser.connect(audioCtx.destination);
    freq = new Uint8Array(analyser.frequencyBinCount);

    // The browser may suspend the context on its own — device sleep, an audio
    // focus change. Without this the element goes on "playing" in silence.
    audioCtx.addEventListener('statechange', () => {
      if (audioCtx.state === 'suspended' && store.get().playing) {
        audioCtx.resume().catch(() => {});
      }
    });
  } catch (err) {
    console.warn('[engine] analyser unavailable', err);
    analyser = null;
  }
}

/**
 * Normalised spectrum for the wind barbs, or null when unavailable — which is
 * always the case on iOS, where background playback wins over the visual.
 */
export function spectrum() {
  if (!analyser) return null;
  analyser.getByteFrequencyData(freq);
  return freq;
}

/* -------------------------------- wake lock -------------------------------- */

async function holdScreen(active) {
  try {
    if (active && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    } else if (!active && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    /* denied or unsupported — playback is unaffected */
  }
}

/* ------------------------------ media session ------------------------------ */

const loadedCovers = new Set();
const failedCovers = new Set();
const pendingCovers = new Map();

const FALLBACK_ARTWORK = [
  { src: '/img/vane-192.png', sizes: '192x192', type: 'image/png' },
  { src: '/img/vane-512.png', sizes: '512x512', type: 'image/png' },
  { src: '/img/vane-maskable.svg', sizes: 'any', type: 'image/svg+xml' },
];

function preloadCover(url, onReady) {
  if (!url || !IS_REAL_AUDIO || typeof Image !== 'function') return;
  if (loadedCovers.has(url)) {
    onReady?.();
    return;
  }
  if (failedCovers.has(url)) return;
  if (pendingCovers.has(url)) {
    if (onReady) pendingCovers.get(url).push(onReady);
    return;
  }
  const cbs = onReady ? [onReady] : [];
  pendingCovers.set(url, cbs);
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    pendingCovers.delete(url);
    loadedCovers.add(url);
    for (const fn of cbs) {
      try { fn(); } catch { /* ignore */ }
    }
  };
  img.onerror = () => {
    pendingCovers.delete(url);
    failedCovers.add(url);
  };
  img.src = url;
}

let lastArtKey = '';
let lastMetaKey = '';

function publishSession(track, { playing = null, lyricLine = '' } = {}) {
  if (!('mediaSession' in navigator) || !track) return;
  navigator.mediaSession.playbackState =
    playing === null ? (audio.paused ? 'paused' : 'playing') : playing ? 'playing' : 'paused';
  const cleanLyric = String(lyricLine || '').trim();
  const trackLabel = [track.name, track.artist].filter(Boolean).join(' · ');
  const title = cleanLyric || track.name || '';
  const artist = cleanLyric ? trackLabel || track.artist || '' : track.artist || '';
  const album = track.album || '';

  let artwork = FALLBACK_ARTWORK;
  if (track.cover) {
    const hdCover = api.coverUrl(track.cover, 512);
    if (!failedCovers.has(hdCover)) {
      // Publish the 512x512 cover URL once from the very start instead of
      // swapping FALLBACK_ARTWORK -> hdCover 150ms later (which caused iOS
      // Lock Screen to flash and reload the artwork a second time).
      artwork = [
        ...[512, 192].map((s) => ({
          src: api.coverUrl(track.cover, s),
          sizes: `${s}x${s}`,
          type: 'image/jpeg',
        })),
        ...FALLBACK_ARTWORK,
      ];
      preloadCover(hdCover);
    }
  }

  const artKey = artwork[0]?.src || '';
  const metaKey = `${title}\0${artist}\0${album}\0${artKey}`;
  const existing = navigator.mediaSession.metadata;
  if (!existing || artKey !== lastArtKey) {
    lastArtKey = artKey;
    lastMetaKey = metaKey;
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist,
      album,
      artwork,
    });
  } else if (metaKey !== lastMetaKey) {
    lastMetaKey = metaKey;
    // Update title/artist/album in-place on the existing MediaMetadata instance
    // so iOS WebKit updates the text on the Lock Screen without destroying and
    // re-fetching the already-loaded artwork image.
    try {
      existing.title = title;
      existing.artist = artist;
      existing.album = album;
    } catch {
      navigator.mediaSession.metadata = new MediaMetadata({
        title,
        artist,
        album,
        artwork,
      });
    }
  }
  publishPosition();
}

/**
 * True when the last pause happened with the app out of view.
 *
 * That is the pause that can leave an iOS element unable to make sound again:
 * play() resolves, the transport says "playing", and nothing is heard — and it
 * does not reject, so there is nothing to catch. The only thing that revives it
 * is rebinding the source, so this flag says which of the two the play handler
 * should do.
 */
let pausedWhileHidden = false;

/**
 * Rebind the current track's source and start it, synchronously.
 *
 * This is the same thing playIndex's fast path does, and it is why the
 * play/pause control no longer has to be taken off the lock screen after a
 * pause. The previous build removed it, on the reasoning that a resume from a
 * locked screen could never work while prev/next "genuinely work — they go
 * through playIndex and build playback afresh". The second half of that was not
 * true: prev/next were reaching the network and were just as silent. Now all
 * three take the same warm, synchronous path, so the asymmetry that justified
 * hiding the button is gone.
 *
 * Returns false when there is nothing warm to rebind with, in which case the
 * caller should fall back to a plain play() and let the retry cover it.
 */
function rebuildCurrent() {
  const s = store.get();
  if (s.index < 0) return false;
  const track = s.tracks[s.index];
  const entry = track && warmGet(track.id);
  if (!entry) return false;
  // No awaits between here and play(): the whole point is to stay inside the
  // gesture. The 'playing' handler puts the playhead back to pausedAt.
  wantPlay = true;
  currentUrl = warmUrl(entry).startsWith('blob:') ? warmUrl(entry) : api.withToken(entry.url);
  audio.src = currentUrl;
  const p = audio.play();
  if (p) p.catch(() => {});
  return true;
}

/* ----------------------------- transport gating ---------------------------- */

const TRANSPORT_MIN_GAP_MS = 200;
let lastTransportAt = 0;

function transportAllowed() {
  const now = Date.now();
  if (now - lastTransportAt < TRANSPORT_MIN_GAP_MS) {
    return false;
  }
  lastTransportAt = now;
  return true;
}

/* ------------------------------- keep-alive -------------------------------- */

const KEEPALIVE_MAX_MS = 5 * 60 * 1000;
let keepAlive = false;
let keepAliveMark = 0;
let keepAliveSince = 0;
let keepAliveExitedAt = 0;
let keepAliveSongUrl = '';
let keepAliveDuration = 0;
let silentBlobUrl = '';

const IS_REAL_AUDIO =
  typeof HTMLAudioElement !== 'undefined' && audio instanceof HTMLAudioElement;

/**
 * Build a 10-second 8 kHz mono 16-bit PCM WAV blob URL with sub-audible (±1 LSB,
 * -90 dB) samples. Playing this on the single <audio> element with
 * audio.muted = false keeps both iOS AVAudioSession and MPNowPlayingInfoCenter
 * alive without triggering WebKit's muted-element NowPlaying disqualification
 * ("未在播放").
 */
function getSilentBlobUrl() {
  if (silentBlobUrl) return silentBlobUrl;
  try {
    const sampleRate = 8000;
    const seconds = 10;
    const numSamples = sampleRate * seconds;
    const dataSize = numSamples * 2;
    const buf = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buf);
    const writeStr = (off, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);
    for (let i = 0; i < numSamples; i++) {
      view.setInt16(44 + i * 2, i & 1 ? 1 : -1, true);
    }
    silentBlobUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    return silentBlobUrl;
  } catch {
    return '';
  }
}

function keepAliveBlockedBy() {
  if (!IS_IOS) return 'not ios';
  if (!store.get().iosKeepAlive) return 'setting off';
  if (document.visibilityState !== 'hidden') return 'visible';
  if (!(audio.currentTime > 0) && !(store.get().elapsed > 0)) return 'no position';
  if (!audio.src) return 'no source';
  return '';
}

/** Returns true if the pause was held instead of performed. */
function enterKeepAlive() {
  if (keepAlive) return true;
  if (keepAliveBlockedBy()) return false;

  const s = store.get();
  keepAlive = true;
  keepAliveMark = audio.currentTime > 0 ? audio.currentTime : Number(s.elapsed) || 0;
  keepAliveSince = Date.now();
  pausedAt = keepAliveMark;
  keepAliveDuration =
    Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration
      : Number(s.duration) || Number(s.track?.duration) || 0;

  if (IS_REAL_AUDIO) {
    const sil = getSilentBlobUrl();
    if (sil) {
      keepAliveSongUrl = currentUrl || audio.src;
      currentUrl = sil;
      audio.muted = false;
      audio.loop = true;
      audio.src = sil;
      const p = audio.play();
      if (p) {
        p.catch(() => {
          keepAlive = false;
          audio.loop = false;
          if (keepAliveSongUrl) audio.src = keepAliveSongUrl;
        });
      }
    } else {
      audio.muted = true;
      if (audio.paused) {
        const p = audio.play();
        if (p) {
          p.catch(() => {
            keepAlive = false;
            audio.muted = false;
          });
        }
      }
    }
  } else {
    audio.muted = true;
    if (audio.paused) {
      const p = audio.play();
      if (p) {
        p.catch(() => {
          keepAlive = false;
          audio.muted = false;
        });
      }
    }
  }

  store.set({ playing: false, elapsed: keepAliveMark });
  const activeTrack = s.track || s.tracks[s.index];
  const lineText = s.lyricIndex >= 0 ? s.lyrics[s.lyricIndex]?.words || '' : '';
  if (activeTrack) {
    publishSession(activeTrack, { playing: false, lyricLine: lineText });
  } else if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'paused';
  }
  publishPosition(keepAliveMark);
  scheduleWarm(50, { bytes: true, includeCurrent: IS_REAL_AUDIO });
  return true;
}

/**
 * Stop holding. `resume` decides whether sound comes back or the element is
 * genuinely paused at the mark.
 */
function exitKeepAlive({ resume, why }) {
  if (!keepAlive) return;
  keepAlive = false;
  audio.loop = false;
  audio.muted = false;
  const mark = keepAliveMark;

  if (IS_REAL_AUDIO && keepAliveSongUrl) {
    const s = store.get();
    const track = s.tracks[s.index];
    const entry = track && warmGet(track.id);
    const restoredUrl =
      entry && warmUrl(entry).startsWith('blob:')
        ? warmUrl(entry)
        : keepAliveSongUrl;
    keepAliveSongUrl = '';
    if (resume) {
      keepAliveExitedAt = Date.now();
      wantPlay = true;
      pausedAt = mark;
      currentUrl = restoredUrl;
      audio.src = currentUrl;
      if (mark > 0.2) {
        try { audio.currentTime = mark; } catch { /* loadedmetadata/playing will land on pausedAt */ }
      }
      const p = audio.play();
      if (p) {
        p.catch(() => {
          rebuildCurrent();
        });
      }
      store.set({ playing: true, elapsed: mark });
      bindSession();
      const activeTrack = track || s.track;
      const lineText = s.lyricIndex >= 0 ? s.lyrics[s.lyricIndex]?.words || '' : '';
      if (activeTrack) {
        publishSession(activeTrack, { playing: true, lyricLine: lineText });
      } else if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing';
      }
      publishPosition(mark);
      holdScreen(true);
      return;
    }
    wantPlay = false;
    pausedAt = mark;
    currentUrl = restoredUrl;
    audio.src = currentUrl;
    audio.pause();
    if (mark > 1) {
      try { audio.currentTime = mark; } catch { /* pausedAt covers it */ }
    }
    store.set({ playing: false, elapsed: mark });
    return;
  }

  if (resume) {
    if (why === 'transport-pause-toggle') keepAliveExitedAt = Date.now();
    wantPlay = true;
    pausedAt = 0;
    if (mark > 1 && Math.abs(audio.currentTime - mark) > 1.2) {
      try { audio.currentTime = mark; } catch { /* not seekable yet */ }
    }
    if (audio.paused || why === 'transport-pause-toggle') {
      const p = audio.play();
      if (p) {
        p.catch(() => {
          rebuildCurrent();
        });
      }
    }
    store.set({ playing: true, elapsed: mark > 0 ? mark : audio.currentTime });
    bindSession();
    const s = store.get();
    const activeTrack = s.track || s.tracks[s.index];
    const lineText = s.lyricIndex >= 0 ? s.lyrics[s.lyricIndex]?.words || '' : '';
    if (activeTrack) {
      publishSession(activeTrack, { playing: true, lyricLine: lineText });
    } else if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing';
    }
    publishPosition(mark > 0 ? mark : audio.currentTime);
    holdScreen(true);
  } else {
    wantPlay = false;
    audio.pause();
    if (mark > 1) {
      try { audio.currentTime = mark; } catch { /* not seekable; pausedAt covers it */ }
    }
  }
}

/** True while the session is being held, for the UI to explain itself. */
export function holdingSession() {
  return keepAlive;
}

let playControlsRetired = false;

function retirePlayControls() {
  if (!('mediaSession' in navigator) || playControlsRetired) return;
  if (!store.get().iosRetirePlay || store.get().iosKeepAlive) return;
  playControlsRetired = true;
  for (const action of ['play', 'pause']) {
    try {
      navigator.mediaSession.setActionHandler(action, null);
    } catch {
      /* unsupported — nothing to remove */
    }
  }
}

/** Give the control back. Pause and resume behave normally in the foreground. */
function restorePlayControls() {
  if (!playControlsRetired) return;
  playControlsRetired = false;
  bindSession();
}

/** For the UI, so it can say whether the transport is currently reduced. */
export function playControlsAvailable() {
  return !playControlsRetired;
}

function bindSession({ onlyPlayPause = false } = {}) {
  if (!('mediaSession' in navigator)) return;
  const handlers = {
    play: () => {
      wantPlay = true;
      brokenRun = 0;
      if (keepAlive) { exitKeepAlive({ resume: true, why: 'transport' }); return; }
      if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => {});
      if (IS_IOS && pausedWhileHidden && rebuildCurrent()) return;
      if (pausedAt > 1 && audio.currentTime < 0.5) {
        try { audio.currentTime = pausedAt; } catch { /* not seekable yet */ }
      }
      const p = audio.play();
      if (p) {
        p.catch(() => {
          rebuildCurrent();
        });
      }
    },
    pause: () => {
      if (keepAlive) {
        if (Date.now() - keepAliveSince > 180) {
          exitKeepAlive({ resume: true, why: 'transport-pause-toggle' });
        }
        return;
      }
      if (enterKeepAlive()) return;
      wantPlay = false;
      audio.pause();
    },
    previoustrack: () => { if (transportAllowed('prev')) prev(); },
    nexttrack: () => { if (transportAllowed('next')) next(); },
    seekto: (d) => d.seekTime != null && seek(d.seekTime),
  };
  for (const [action, fn] of Object.entries(handlers)) {
    if (onlyPlayPause && action !== 'play' && action !== 'pause') continue;
    try {
      navigator.mediaSession.setActionHandler(action, fn);
    } catch {
      /* action unsupported on this platform */
    }
  }
}

/**
 * Keep the lock screen's scrubber in step. Without a position state iOS shows a
 * dead progress bar, and on some builds refuses to draw prev/next at all.
 */
function publishPosition(overridePos = null) {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const rawD = keepAlive ? keepAliveDuration : audio.duration;
  const s = store.get();
  const fallbackD = Number(s.duration) || Number(s.track?.duration) || 0;
  const d = Number.isFinite(rawD) && rawD > 0 ? rawD : fallbackD;
  if (!Number.isFinite(d) || d <= 0) return;
  const fallbackPos = pausedAt > 0.2 ? pausedAt : Number(s.elapsed) || 0;
  const rawPos =
    overridePos !== null
      ? overridePos
      : keepAlive
        ? keepAliveMark
        : audio.currentTime > 0.2
          ? audio.currentTime
          : fallbackPos;
  const position = Math.min(Math.max(rawPos, 0), d);
  // While paused or holding in keepAlive, playbackRate must be near-zero so
  // iOS MPNowPlayingInfoCenter does not advance the Lock Screen progress bar
  // while the silent keepAlive WAV blob is playing in the background.
  const isPaused = keepAlive || audio.paused || !s.playing;
  const rate = isPaused ? 0.0000001 : audio.playbackRate || 1;
  try {
    navigator.mediaSession.setPositionState({
      duration: d,
      playbackRate: rate,
      position,
    });
  } catch {
    try {
      navigator.mediaSession.setPositionState({
        duration: d,
        playbackRate: 1,
        position,
      });
    } catch {
      /* some engines reject a position state mid-seek; harmless */
    }
  }
}

/* ---------------------------------- loading -------------------------------- */

/**
 * Load the track at `index` and start it. Resolves when audio is playing (or
 * has failed); lyrics and tint continue in the background.
 *
 * `autoplay` is passed in rather than inferred from the element.
 */
export async function playIndex(index, { autoplay = true, fromSkip = false } = {}) {
  const s = store.get();
  const track = s.tracks[index];
  if (!track) return;

  controller?.abort();
  controller = new AbortController();
  const mine = ++token;
  const current = () => mine === token;

  wantPlay = Boolean(autoplay);
  errorHandling = false;
  if (autoplay && !fromSkip) {
    brokenRun = 0;
  }

  clearStall();
  cancelWarm();
  stallRecoveries = 0;

  pausedAt = 0;
  advancing = false;
  keepAliveExitedAt = 0;
  keepAliveSongUrl = '';
  audio.loop = false;
  if (keepAlive && autoplay) {
    keepAlive = false;
  }
  if (autoplay && audio.muted) {
    audio.muted = false;
  }

  // ---- The synchronous window -------------------------------------------
  //
  // Everything that grants permission to make sound lives in this block, and
  // it runs before the first await deliberately.
  let preresolved = autoplay ? warmGet(track.id) : null;
  if (
    !preresolved &&
    autoplay &&
    s.libraryIds &&
    s.libraryIds.has(String(track.id)) &&
    !(s.offlineIds && s.offlineIds.has(String(track.id)))
  ) {
    preresolved = {
      id: track.id,
      url: `/api/library/audio/${encodeURIComponent(track.id)}`,
      levelLabel: 'LIB · 库',
    };
  }
  let resolved = preresolved;
  let startPromise = null;
  if (preresolved) {
    currentUrl = warmUrl(preresolved).startsWith('blob:')
      ? warmUrl(preresolved)
      : api.withToken(preresolved.url);
    audio.src = currentUrl;
    startPromise = audio.play();
    if (startPromise) startPromise.catch(() => {});
  }

  const prelimTrack = preresolved
    ? {
        ...track,
        ...Object.fromEntries(
          Object.entries(preresolved).filter(([, v]) => v !== null && v !== undefined && v !== '')
        ),
      }
    : track;
  store.set({
    index,
    track: prelimTrack,
    loading: true,
    ...(autoplay ? {} : { playing: false }),
    lyrics: [],
    lyricIndex: -1,
    elapsed: 0,
    duration: Number(prelimTrack.duration) > 0 ? Number(prelimTrack.duration) : 0,
    playbackError: '',
  });
  publishSession(prelimTrack, { playing: autoplay });

  // ---- The slow path ----------------------------------------------------
  if (!resolved) {
    resolved = await resolveTrack(track, s, controller.signal).catch((err) => {
      if (err.name === 'AbortError' || !current()) return null;
      store.set({ loading: false, playbackError: err.message || '解析失败' });
      throw err;
    });
    if (!resolved || !current()) return;
  }

  // Spreading `resolved` wholesale let its nulls erase what the search result
  // already knew — QQ's resolve omits name, singer and lyrics in practice.
  // Take each field from the resolve only when it actually came back.
  const merged = { ...track };
  for (const [k, v] of Object.entries(resolved)) {
    if (k === 'cover' && track.cover) continue;
    if (v !== null && v !== undefined && v !== '') merged[k] = v;
  }

  // Fold the resolved artwork and titles back into the queue entry only when a
  // field actually changed, avoiding redundant store notifications on every skip.
  const tracks = store.get().tracks;
  if (tracks[index]) {
    const prevRow = tracks[index];
    const nextName = merged.name ?? prevRow.name;
    const nextArtist = merged.artist ?? prevRow.artist;
    const nextAlbum = merged.album ?? prevRow.album;
    const nextCover = merged.cover ?? prevRow.cover;
    if (
      nextName !== prevRow.name ||
      nextArtist !== prevRow.artist ||
      nextAlbum !== prevRow.album ||
      nextCover !== prevRow.cover
    ) {
      const nextTracks = [...tracks];
      nextTracks[index] = {
        ...prevRow,
        name: nextName,
        artist: nextArtist,
        album: nextAlbum,
        cover: nextCover,
      };
      store.set({ tracks: nextTracks });
    }
  }

  store.set({
    track: merged,
     ...(Number(merged.duration) > 0 && !(store.get().duration > 0) ? { duration: Number(merged.duration) } : {}),
    levelLabel: resolved.levelLabel || api.labelOf(resolved.level || api.resolveQuality(s.quality)),
    loading: false,
  });

  if (!preresolved) {
    currentUrl = api.withToken(resolved.url);
    audio.src = currentUrl;
    if (autoplay) {
      startPromise = audio.play();
      if (startPromise) startPromise.catch(() => {});
    }
  }

  offline.releaseAllExcept([track.id, ...warmIds()]);
  publishSession(merged, { playing: autoplay });

  if (autoplay) {
    try {
      ensureAnalyser();
      if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => {});
      if (startPromise) await startPromise;
    } catch (err) {
      if (err.name !== 'AbortError' && current()) {
        console.warn('[engine] start refused', err);
        setTimeout(() => {
          if (!current() || !wantPlay) return;
          audio.play().catch(() => {
            if (!current() || !wantPlay) return;
            recoverBadSource(index, track, mine);
          });
        }, 120);
      }
    }
  }

  if (String(currentUrl).startsWith('blob:')) offline.touch(track.id).catch(() => {});

  scheduleWarm();

  // Non-blocking tail: artwork tint, then lyrics.
  tintFromCover(api.coverUrl(merged.cover, 512));

  api
    .lyrics(track.id, { name: track.name, artist: track.artist })
    .then((lines) => {
      if (!current()) return;
      if (lines.length) store.set({ lyrics: lines });
      else if (resolved.lyric) store.set({ lyrics: api.parseLyrics(resolved.lyric, '') });
      else store.set({ lyrics: [] });
    })
    .catch(() => {
      if (!current()) return;
      store.set({ lyrics: resolved.lyric ? api.parseLyrics(resolved.lyric, '') : [] });
    });
}

/**
 * Find a playable url for a track: device copy first, then the api.
 */
async function resolveTrack(track, s, signal, { touch = true } = {}) {
  const curStore = store.get();
  const idKey = String(track.id);
  let offlineTargetId = curStore.offlineIds.has(idKey) ? idKey : null;
  if (!offlineTargetId && track?.name && Array.isArray(curStore.offlineTracks)) {
    const normA = (v) => String(v || '').trim().toLowerCase().replace(/\s*[、/,，&]\s*/g, '/').replace(/\s+/g, ' ');
    const tKey = `${String(track.name || '').trim().toLowerCase().replace(/\s+/g, ' ')}::${normA(track.artist)}`;
    if (tKey !== '::') {
      const hit = curStore.offlineTracks.find(
        (r) => r?.id && `${String(r.name || '').trim().toLowerCase().replace(/\s+/g, ' ')}::${normA(r.artist)}` === tKey
      );
      if (hit && curStore.offlineIds.has(String(hit.id))) offlineTargetId = String(hit.id);
    }
  }
  if (offlineTargetId) {
    const stored = await offline.meta(offlineTargetId).catch(() => null);
    if (!stored) {
      curStore.offlineIds.delete(offlineTargetId);
    } else {
      const sound = await offline.verify(offlineTargetId).catch(() => ({ ok: false }));
      if (!sound.ok) {
        console.warn('[offline] discarding unusable copy', offlineTargetId, sound);
        curStore.offlineIds.delete(offlineTargetId);
        await offline.remove(offlineTargetId).catch(() => {});
      } else {
        const url = await offline.objectUrl(offlineTargetId).catch(() => null);
        if (url) {
          if (touch) offline.touch(offlineTargetId).catch(() => {});
          return {
            ...stored,
            id: track.id,
            url,
            source: stored.source || track.source || '',
            levelLabel: `${(stored.levelLabel || stored.level || '').split(' · ')[0] || '离线'} · 离线`,
          };
        }
        curStore.offlineIds.delete(offlineTargetId);
      }
    }
  }

  return api.song(track.id, s.quality, signal, s.resolver, undefined, { name: track.name, artist: track.artist });
}

/** Tracks already re-resolved after a bad source, so this happens once each. */
const badSourceRetried = new Set();

/**
 * Last resort when the element will not load a url at all.
 */
async function recoverBadSource(index, track, expectedToken = token) {
  if (expectedToken !== token || !wantPlay || errorHandling) return;
  const key = String(track.id);
  if (badSourceRetried.has(key)) {
    store.set({
      playbackError:
        document.visibilityState === 'hidden'
          ? '后台切歌被系统拦截，回到应用点播放继续'
          : '这首歌的音源打不开，换个音质或音源再试',
    });
    return;
  }
  badSourceRetried.add(key);

  // If the failing source was a stale cloud-library stub or corrupt offline
  // blob, drop that shortcut so resolveTrack fetches a fresh upstream URL.
  if (String(audio.src).includes('/api/library/audio/')) {
    store.get().libraryIds?.delete(key);
  }
  if (String(audio.src).startsWith('blob:') && store.get().offlineIds?.has(key)) {
    store.get().offlineIds.delete(key);
    offline.remove(track.id).catch(() => {});
  }
  warmDrop(key);

  try {
    const resolved = await resolveTrack(track, store.get(), controller?.signal);
    if (!resolved?.url) throw new Error('no url');
    if (expectedToken !== token || store.get().index !== index || !wantPlay) return;
    currentUrl = api.withToken(resolved.url);
    audio.src = currentUrl;
    store.set({
      levelLabel: resolved.levelLabel || api.labelOf(resolved.level || api.resolveQuality(store.get().quality)),
      playbackError: '',
    });
    await audio.play();
  } catch {
    if (expectedToken === token) {
      store.set({ playbackError: '这首歌的音源打不开，换个音质或音源再试' });
    }
  }
}

/* --------------------------------- transport ------------------------------- */

export async function toggle() {
  const s = store.get();
  if (keepAlive) {
    exitKeepAlive({ resume: true, why: 'toggle' });
    return;
  }
  if (!s.track) {
    if (s.tracks.length) await playIndex(s.index >= 0 ? s.index : 0);
    else if (s.upNext.length) next();
    return;
  }
  if (audio.paused) {
    wantPlay = true;
    brokenRun = 0;
    if (audioCtx?.state === 'suspended') await audioCtx.resume();

    const mark = pausedAt;

    if (!audio.src) {
      await playIndex(s.index >= 0 ? s.index : 0);
      if (mark > 1) seek(mark);
      return;
    }

    if (mark > 1 && audio.currentTime < 0.5) {
      try {
        audio.currentTime = mark;
      } catch {
        /* not seekable yet; the 'playing' handler will correct it */
      }
    }

    await audio.play().catch(() => {});
  } else {
    wantPlay = false;
    audio.pause();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  }
}

const warm = new Map(); // id -> { url, level, levelLabel, at, ... }
const WARM_MAX = 12;
/** At most this many entries may hold downloaded bytes at once. */
const WARM_BLOB_MAX = 3;
/** Upstream urls expire — NetEase's in about twenty minutes. Re-resolve first. */
const WARM_TTL = 8 * 60 * 1000;

function warmGet(id) {
  const hit = warm.get(String(id));
  if (!hit) return null;
  if (!String(hit.url).startsWith('blob:') && Date.now() - hit.at > WARM_TTL) {
    warmDrop(String(id));
    return null;
  }
  return hit;
}

/** Revoke anything this entry allocated, then forget it. */
function warmDrop(key) {
  const hit = warm.get(String(key));
  if (hit?.local) {
    try { URL.revokeObjectURL(hit.local); } catch { /* already gone */ }
  }
  warm.delete(String(key));
}

function warmPut(id, entry) {
  const key = String(id);
  const previous = warm.get(key);
  const local = entry.local ?? previous?.local ?? null;
  if (previous && previous.local && previous.local !== local) warmDrop(key);
  warm.delete(key);
  warm.set(key, { ...entry, local, at: Date.now() });
  const playing = String(store.get().tracks[store.get().index]?.id ?? '');
  while (warm.size > WARM_MAX) {
    const victim = [...warm.keys()].find((k) => k !== playing);
    if (!victim) break;
    warmDrop(victim);
  }
}

/** Clear everything, revoking as it goes. */
function warmClear() {
  for (const key of [...warm.keys()]) warmDrop(key);
}

function warmUrl(entry) {
  return entry?.local || entry?.url || '';
}

function warmIds() {
  return [...warm.keys()];
}

let warmAbort = null;
/** The url the element is playing, and whether it has been warmed. */
let currentUrl = '';
/** Where playback was paused, so a reloaded element can be put back. */
let pausedAt = 0;

/** Abandon an in-flight warm — used when the playing track starts to starve. */
function cancelWarm() {
  clearTimeout(warmTimer);
  warmBytesPending = false;
  warmRerunBytes = false;
  try { warmAbort?.abort(); } catch { /* already settled */ }
  warmAbort = null;
}

/** Above this, a track is streamed rather than held; a master can be 60MB+. */
const MAX_WARM_BLOB = 48 * 1024 * 1024;

async function warmBlob(url, entry = null) {
  cancelWarm();
  warmAbort = new AbortController();
  const signal = warmAbort.signal;
  try {
    let res;
    try {
      res = await fetch(url, { cache: 'force-cache', priority: 'low', signal });
    } catch (err) {
      if (err?.name === 'AbortError' || signal.aborted) return null;
      const canRelay =
        typeof location !== 'undefined' &&
        Boolean(location.origin) &&
        /^https?:\/\//i.test(url) &&
        !String(url).startsWith(location.origin);
      if (!canRelay) return null;
      res = await fetch(api.withToken(`/api/stream?url=${encodeURIComponent(url)}`), {
        cache: 'force-cache',
        priority: 'low',
        signal,
      });
    }
    if (!res.ok) return null;
    const declared = Number(res.headers.get('content-length')) || 0;
    if (declared > MAX_WARM_BLOB) {
      if (entry) entry.oversized = true;
      try { res.body?.cancel(); } catch { /* already closed */ }
      return null;
    }
    const blob = await res.blob();
    if (signal.aborted) return null;
    if (blob.size > MAX_WARM_BLOB) {
      if (entry) entry.oversized = true;
      return null;
    }
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

function warmTargets() {
  const s = store.get();
  const out = [];
  const seen = new Set();
  const add = (item) => {
    if (!item?.id || seen.has(String(item.id))) return;
    seen.add(String(item.id));
    out.push(item);
  };

  const plan = store.whatsNext();
  if (plan) add(plan.from === 'upNext' ? s.upNext[0] : s.tracks[plan.index]);

  const back = store.prevIndex();
  if (back >= 0) add(s.tracks[back]);

  if (s.index >= 0) add(s.tracks[s.index]);
  return out;
}

function warmResolveTargets() {
  const s = store.get();
  const out = warmTargets();
  const seen = new Set(out.map((t) => String(t.id)));
  const add = (item) => {
    if (!item?.id || seen.has(String(item.id))) return;
    seen.add(String(item.id));
    out.push(item);
  };
  for (const item of s.upNext.slice(0, 3)) add(item);
  const len = s.tracks.length;
  if (len > 1 && s.index >= 0 && s.mode !== 'random') {
    for (let step = 2; step <= 4; step++) {
      add(s.tracks[(s.index + step) % len]);
    }
    for (let step = 2; step <= 2; step++) {
      add(s.tracks[(s.index - step + len) % len]);
    }
  }
  return out;
}

let warming = false;
let warmRerunBytes = false;
let warmRerunIncludeCurrent = false;

async function warmNeighbours({ bytes = false, includeCurrent = false } = {}) {
  if (warming) {
    if (bytes) warmRerunBytes = true;
    if (includeCurrent) warmRerunIncludeCurrent = true;
    return;
  }
  warming = true;
  try {
    const s = store.get();
    const playingId = s.index >= 0 ? String(s.tracks[s.index]?.id ?? '') : '';
    const rawTargets = warmTargets();
    // When holding with a silent blob, warm the current track first so resume is local.
    const targets =
      includeCurrent && playingId
        ? [
            ...rawTargets.filter((t) => String(t.id) === playingId),
            ...rawTargets.filter((t) => String(t.id) !== playingId),
          ]
        : rawTargets;
    const resolveList = warmResolveTargets();

    for (const item of resolveList) {
      if (item?.cover) preloadCover(api.coverUrl(item.cover, 512));
      const existing = warmGet(item.id);
      if (existing) {
        if (existing.cover) preloadCover(api.coverUrl(existing.cover, 512));
        continue;
      }
      let resolved = null;
      try {
        resolved = await resolveTrack(item, s, undefined, { touch: false });
      } catch {
        continue;
      }
      if (!resolved?.url) continue;
      if (resolved.cover) preloadCover(api.coverUrl(resolved.cover, 512));
      warmPut(item.id, { ...resolved, id: item.id, url: api.withToken(resolved.url) });
    }

    if (!bytes) return;

    const targetIds = new Set(targets.map((t) => String(t.id)));
    for (const item of targets) {
      if (!includeCurrent && String(item.id) === playingId) continue;
      const entry = warm.get(String(item.id));
      if (!entry || entry.local || entry.oversized) continue;
      const url = String(entry.url);
      if (url.startsWith('blob:') || url === currentUrl) continue;
      const heldEntries = [...warm.entries()].filter(([, x]) => x.local);
      if (heldEntries.length >= WARM_BLOB_MAX) {
        const victim =
          heldEntries.find(([k]) => !targetIds.has(k) && k !== playingId) ||
          heldEntries.find(([k]) => k !== String(item.id) && k !== playingId);
        if (victim) {
          try { URL.revokeObjectURL(victim[1].local); } catch { /* already gone */ }
          victim[1].local = null;
        } else {
          return;
        }
      }
      const local = await warmBlob(url, entry);
      if (local) {
        const still = warm.get(String(item.id));
        if (still === entry) {
          entry.local = local;
        } else {
          try { URL.revokeObjectURL(local); } catch { /* already gone */ }
        }
      }
      if (
        includeCurrent &&
        targets.some((t) => {
          const e = warm.get(String(t.id));
          return e && !e.local && !e.oversized;
        })
      ) {
        warmRerunBytes = true;
        warmRerunIncludeCurrent = true;
      }
      return;
    }
  } finally {
    warming = false;
    if (warmRerunBytes) {
      const inc = warmRerunIncludeCurrent || (keepAlive && IS_REAL_AUDIO);
      warmRerunBytes = false;
      warmRerunIncludeCurrent = false;
      scheduleWarm(60, { bytes: true, includeCurrent: inc });
    }
  }
}

let warmTimer = 0;
let warmBytesPending = false;
let warmIncludeCurrentPending = false;
function scheduleWarm(delay = 800, opts = {}) {
  if (opts.bytes) warmBytesPending = true;
  if (opts.includeCurrent) warmIncludeCurrentPending = true;
  clearTimeout(warmTimer);
  warmTimer = setTimeout(() => {
    const bytes = Boolean(opts.bytes || warmBytesPending);
    const includeCurrent = Boolean(opts.includeCurrent || warmIncludeCurrentPending);
    warmBytesPending = false;
    warmIncludeCurrentPending = false;
    warmNeighbours({ bytes, includeCurrent });
  }, delay);
}

export function next() {
  const plan = store.whatsNext();
  if (!plan) return;

  if (plan.from === 'upNext') {
    const s = store.get();
    const [item, ...rest] = s.upNext;
    const at = s.index >= 0 ? s.index + 1 : 0;
    const tracks = [...s.tracks];
    tracks.splice(at, 0, item);
    store.set({ tracks, upNext: rest });
    playIndex(at).catch(() => skipBroken());
    return;
  }

  playIndex(plan.index).catch(() => skipBroken());
}

export function prev() {
  const i = store.consumePrevIndex ? store.consumePrevIndex() : store.prevIndex();
  if (i >= 0) playIndex(i).catch(() => skipBroken());
}

/** Consecutive failed tracks; stops automatic skipping once > 3. */
let brokenRun = 0;
/** Sources already retried without CORS, so a second failure is final. */
const corsRetryFor = new Set();
/** Tracks already retried at 128k, so a bad one can't loop the downgrade. */
const lowQualityRetryFor = new Set();
/** Tracks already re-resolved through the fallback, so we ask it only once. */
const fallbackTried = new Set();

/**
 * Ask the fallback resolver for a different link before writing the track off.
 */
async function recoverViaFallback(expectedToken = token) {
  const s = store.get();
  const track = s.tracks[s.index];
  if (!track || !s.fallbackAvailable || s.resolver === 'lx') return false;
  if (String(audio.src).startsWith('blob:')) return false;

  const key = String(track.id);
  if (fallbackTried.has(key)) return false;
  fallbackTried.add(key);

  try {
    const alt = await api.song(track.id, s.quality, controller?.signal, 'lx', undefined, { name: track.name, artist: track.artist });
    if (!alt?.url || expectedToken !== token || !wantPlay) return false;
    currentUrl = api.withToken(alt.url);
    audio.src = currentUrl;
    store.set({ levelLabel: alt.levelLabel || '备用源', playbackError: '' });
    await audio.play();
    return true;
  } catch {
    return false;
  }
}

let lastSkipAt = 0;
function skipBroken() {
  if (!wantPlay) return;
  const nowMs = performance.now();
  if (nowMs - lastSkipAt < 900 && brokenRun >= 2) {
    brokenRun = 99;
  }
  lastSkipAt = nowMs;

  if (++brokenRun > 3) {
    // Do NOT reset brokenRun = 0 here: leaving brokenRun > 3 and clearing
    // wantPlay prevents any late asynchronous error callback from restarting
    // another 3-track skip cycle across the playlist.
    wantPlay = false;
    try { audio.pause(); } catch {}
    store.set({
      playing: false,
      loading: false,
      playbackError: '连续多首无法播放，已停止。请检查网络或音源。',
    });
    return;
  }
  const i = store.nextIndex();
  if (i >= 0 && i !== store.get().index) {
    playIndex(i, { autoplay: true, fromSkip: true }).catch(() => skipBroken());
  } else {
    wantPlay = false;
    store.set({ playing: false, loading: false });
  }
}

const listenedHandlers = new Set();
let listenedFired = '';

export function onListened(fn) {
  listenedHandlers.add(fn);
  return () => listenedHandlers.delete(fn);
}

export function seek(seconds) {
  const s = store.get();
  const d =
    Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration
      : Number(s.duration) || 0;
  if (!Number.isFinite(d) || d <= 0) return;
  const target = Math.max(0, Math.min(d, Number(seconds) || 0));
  cancelWarm();
  if (keepAlive) keepAliveMark = target;
  if (audio.paused || keepAlive || pausedAt > 0) pausedAt = target;
  try {
    audio.currentTime = target;
  } catch {
    /* not seekable yet; pausedAt will land on it when playing fires */
  }
  const patch = { elapsed: target };
  if (s.lyrics.length) {
    const li = api.lyricIndexAt(s.lyrics, target + 0.25);
    if (li !== s.lyricIndex) {
      patch.lyricIndex = li;
      const lineText = li >= 0 ? s.lyrics[li]?.words || '' : '';
      if (s.track) publishSession(s.track, { lyricLine: lineText });
    }
  }
  store.set(patch);
  publishPosition(target);
}

/** Seek to an absolute time in seconds. */
export function seekTo(seconds) {
  if (!audio.duration) return;
  audio.currentTime = Math.max(0, Math.min(seconds, audio.duration));
}

export function seekBearing(degrees) {
  const d = ((degrees % 360) + 360) % 360;
  if (Number.isFinite(audio.duration)) seek((d / 360) * audio.duration);
}

export function setVolume(v) {
  const clamped = Math.max(0, Math.min(1, Number(v) || 0));
  try {
    audio.volume = clamped;
  } catch {
    /* read-only on some iOS builds */
  }
  if (!keepAlive) {
    audio.muted = clamped === 0;
  }
  store.set({ volume: clamped });
}

/* ---------------------------------- stalls ---------------------------------- */

let stallTimer = 0;
let lastProgressAt = 0;
let advancing = false;
let stallRecoveries = 0;

function clearStall() {
  clearTimeout(stallTimer);
  stallTimer = 0;
}

function armStall() {
  if (keepAlive || (silentBlobUrl && audio.src === silentBlobUrl)) return;
  if (audio.readyState < 3) cancelWarm();
  if (stallTimer || !store.get().playing || audio.paused) return;
  const armedAtPos = audio.currentTime;
  stallTimer = setTimeout(async () => {
    stallTimer = 0;
    if (keepAlive || !store.get().playing || audio.paused) return;
    if (performance.now() - lastProgressAt < 6000) return;
    // On a locked iOS screen, WebKit throttles timeupdate events while audio
    // continues playing normally in hardware. If currentTime moved forward,
    // playback is NOT stalled.
    if (Math.abs(audio.currentTime - armedAtPos) > 0.2) {
      lastProgressAt = performance.now();
      return;
    }

    const at = audio.currentTime;
    if (++stallRecoveries > 3) {
      store.set({ playbackError: '音源持续中断，已停止重试' });
      audio.pause();
      return;
    }

    console.warn('[engine] stalled, reloading at', at);
    const src = audio.src;
    audio.load();
    audio.src = src;
    try {
      await audio.play();
      audio.currentTime = at;
      return;
    } catch {
      /* fall through to a full re-resolve */
    }

    const s = store.get();
    if (s.index >= 0) {
      try {
        await playIndex(s.index);
        seek(at);
      } catch {
        store.set({ playbackError: '音源中断且无法重新获取' });
      }
    }
  }, 8000);
}

/* ----------------------------------- wiring -------------------------------- */

export function init() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      try {
        analyserSource?.disconnect();
        analyser?.disconnect();
      } catch {
        /* already disconnected */
      }
    } else {
      pausedWhileHidden = false;
      restorePlayControls();
      exitKeepAlive({ resume: false, why: 'foreground' });
      scheduleWarm(400);
      if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => {});
      try {
        if (audioCtx && analyserSource && analyser) {
          analyserSource.connect(analyser);
          analyser.connect(audioCtx.destination);
        }
      } catch {
        /* already connected */
      }
    }
  });

  if ('audioSession' in navigator) {
    try { navigator.audioSession.type = 'playback'; } catch { /* unsupported */ }
  }

  audio.volume = store.get().volume;
  bindSession();

  store.on(['quality', 'resolver'], () => {
    warmClear();
  });
  store.on(['tracks', 'mode', 'upNext', 'index'], () => scheduleWarm(1200));

  for (const ev of ['waiting', 'stalled']) {
    audio.addEventListener(ev, armStall);
  }
  audio.addEventListener('playing', () => {
    lastProgressAt = performance.now();
    clearStall();
    errorHandling = false;
    badSourceRetried.delete(String(store.get().track?.id ?? ''));
  });

  let sessionBoundOnGesture = false;
  audio.addEventListener('play', () => {
    if (!sessionBoundOnGesture) {
      sessionBoundOnGesture = true;
      bindSession();
    }
    if (keepAlive) {
      store.set({ playing: false });
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      publishPosition(keepAliveMark);
      return;
    }
    lastProgressAt = performance.now();
    pausedWhileHidden = false;
    restorePlayControls();
    store.set({ playbackError: '' });
    store.set({ playing: true });
    holdScreen(true);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  });

  audio.addEventListener('pause', () => {
    if (Date.now() - keepAliveExitedAt < 2500 && wantPlay) {
      if (audio.paused) {
        const p = audio.play();
        if (p) p.catch(() => {});
      }
      return;
    }
    if (!keepAlive && !audio.paused) return;
    // When AirPods (ear detection or Bluetooth AVRCP) pauses <audio> directly
    // at the OS level without invoking navigator.mediaSession handlers.pause()
    // first, wantPlay is still true. Engage keepAlive here so AirPods pause
    // keeps the audio session alive and preserves Lock Screen controls.
    if (IS_REAL_AUDIO && !keepAlive && wantPlay && document.visibilityState === 'hidden' && !store.get().loading) {
      if (enterKeepAlive()) return;
    }
    // Never call audio.play() or tear down keepAlive inside the delayed DOM
    // pause listener: on iOS, this event arrives ~20ms after handlers.pause()
    // while enterKeepAlive()'s gesture-initiated play() is still starting up.
    if (keepAlive) {
      pausedWhileHidden = document.visibilityState === 'hidden';
      store.set({ playing: false });
      holdScreen(false);
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused';
      }
      publishPosition(keepAliveMark);
      scheduleWarm(50, { bytes: true, includeCurrent: IS_REAL_AUDIO });
      return;
    }
    if (audio.currentTime > 1) {
      pausedAt = audio.currentTime;
      store.set({ elapsed: pausedAt });
    }
    pausedWhileHidden = document.visibilityState === 'hidden';
    if (IS_IOS && pausedWhileHidden && !keepAlive && !store.get().loading) retirePlayControls();
    store.set({ playing: false });
    holdScreen(false);
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }

    scheduleWarm(200, { bytes: true });
  });

  audio.addEventListener('playing', () => {
    if (keepAlive) {
      // WebKit sets NowPlaying to Playing when silentBlobUrl starts decoding;
      // immediately re-assert paused state and frozen keepAliveMark position.
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      publishPosition(keepAliveMark);
      return;
    }
    let resumedAt = null;
    if (pausedAt > 0.2 && audio.currentTime < 0.5) {
      const at = pausedAt;
      pausedAt = 0;
      resumedAt = at;
      try { audio.currentTime = at; } catch { /* not seekable yet */ }
    } else if (audio.currentTime > 1) {
      pausedAt = 0;
    }
    if (Date.now() - keepAliveExitedAt < 5000) {
      bindSession();
      const s = store.get();
      const activeTrack = s.track || s.tracks[s.index];
      const lineText = s.lyricIndex >= 0 ? s.lyrics[s.lyricIndex]?.words || '' : '';
      if (activeTrack) publishSession(activeTrack, { playing: true, lyricLine: lineText });
    }
    publishPosition(resumedAt);
  });

  audio.addEventListener('loadedmetadata', () => {
    if (keepAlive) {
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      publishPosition(keepAliveMark);
      return;
    }
    let targetPos = null;
    if (pausedAt > 0.2 && audio.currentTime < 0.5) {
      targetPos = pausedAt;
      try { audio.currentTime = pausedAt; } catch { /* playing listener will retry */ }
    }
    store.set({ duration: Number.isFinite(audio.duration) ? audio.duration : 0 });
    publishPosition(targetPos);
  });

  audio.addEventListener('durationchange', () => {
    if (keepAlive) {
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      publishPosition(keepAliveMark);
      return;
    }
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      store.set({ duration: audio.duration });
    }
    publishPosition(pausedAt > 0.2 && audio.currentTime < 0.5 ? pausedAt : null);
  });
  audio.addEventListener('seeked', () => {
    if (keepAlive) {
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      publishPosition(keepAliveMark);
      return;
    }
    publishPosition();
  });

  let lastPosPush = 0;
  let lastWarmAt = 0;
  audio.addEventListener('timeupdate', () => {
    lastProgressAt = performance.now();
    if (stallTimer) clearStall();

    if (keepAlive) {
      if (Date.now() - keepAliveSince > KEEPALIVE_MAX_MS) {
        exitKeepAlive({ resume: false, why: 'timeout' });
        return;
      }
      if (!IS_REAL_AUDIO && audio.currentTime > keepAliveMark + 0.35) {
        try { audio.currentTime = keepAliveMark; } catch { /* mid-seek */ }
      }
      if ('mediaSession' in navigator && navigator.mediaSession.playbackState !== 'paused') {
        navigator.mediaSession.playbackState = 'paused';
      }
      const holdNow = performance.now();
      if (holdNow - lastPosPush > 250) {
        lastPosPush = holdNow;
        publishPosition(keepAliveMark);
      }
      return;
    }
    const nowMs = performance.now();
    if (nowMs - lastPosPush > 1000) { lastPosPush = nowMs; publishPosition(); }

    const left = audio.duration - audio.currentTime;
    if (Number.isFinite(left) && left > 5 && nowMs - lastWarmAt > 5000) {
      lastWarmAt = nowMs;
      let bufferedAhead = 0;
      try {
        const b = audio.buffered;
        if (b.length) bufferedAhead = b.end(b.length - 1) - audio.currentTime;
      } catch {
        /* buffered can throw on some engines mid-seek */
      }
      const localSource = String(currentUrl).startsWith('blob:');
      if (localSource || bufferedAhead > 10 || bufferedAhead >= left - 1) {
        warmNeighbours({ bytes: true });
      }
    }

    const sCur = store.get();
    const knownDur = Number(sCur.track?.duration) || 0;
    const isSilentSrc = Boolean(silentBlobUrl && audio.src === silentBlobUrl);
    const fullDurLoaded =
      audio.duration >= 25 &&
      (knownDur <= 30 || (audio.duration >= knownDur * 0.9 && audio.currentTime >= knownDur * 0.9));
    if (
      document.visibilityState === 'hidden' &&
      !isSilentSrc &&
      !sCur.loading &&
      pausedAt === 0 &&
      Date.now() - keepAliveExitedAt > 2500 &&
      fullDurLoaded &&
      Number.isFinite(left) &&
      left > 0 &&
      left < 0.35 &&
      !audio.paused &&
      sCur.mode !== 'single' &&
      !advancing
    ) {
      advancing = true;
      next();
      setTimeout(() => { advancing = false; }, 3000);
    }
    if (audio.currentTime > 0.5) {
      brokenRun = 0;
      if (audio.currentTime < 4 && left > 5) advancing = false;
    }
    const s = store.get();
    const t = pausedAt > 0.2 && audio.currentTime < 0.5 ? pausedAt : audio.currentTime;
    const patch = { elapsed: t };
    if (s.lyrics.length) {
      const li = api.lyricIndexAt(s.lyrics, t + 0.25);
      if (li !== s.lyricIndex) {
        patch.lyricIndex = li;
        const lineText = li >= 0 ? s.lyrics[li]?.words || '' : '';
        if (s.track) publishSession(s.track, { playing: !audio.paused && !keepAlive, lyricLine: lineText });
      }
    }
    store.set(patch);

    const dur = audio.duration;
    if (s.track && dur > 0 && t / dur >= 0.6 && listenedFired !== String(s.track.id)) {
      listenedFired = String(s.track.id);
      for (const fn of listenedHandlers) {
        try {
          fn(s.track);
        } catch (err) {
          console.warn('[listened] handler threw', err);
        }
      }
    }
  });

  audio.addEventListener('ended', () => {
    if (keepAlive || (silentBlobUrl && audio.src === silentBlobUrl)) {
      if (keepAlive) {
        audio.currentTime = 0;
        audio.play().catch(() => {});
      }
      return;
    }
    if (Date.now() - keepAliveExitedAt < 1500) return;
    if (store.get().mode === 'single') {
      audio.currentTime = 0;
      audio.play().catch(() => {});
    } else if (!advancing) {
      advancing = true;
      next();
      setTimeout(() => { advancing = false; }, 1500);
    }
  });

  audio.addEventListener('error', async () => {
    if (!audio.src || errorHandling || keepAlive || (silentBlobUrl && audio.src === silentBlobUrl)) return;

    const s = store.get();
    const track = s.tracks[s.index] || s.track;
    const trackKey = String(track?.id ?? '');

    // If this load was a quiet session restore (autoplay: false) and the user
    // has not pressed Play, never auto-start, retry, or skip on background load errors.
    if (!wantPlay) {
      if (trackKey) warmDrop(trackKey);
      return;
    }

    const errToken = token;
    const stillActive = () => errToken === token && (wantPlay || store.get().playing);
    errorHandling = true;

    try {
      const failedSrc = String(audio.src);
      if (audio.currentTime > 1) {
        pausedAt = audio.currentTime;
      }

      // If a synchronous cloud-library shortcut (/api/library/audio/:id) 404ed
      // (for example, a metadata stub in D1 with no object in R2), evict the id
      // from libraryIds and warm cache so we re-resolve from upstream/fallback.
      if (failedSrc.includes('/api/library/audio/') && trackKey) {
        store.get().libraryIds?.delete(trackKey);
        warmDrop(trackKey);
      }

      // If an offline device blob failed to decode, remove the corrupt copy and
      // fall through to online resolution instead of getting stuck.
      if (failedSrc.startsWith('blob:') && trackKey) {
        if (store.get().offlineIds?.has(trackKey)) {
          store.get().offlineIds.delete(trackKey);
          offline.remove(track.id).catch(() => {});
        }
        warmDrop(trackKey);
      }

      // 1. One retry without CORS for external streams that omit ACAO headers.
      if (
        audio.crossOrigin &&
        !failedSrc.startsWith('blob:') &&
        !failedSrc.includes('/api/library/audio/') &&
        !corsRetryFor.has(failedSrc)
      ) {
        corsRetryFor.add(failedSrc);
        audio.crossOrigin = null;
        audio.src = failedSrc;
        await audio.play();
        return;
      }

      // 2. Retry at standard (128k) quality without mutating the user's saved
      // quality preference in store.js.
      if (track && trackKey && !lowQualityRetryFor.has(trackKey)) {
        lowQualityRetryFor.add(trackKey);
        try {
          const low = await api.song(track.id, 'standard', controller?.signal, store.get().resolver, undefined, { name: track.name, artist: track.artist });
          if (low?.url && stillActive()) {
            currentUrl = api.withToken(low.url);
            audio.src = currentUrl;
            store.set({
              levelLabel: low.levelLabel || '128K · 降级',
              playbackError: '当前音质放不出来，已降到 128K',
            });
            await audio.play();
            return;
          }
        } catch {
          /* fall through to fallback pool */
        }
      }

      // 3. Try the multi-node fallback pool (via=lx).
      if (stillActive() && (await recoverViaFallback(errToken))) {
        return;
      }

      if (!stillActive()) return;

      const name = store.get().track?.name || '这首歌';
      store.set({ loading: false, playbackError: `${name} 放不出来，音源地址无法加载` });
      skipBroken();
    } finally {
      if (errToken === token) {
        errorHandling = false;
      }
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!store.get().playing) return;
    holdScreen(true);
    if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => {});
  });
}
