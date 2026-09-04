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
 * Two media elements, alternating.
 *
 * A single element has to be re-pointed at a new url to change track, and on a
 * locked iOS screen that assignment forfeits the audio route: the track advances
 * and nothing is heard. Native players don't hit this because they hold an
 * AVAudioSession that survives a source change; a PWA has no equivalent.
 *
 * So we never reassign the source of a playing element. Instead one element
 * plays while the other is pointed at what comes next and left to pre-buffer.
 * At the boundary we simply start the idle one and pause the live one — no src
 * assignment happens while locked, because the next source was bound earlier,
 * in the foreground. This is the standard double-buffer arrangement, and it
 * also gets us near-gapless changes for free.
 *
 * `audio` is a live reference to whichever element is currently playing, so the
 * rest of the engine goes on treating it as "the" element.
 */
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
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.82;
    audioCtx.createMediaElementSource(audio).connect(analyser);
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
  // Deliberately NOT re-binding the action handlers here.
  //
  // Re-registering setActionHandler mid-session makes iOS tear down and rebuild
  // the now-playing session. On a locked screen that is fatal twice over: the
  // rebuilt session loses the transport buttons (leaving only the ±10s skips)
  // and the audio route is dropped, so the next track advances silently. The
  // handlers are registered once in init() and stay valid for the page's life;
  // metadata and playbackState are the only things that should change per track.
  // Read the element, not the store. publishSession runs during a track change,
  // before the 'play' event has propagated into store.playing, so the store
  // would still say "paused" and the lock screen would draw a play icon over a
  // track that is already playing.
  navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
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
  // Which controls iOS draws is decided by which handlers exist. Two lessons
  // learned the hard way:
  //  - seekbackward/seekforward make it prefer the ±10s skip buttons and drop
  //    previoustrack/nexttrack entirely, so they are not registered; the
  //    progress bar still scrubs through seekto.
  //  - a `stop` handler can collapse the transport to a single stop button, so
  //    it is not registered either. Pausing is what a listener actually wants.
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

/**
 * Keep the lock screen's scrubber in step. Without a position state iOS shows a
 * dead progress bar, and on some builds refuses to draw prev/next at all.
 */
function publishPosition() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const d = audio.duration;
  if (!Number.isFinite(d) || d <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: d,
      playbackRate: audio.playbackRate || 1,
      position: Math.min(Math.max(audio.currentTime, 0), d),
    });
  } catch {
    /* some engines reject a position state mid-seek; harmless */
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

  // If this track was prefetched while the previous one played, use it and skip
  // every await below. That is what lets a background advance assign src in the
  // same turn and keep iOS's playback authorisation.
  if (prefetched && String(prefetched.id) === String(track.id)) {
    resolved = prefetched;
    prefetched = null;
  }

  // Only ask IndexedDB about tracks we know are on the device. offlineIds is
  // maintained from the same store, so for a cloud-primary library — most
  // tracks in R2, a handful downloaded — this skips two awaits (meta + verify)
  // on nearly every play. That matters beyond speed: each await yields the event
  // loop, and yielding is what loses the playback claim during a background
  // track change.
  const maybeOffline = store.get().offlineIds.has(String(track.id));
  const stored = resolved || !maybeOffline ? null : await offline.meta(track.id).catch(() => null);
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

  // Same-origin /api/ audio (library or stream proxy) needs the member token,
  // since <audio> can't send an Authorization header. withToken is a no-op for
  // upstream URLs.
  //
  // Assigning src is the delicate moment on iOS. When the app is backgrounded,
  // swapping the source drops the element's playback authorisation: play()
  // resolves, MediaSession advances the metadata, and no sound comes out. That
  // is exactly why repeat-one kept working (it only rewinds currentTime and
  // never reassigns src) while advancing to the next track went silent.
  //
  // Keeping the element "warm" across the swap preserves the session: don't
  // pause first, assign the new source, call load() so the change is committed
  // synchronously, then play() immediately in the same turn — no awaits in
  // between, because any await hands control back to the event loop and the
  // background tab loses its claim.
  // Assign and start in the same synchronous turn, with no load() in between —
  // load() restarts the media-load algorithm and resets the element. The bytes
  // for this url were fetched into the HTTP cache by prefetchNext while the
  // previous track played, so this assignment resolves locally: no network is
  // touched at the one moment a locked screen won't permit it.
  const wasPlaying = !audio.paused || s.playing;
  audio.src = api.withToken(resolved.url);
  const startPromise = wasPlaying ? audio.play() : null;

  // An object url pins its blob in memory; only the playing one is kept.
  offline.releaseAllExcept(track.id);
  publishSession(merged);

  try {
    ensureAnalyser();
    // Resume a suspended context only when one exists; awaiting it before
    // play() would break the gesture chain in the background, so it is fired
    // and forgotten rather than awaited.
    if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => {});
    // If we didn't start above (nothing was playing), start now.
    const p = startPromise || audio.play();
    if (p) await p;
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.warn('[engine] autoplay blocked', err);
      // A background source-swap can be refused even though the session is
      // otherwise healthy. One retry on the next tick usually lands, because by
      // then the new source has finished committing.
      if (wasPlaying) {
        setTimeout(() => {
          audio.play().catch(() => {
            store.set({ playbackError: '后台切歌被系统拦截，回到应用点播放继续' });
          });
        }, 120);
      }
    }
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
    // If the live deck lost its source (an earlier swap cleared it, or the
    // element was reset), resuming it silently does nothing — play() resolves
    // on an element with no source. Re-resolve the track instead of leaving
    // the listener with a dead transport.
    if (!audio.src) {
      await playIndex(s.index >= 0 ? s.index : 0);
      return;
    }
    await audio.play().catch(() => {});
    // Keep the lock screen in step even if the play event is swallowed.
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  } else {
    audio.pause();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  }
}

