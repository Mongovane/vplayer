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

const audio = new Audio();
audio.preload = 'metadata';
// Required for inline playback on iOS; without it Safari can take the element
// fullscreen or refuse to start.
audio.setAttribute('playsinline', '');
audio.playsInline = true;
// Only needed so the analyser can read samples. Where there is no analyser it
// is pure downside — a CDN that omits CORS headers would block playback.
if (WANT_ANALYSER) audio.crossOrigin = 'anonymous';

/**
 * A detached media element is unreliable on iOS: Safari treats an element in the
 * document as the page's audio and keeps it running when backgrounded, and
 * Media Session is more consistent about attaching to it. Costs one hidden node.
 */
audio.setAttribute('aria-hidden', 'true');
audio.style.display = 'none';
if (document.body) document.body.append(audio);
else document.addEventListener('DOMContentLoaded', () => document.body.append(audio), { once: true });

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
  if (!WANT_ANALYSER || analyser || !window.AudioContext) return;
  try {
    audioCtx = new AudioContext();
    const src = audioCtx.createMediaElementSource(audio);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.82;
    src.connect(analyser);
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

  clearStall();
  stallRecoveries = 0;
  store.set({ index, loading: true, lyrics: [], lyricIndex: -1, elapsed: 0, duration: 0, playbackError: '' });

  // A copy on the device comes first, and not for speed: it is the only source
  // that works with no signal at all. Everything downstream treats it exactly
  // like a resolve response.
  let resolved = null;
  const stored = await offline.meta(track.id).catch(() => null);
  if (stored && current()) {
    // A blob shorter than its recorded size plays for a while and then stops
    // dead. Anything stored before downloads were length-checked could be
    // short, so it is checked here rather than trusted.
    const sound = await offline.verify(track.id).catch(() => ({ ok: false }));
    if (!sound.ok) {
      console.warn('[offline] discarding unusable copy', track.id, sound);
      await offline.remove(track.id).catch(() => {});
    }
    const url = sound.ok ? await offline.objectUrl(track.id).catch(() => null) : null;
    if (url) {
      offline.touch(track.id).catch(() => {});
      resolved = {
        ...stored,
        url,
        source: stored.source || track.source || '',
        // Where a file came from is one fact, not a trail. Taking the stored
        // label wholesale produced "STANDARD · 库 · 离线" — the library's own
        // label with another provenance stapled on.
        levelLabel: `${(stored.levelLabel || stored.level || '').split(' · ')[0] || '离线'} · 离线`,
      };
    }
  }

  if (!resolved) {
    try {
      resolved = await api.song(track.id, s.quality, controller.signal, s.resolver);
    } catch (err) {
      if (err.name === 'AbortError' || !current()) return;
      store.set({ loading: false });
      // A dead track shouldn't strand the queue — advance unless we're looping it.
      store.set({ playbackError: err.message || '解析失败' });
      throw err;
    }
  }
  if (!current()) return;

  // Spreading `resolved` wholesale let its nulls erase what the search result
  // already knew — QQ's resolve omits name, singer and lyrics in practice.
  // Take each field from the resolve only when it actually came back.
  const merged = { ...track };
  for (const [k, v] of Object.entries(resolved)) {
    if (v !== null && v !== undefined && v !== '') merged[k] = v;
  }

  // Fold the resolved artwork and titles back into the queue entry. QQ and
  // KuGou search results carry no cover at all, so without this the queue row
  // for the song you are listening to stays blank forever.
  const tracks = store.get().tracks;
  if (tracks[index]) {
    const next = [...tracks];
    next[index] = { ...tracks[index], name: merged.name, artist: merged.artist, album: merged.album, cover: merged.cover };
    store.set({ tracks: next });
  }

  store.set({
    track: merged,
    levelLabel: resolved.levelLabel || api.labelOf(resolved.level || api.resolveQuality(s.quality)),
    loading: false,
  });

  // Same-origin /api/ audio (library or stream proxy) needs the member token in
  // the URL, since an <audio> element can't send an Authorization header.
  audio.src = /^\/api\//.test(resolved.url) ? api.withToken(resolved.url) : resolved.url;
  // An object url pins its blob in memory; only the playing one is kept.
  offline.releaseAllExcept(track.id);
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

  // Lyrics are always looked up by id, including for offline copies: the id is
  // the only thing that reliably identifies which cut of a song this is. The
  // lyric that came back with the resolve is a fallback for when the lookup
  // finds nothing, not a shortcut past it.
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
  const plan = store.whatsNext();
  if (!plan) return;

  if (plan.from === 'upNext') {
    // A hand-queued track is spliced into the context at the play position when
    // its turn arrives. That keeps one index-addressed list for playback while
    // still letting "play next" mean something distinct from "play now".
    const s = store.get();
    const [item, ...rest] = s.upNext;
    const at = Math.max(0, s.index) + (s.tracks.length ? 1 : 0);
    const tracks = [...s.tracks];
    tracks.splice(at, 0, item);
    store.set({ tracks, upNext: rest });
    playIndex(at).catch(() => skipBroken());
    return;
  }

  playIndex(plan.index).catch(() => skipBroken());
}

