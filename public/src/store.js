/**
 * store.js — one place where state lives.
 *
 * The previous build kept ~20 mutable module-level bindings (playlist,
 * currentIndex, playMode, requestedLevel, actualLevel, desiredSongId,
 * currentPlayingSongId, songRequestSequence…) and every UI function reached
 * in and read them directly. Adding a view meant remembering which of those to
 * poke. Here, views subscribe to keys and are told when they change.
 */

const PREFIX = 'vplayer:';

/** Preferences that survive reload, with their defaults. */
const PERSISTED = {
  quality: 'auto',
  mode: 'sequence',
  volume: 0.6,
  source: '163',
  view: 'lyrics',
};

function readPref(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* private mode / quota — preferences are a nicety, not a requirement */
  }
}

const state = {
  /* queue */
  tracks: [],
  index: -1,
  playlistName: '',
  playlistId: null,

  /* transport */
  playing: false,
  loading: false,
  elapsed: 0,
  duration: 0,

  /* current track, as resolved by the api */
  track: null,
  levelLabel: '',
  lyrics: [],
  lyricIndex: -1,

  /* search */
  results: [],
  searching: false,

  /* cloud */
  user: null,
  cloudLists: [],
  syncState: 'off',

  /* preferences */
  quality: readPref('quality', PERSISTED.quality),
  mode: readPref('mode', PERSISTED.mode),
  volume: readPref('volume', PERSISTED.volume),
  source: readPref('source', PERSISTED.source),
  view: readPref('view', PERSISTED.view),
};

const listeners = new Map(); // key -> Set<fn>

/** Subscribe to one or more keys. Returns an unsubscribe function. */
export function on(keys, fn) {
  const list = Array.isArray(keys) ? keys : [keys];
  for (const k of list) {
    if (!listeners.has(k)) listeners.set(k, new Set());
    listeners.get(k).add(fn);
  }
  return () => {
    for (const k of list) listeners.get(k)?.delete(fn);
  };
}

function notify(keys) {
  const called = new Set();
  for (const k of keys) {
    const set = listeners.get(k);
    if (!set) continue;
    for (const fn of set) {
      if (called.has(fn)) continue;
      called.add(fn);
      try {
        fn(state, k);
      } catch (err) {
        console.error('[store] listener threw for', k, err);
      }
    }
  }
}

/**
 * Merge a patch into state and notify only the keys that actually changed.
 * Shallow equality is intentional: arrays are always replaced, never mutated
 * in place, so a new reference means new content.
 */
export function set(patch) {
  const changed = [];
  for (const [k, v] of Object.entries(patch)) {
    if (state[k] === v) continue;
    state[k] = v;
    changed.push(k);
    if (k in PERSISTED) writePref(k, v);
  }
  if (changed.length) notify(changed);
  return changed;
}

export function get() {
  return state;
}

/* ---- derived helpers, so views never recompute the same thing ---- */

/**
 * Fractional progress 0–1, which the dial turns into a bearing.
 *
 * Duration is treated as unknown below a second, not merely as a small number.
 * While metadata loads it can briefly report a fraction while `elapsed` already
 * holds a restored position, and elapsed/duration then clamps to 1 — the dial
 * would flash a full sweep for a frame before snapping back.
 */
export function progress() {
  if (!(state.duration > 1)) return 0;
  return Math.min(1, Math.max(0, state.elapsed / state.duration));
}

/** Bearing in degrees, clockwise from north. The core metaphor. */
export function bearing() {
  return progress() * 360;
}

export function nextIndex() {
  const n = state.tracks.length;
  if (!n) return -1;
  if (state.mode === 'single') return state.index;
  if (state.mode === 'random') {
    if (n === 1) return 0;
    let i;
    do {
      i = Math.floor(Math.random() * n);
    } while (i === state.index);
    return i;
  }
  return (state.index + 1) % n;
}

export function prevIndex() {
  const n = state.tracks.length;
  if (!n) return -1;
  if (state.mode === 'random') return nextIndex();
  return (state.index - 1 + n) % n;
}