/**
 * Resolved-URL cache for the track that plays next.
 *
 * Backgrounded iOS is the reason this exists. playIndex has to await an offline
 * lookup and usually a network resolve before it can set audio.src, and every
 * await yields the event loop — which is where a background page loses its
 * claim on playback. The result was the symptom "track advances on the lock
 * screen but there is no sound".
 *
 * So while the current track plays (foreground, no time pressure) we resolve
 * whatever comes next and park the URL here. When the track ends, playIndex can
 * take that URL and assign src synchronously, with no await in between, and the
 * session survives.
 */
let prefetched = null; // { id, url, levelLabel, level, ... }


/**
 * Warm the next track by downloading it whole into a blob.
 *
 * Pointing a second <audio> at the url and calling load() was not enough: the
 * player fetches audio with Range requests, the browser will not reuse a 206
 * partial response as a complete cached resource, and so the main element
 * re-fetched at swap time anyway. Offline tracks, which play from a blob: url,
 * were the only ones that survived a lock-screen change — so warming now
 * produces exactly that: a blob, fully in memory, needing no network and no
 * token when it is time to play.
 *
 * Bounded to a sane size so a lossless file can't balloon memory; anything
 * larger falls back to streaming and simply won't gapless-advance while locked.
 */
/**
 * Arm the idle deck with a source so it can pre-buffer.
 *
 * This replaces an earlier approach that downloaded the whole track into a
 * blob. Downloading worked, but it was the wrong shape: it spent a track's
 * worth of memory and bandwidth to work around a source-assignment limit, when
 * the actual requirement is only that no assignment happens *while locked*.
 * Binding the next source here — in the foreground, ahead of time — satisfies
 * that, and the browser buffers however much it sees fit.
 */
/**
 * Pull the next track's bytes into the HTTP cache.
 *
 * Because the audio endpoints now send a long, immutable cache-control (they
 * used to send max-age=0, which is why every earlier attempt at this achieved
 * nothing), the response is stored, and the media element's subsequent Range
 * requests for the same url are served from that stored copy. That is what
 * makes a track change work on a locked screen: the source assignment still
 * happens, but it resolves without reaching the network, which is the part iOS
 * won't allow.
 *
 * Two things this must not do, both learned from making the audio stutter:
 *  - It must not read the body into an ArrayBuffer. That allocates the whole
 *    file, and under iOS memory pressure the page gets killed — silence.
 *    Streaming the body and discarding each chunk fills the cache just as well.
 *  - It must not compete with the track being played. The caller waits until
 *    the current track is comfortably buffered; the low priority hint tells the
 *    browser to yield to playback if they do overlap.
 */