export function prev() {
  const i = store.prevIndex();
  if (i >= 0) playIndex(i).catch(() => skipBroken());
}

/** One retry forward on a failed resolve, then stop rather than spin the queue. */
let brokenRun = 0;
/** Sources already retried without CORS, so a second failure is final. */
const corsRetryFor = new Set();
/** Tracks already re-resolved through the fallback, so we ask it only once. */
const fallbackTried = new Set();

/**
 * A url that resolves but will not play is a different failure from one that
 * never resolved, and it is the more common one: the primary hands back a link
 * and the CDN behind it answers 503. The fallback resolver covers this too, so
 * ask it for a different link before writing the track off.
 */
async function recoverViaFallback() {
  const s = store.get();
  const track = s.tracks[s.index];
  if (!track || !s.fallbackAvailable || s.resolver === 'lx') return false;
  // A stored blob that fails to decode is corrupt, not a bad link; asking the
  // fallback for a different url would not fix it.
  if (String(audio.src).startsWith('blob:')) return false;

  const key = String(track.id);
  if (fallbackTried.has(key)) return false;
  fallbackTried.add(key);

  try {
    const alt = await api.song(track.id, s.quality, undefined, 'lx');
    if (!alt?.url) return false;
    audio.src = alt.url;
    store.set({ levelLabel: alt.levelLabel || '备用源', playbackError: '' });
    await audio.play().catch(() => {});
    return true;
  } catch {
    return false;
  }
}
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
  audio.volume = Math.max(0, Math.min(1, v));
  store.set({ volume: audio.volume });
}

/* ---------------------------------- stalls ---------------------------------- */

/**
 * A media element that runs out of data fires `waiting` or `stalled`, not
 * `error`. Nothing was listening, so a network hiccup mid-song left the audio
 * stopped with no message and no retry — which is indistinguishable from the
 * track simply ending.
 *
 * Recovery keeps the position and reloads the same source. If that does not get
 * it moving, the track is re-resolved from scratch, since the likeliest cause of
 * a stall that survives a reload is an expired url.
 */
let stallTimer = 0;
let lastProgressAt = 0;
let stallRecoveries = 0;

function clearStall() {
  clearTimeout(stallTimer);
  stallTimer = 0;
}

function armStall() {
  if (stallTimer || !store.get().playing) return;
  stallTimer = setTimeout(async () => {
    stallTimer = 0;
    if (!store.get().playing) return;
    // Still stuck? `timeupdate` would have moved this on.
    if (performance.now() - lastProgressAt < 6000) return;

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
  audio.volume = store.get().volume;
  bindSession();

  for (const ev of ['waiting', 'stalled', 'suspend']) {
    audio.addEventListener(ev, armStall);
  }
  audio.addEventListener('playing', () => {
    lastProgressAt = performance.now();
    clearStall();
  });

  audio.addEventListener('play', () => {
    lastProgressAt = performance.now();
    store.set({ playbackError: '' });
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
    lastProgressAt = performance.now();
    // Real progress means this track actually played — clear the consecutive
    // failure counter here, not on the play *attempt*, so a track that starts
    // then 404s (an un-ingested library stub) still counts as a failure and the
    // skip loop terminates after a few tries instead of spinning forever.
    if (audio.currentTime > 0.5) brokenRun = 0;
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

  audio.addEventListener('error', async () => {
    if (!audio.src) return;

    // One retry without CORS first — the attribute exists for the analyser, and
    // a CDN that omits CORS headers would otherwise cost the audio entirely.
    if (audio.crossOrigin && !corsRetryFor.has(audio.src)) {
      const src = audio.src;
      corsRetryFor.add(src);
      audio.crossOrigin = null;
      audio.src = src;
      audio.play().catch(() => {});
      return;
    }

    if (await recoverViaFallback()) return;

    // Out of options for this track. Say so rather than sitting at 0:00 with a
    // play button, which reads as the player being broken.
    const name = store.get().track?.name || '这首歌';
    store.set({ playbackError: `${name} 放不出来，音源地址无法加载` });
    skipBroken();
  });

  // Returning to a tab that was playing: re-arm the wake lock, and resume the
  // audio graph. A suspended AudioContext is silence, and until now nothing
  // brought it back — the audio element kept reporting that it was playing.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!store.get().playing) return;
    holdScreen(true);
    if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => {});
  });
}
