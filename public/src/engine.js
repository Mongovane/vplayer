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

const audio = new Audio();
audio.preload = 'metadata';
// Needed for the analyser to read samples. If a CDN doesn't send CORS headers
// this also blocks playback outright, so a load failure retries without it —
// losing the spectrum ring is a fair trade, losing the audio is not.
audio.crossOrigin = 'anonymous';

let token = 0;
let controller = null;
let analyser = null;
let audioCtx = null;
let freq = null;
let wakeLock = null;

export function element() {
  return audio;
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
  if (analyser || !window.AudioContext) return;
  try {
    audioCtx = new AudioContext();
    const src = audioCtx.createMediaElementSource(audio);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.82;
    src.connect(analyser);
    analyser.connect(audioCtx.destination);
    freq = new Uint8Array(analyser.frequencyBinCount);
  } catch (err) {
    console.warn('[engine] analyser unavailable', err);
    analyser = null;
  }
}

/** Normalised spectrum for the wind barbs, or null when unavailable. */
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

function publishSession(track) {
  if (!('mediaSession' in navigator) || !track) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.name || '',
    artist: track.artist || '',
    album: track.album || '',
    artwork: track.cover
      ? [96, 192, 512].map((s) => ({
          src: api.coverUrl(track.cover, s),
          sizes: `${s}x${s}`,
          type: 'image/jpeg',
        }))
      : [],
  });
}

function bindSession() {
  if (!('mediaSession' in navigator)) return;
  const handlers = {
    play: () => toggle(),
    pause: () => toggle(),
    previoustrack: () => prev(),
    nexttrack: () => next(),
    seekto: (d) => d.seekTime != null && seek(d.seekTime),
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, fn);
    } catch {
      /* action unsupported on this platform */
    }
  }
}

/* ---------------------------------- loading -------------------------------- */

/**
 * Load the track at `index` and start it. Resolves when audio is playing (or
 * has failed); lyrics and tint continue in the background.
 */
export async function playIndex(index) {
  const s = store.get();
  const track = s.tracks[index];
  if (!track) return;

  controller?.abort();
  controller = new AbortController();
  const mine = ++token;
  const current = () => mine === token;

  store.set({ index, loading: true, lyrics: [], lyricIndex: -1, elapsed: 0, duration: 0 });

  let resolved;
  try {
    resolved = await api.song(track.id, s.quality, controller.signal);
  } catch (err) {
    if (err.name === 'AbortError' || !current()) return;
    store.set({ loading: false });
    // A dead track shouldn't strand the queue — advance unless we're looping it.
    throw err;
  }
  if (!current()) return;

  // Spreading `resolved` wholesale let its nulls erase what the search result
  // already knew — QQ's resolve omits name, singer and lyrics in practice.
  // Take each field from the resolve only when it actually came back.
  const merged = { ...track };
  for (const [k, v] of Object.entries(resolved)) {
    if (v !== null && v !== undefined && v !== '') merged[k] = v;
  }
  store.set({
    track: merged,
    levelLabel: resolved.levelLabel || api.labelOf(resolved.level || api.resolveQuality(s.quality)),
    loading: false,
  });

  audio.src = resolved.url;
  publishSession(merged);

  try {
    ensureAnalyser();
    if (audioCtx?.state === 'suspended') await audioCtx.resume();
    await audio.play();
  } catch (err) {
    if (err.name !== 'AbortError') console.warn('[engine] autoplay blocked', err);
  }

  // Non-blocking tail: artwork tint, then lyrics.
  tintFromCover(api.coverUrl(merged.cover, 64));

  if (resolved.lyric) {
    const parsed = api.parseLyrics(resolved.lyric, '');
    if (current()) store.set({ lyrics: parsed });
  } else {
    api
      .lyrics(track.id)
      .then((lines) => current() && store.set({ lyrics: lines }))
      .catch(() => current() && store.set({ lyrics: [] }));
  }
}

/* --------------------------------- transport ------------------------------- */

export async function toggle() {
  const s = store.get();
  if (!s.track) {
    if (s.tracks.length) await playIndex(s.index >= 0 ? s.index : 0);
    return;
  }
  if (audio.paused) {
    if (audioCtx?.state === 'suspended') await audioCtx.resume();
    await audio.play().catch(() => {});
  } else {
    audio.pause();
  }
}

export function next() {
  const i = store.nextIndex();
  if (i >= 0) playIndex(i).catch(() => skipBroken());
}

export function prev() {
  const i = store.prevIndex();
  if (i >= 0) playIndex(i).catch(() => skipBroken());
}

/** One retry forward on a failed resolve, then stop rather than spin the queue. */
let brokenRun = 0;
/** Sources already retried without CORS, so a second failure is final. */
const corsRetryFor = new Set();
function skipBroken() {
  if (++brokenRun > 3) {
    brokenRun = 0;
    return;
  }
  const i = store.nextIndex();
  if (i >= 0 && i !== store.get().index) playIndex(i).catch(() => skipBroken());
}

export function seek(seconds) {
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
  audio.currentTime = Math.max(0, Math.min(audio.duration, seconds));
  store.set({ elapsed: audio.currentTime });
}

/** Seek by bearing — the dial's native unit. */
export function seekBearing(degrees) {
  const d = ((degrees % 360) + 360) % 360;
  if (Number.isFinite(audio.duration)) seek((d / 360) * audio.duration);
}

export function setVolume(v) {
  audio.volume = Math.max(0, Math.min(1, v));
  store.set({ volume: audio.volume });
}

/* ----------------------------------- wiring -------------------------------- */

export function init() {
  audio.volume = store.get().volume;
  bindSession();

  audio.addEventListener('play', () => {
    brokenRun = 0;
    store.set({ playing: true });
    holdScreen(true);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  });

  audio.addEventListener('pause', () => {
    store.set({ playing: false });
    holdScreen(false);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  });

  audio.addEventListener('loadedmetadata', () => {
    store.set({ duration: Number.isFinite(audio.duration) ? audio.duration : 0 });
  });

  audio.addEventListener('timeupdate', () => {
    const s = store.get();
    const t = audio.currentTime;
    const patch = { elapsed: t };
    if (s.lyrics.length) {
      const li = api.lyricIndexAt(s.lyrics, t + 0.25);
      if (li !== s.lyricIndex) patch.lyricIndex = li;
    }
    store.set(patch);
  });

  audio.addEventListener('ended', () => {
    if (store.get().mode === 'single') {
      audio.currentTime = 0;
      audio.play().catch(() => {});
    } else {
      next();
    }
  });

  audio.addEventListener('error', () => {
    if (!audio.src) return;
    // One retry without CORS before giving up on the track.
    if (audio.crossOrigin && !corsRetryFor.has(audio.src)) {
      const src = audio.src;
      corsRetryFor.add(src);
      audio.crossOrigin = null;
      audio.src = src;
      audio.play().catch(() => skipBroken());
      return;
    }
    skipBroken();
  });

  // Re-arm the wake lock when returning to a tab that was playing.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && store.get().playing) holdScreen(true);
  });
}