let warmAbort = null;

/** Abandon an in-flight warm — used when the playing track starts to starve. */
function cancelWarm() {
  try { warmAbort?.abort(); } catch { /* already settled */ }
  warmAbort = null;
}

async function warmCache(url) {
  cancelWarm();
  warmAbort = new AbortController();
  const signal = warmAbort.signal;
  try {
    const res = await fetch(url, { cache: 'force-cache', priority: 'low', signal });
    if (!res.ok || !res.body) return;
    // Drain without retaining: the response has to be read to completion or the
    // transfer is abandoned and nothing is cached, but the bytes themselves are
    // of no interest here.
    const reader = res.body.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
      if (signal.aborted) { reader.cancel().catch(() => {}); return; }
    }
  } catch {
    /* warming is best-effort, and an abort lands here too */
  }
}

async function prefetchNext() {
  try {
    const s0 = store.get();
    // In shuffle, nextIndex() rolls a new number every call, so whatever we
    // prefetched would rarely be what next() actually picks — the work would be
    // wasted and the cache never hit. Repeat-one never changes src at all.
    if (s0.mode === 'random' || s0.mode === 'single') return;

    const plan = store.whatsNext();
    if (!plan) return;
    const s = store.get();
    const item = plan.from === 'upNext' ? s.upNext[0] : s.tracks[plan.index];
    if (!item || (prefetched && String(prefetched.id) === String(item.id))) return;

    // An offline copy needs no network at all; prefer it.
    // Same short-circuit as playIndex: don't interrogate IndexedDB for a
    // track we already know isn't downloaded.
    const stored = store.get().offlineIds.has(String(item.id))
      ? await offline.meta(item.id).catch(() => null)
      : null;
    if (stored) {
      const sound = await offline.verify(item.id).catch(() => ({ ok: false }));
      if (sound.ok) {
        const url = await offline.objectUrl(item.id).catch(() => null);
        if (url) {
          prefetched = {
            ...stored,
            id: item.id,
            url,
            source: stored.source || item.source || '',
            levelLabel: `${(stored.levelLabel || stored.level || '').split(' · ')[0] || '离线'} · 离线`,
          };
          // A blob is already local; nothing to warm.
          return;
        }
      }
    }

    const resolved = await api.song(item.id, s.quality, undefined, s.resolver);
    if (!resolved?.url) return;
    prefetched = { ...resolved, id: item.id, url: api.withToken(resolved.url) };
    // Pull the bytes into the HTTP cache now, in the foreground, so the change
    // of track later resolves locally.
    await warmCache(prefetched.url);
  } catch {
    // A failed prefetch is not an error — playIndex just resolves normally.
    prefetched = null;
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
    audio.src = api.withToken(alt.url);
    store.set({ levelLabel: alt.levelLabel || '备用源', playbackError: '' });
    await audio.play().catch(() => {});
    return true;
  } catch {
    return false;
  }
}
let lastSkipAt = 0;
function skipBroken() {
  // Two independent guards so a bug in either can't produce an endless skip:
  //  1) at most 3 consecutive failures (reset on real progress)
  //  2) a rate limit — if we're skipping faster than once every 1.2s, that's a
  //     loop, not a user listening, so stop regardless of the counter.
  const nowMs = performance.now();
  if (nowMs - lastSkipAt < 1200) { brokenRun = 99; }
  lastSkipAt = nowMs;

  if (++brokenRun > 3) {
    brokenRun = 0;
    store.set({ playing: false, playbackError: '连续多首无法播放，已停止。请检查网络或音源。' });
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
// True between a pre-end advance being fired and the next track taking over,
// so timeupdate can't fire it twice for the same ending.
let advancing = false;
let stallRecoveries = 0;

function clearStall() {
  clearTimeout(stallTimer);
  stallTimer = 0;
}

function armStall() {
  // A stall means the playing stream is short of data. If a warm is running it
  // is competing for that bandwidth, so it gives way immediately — the next
  // track can be warmed again once this one is healthy.
  cancelWarm();
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

  // A prefetched URL is only valid for whatever "next" meant when it was
  // fetched. Reordering the queue, changing repeat/shuffle, or queueing
  // something to play next all change that, so drop it and let the next play
  // event fetch again.
  store.on(['tracks', 'mode', 'upNext', 'quality', 'resolver'], () => {
    prefetched = null;
  });

  for (const ev of ['waiting', 'stalled', 'suspend']) {
    audio.addEventListener(ev, armStall);
  }
  audio.addEventListener('playing', () => {
    lastProgressAt = performance.now();
    clearStall();
  });

  let sessionBoundOnGesture = false;
  audio.addEventListener('play', () => {
    // iOS can ignore action handlers registered before any user gesture, when no
    // media session exists yet. Binding once more on the first real playback —
    // which is always gesture-initiated — is what makes the lock screen show
    // previous/next instead of falling back to the skip buttons.
    if (!sessionBoundOnGesture) {
      sessionBoundOnGesture = true;
      bindSession();
    }
    lastProgressAt = performance.now();
    store.set({ playbackError: '' });
    store.set({ playing: true });
    holdScreen(true);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    // The next track is NOT warmed here. Doing it early competes with the
    // stream that is playing right now, starving its buffer — that was the
    // cause of stuttering audio that eventually cut out. It happens from
    // timeupdate instead, once this track has buffered enough to spare the
    // bandwidth.
  });

  audio.addEventListener('pause', () => {
    store.set({ playing: false });
    holdScreen(false);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  });

  audio.addEventListener('loadedmetadata', () => {
    store.set({ duration: Number.isFinite(audio.duration) ? audio.duration : 0 });
  });

  audio.addEventListener('loadedmetadata', publishPosition);
  audio.addEventListener('durationchange', publishPosition);

  let lastPosPush = 0;
  audio.addEventListener('timeupdate', () => {
    lastProgressAt = performance.now();
    // Refresh the lock-screen scrubber about once a second — often enough to
    // look live, rare enough not to churn.
    const nowMs = performance.now();
    if (nowMs - lastPosPush > 1000) { lastPosPush = nowMs; publishPosition(); }

    // Warm the next track only once this one can spare the bandwidth.
    //
    // "Can spare it" means the buffer is comfortably ahead of the playhead, or
    // the whole track is already buffered. Warming before that competes with
    // playback and makes the audio stutter. There is still time: a track has
    // minutes, and warming needs seconds.
    const left = audio.duration - audio.currentTime;
    if (!prefetched && Number.isFinite(left) && left > 5) {
      let bufferedAhead = 0;
      try {
        const b = audio.buffered;
        if (b.length) bufferedAhead = b.end(b.length - 1) - audio.currentTime;
      } catch {
        /* buffered can throw on some engines mid-seek */
      }
      // Either 30s of headroom, or the rest of the track is in hand.
      if (bufferedAhead > 30 || bufferedAhead >= left - 1) prefetchNext();
    }

    // Advance BEFORE the track ends, while the element is still playing.
    //
    // This is what makes a locked screen work. Waiting for 'ended' means the
    // element becomes idle first, and iOS revokes the audio route from an idle
    // element on a locked screen, so the next play() is silent. Swapping src
    // while the element is mid-playback keeps the route alive across the change.
    //
    // 0.4s before the end is late enough that the listener hears the whole
    // track and early enough that we're still in a playing state.
    if (
      Number.isFinite(left) &&
      left > 0 &&
      left < 0.4 &&
      !audio.paused &&
      store.get().mode !== 'single' &&
      !advancing
    ) {
      advancing = true;
      next();
      // Cleared once the new track reports progress, so a failed advance can be
      // retried by the 'ended' fallback rather than being locked out.
      setTimeout(() => { advancing = false; }, 3000);
    }
    // Real progress means this track actually played — clear the consecutive
    // failure counter here, not on the play *attempt*, so a track that starts
    // then 404s (an un-ingested library stub) still counts as a failure and the
    // skip loop terminates after a few tries instead of spinning forever.
    if (audio.currentTime > 0.5) { brokenRun = 0; advancing = false; }
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
    // Reached only when the pre-end advance didn't fire (very short tracks, or
    // an unknown duration). On a locked screen this path is the unreliable one:
    // once the element has actually ended it is idle, and iOS revokes the audio
    // route from an idle element on a locked screen — the following play() then
    // produces no sound. advanceBeforeEnd exists to avoid getting here.
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
