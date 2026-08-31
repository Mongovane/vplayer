/**
 * offline.js — audio kept on the device.
 *
 * This is the only thing that survives having no signal. The R2 library makes
 * urls stable; it cannot help a phone on a plane.
 *
 * Blobs go in IndexedDB and are played through `URL.createObjectURL`, not
 * through Cache Storage. The reason is seeking: a blob url gets native byte
 * range handling for free, whereas a cached Response has to be sliced by hand
 * in the service worker — reading the whole file into memory on every seek —
 * because Cache Storage matching ignores Range.
 *
 * Its own database, at its own version, so adding audio never has to migrate
 * the metadata database in api.js.
 */

const DB_NAME = 'vplayer-audio';
const DB_VERSION = 2;
const STORE_BLOB = 'blobs';
const STORE_META = 'meta';
/** Half-finished downloads, so backgrounding costs progress rather than all of it. */
const STORE_PART = 'parts';

/** Refuse to start on anything implausible for one song. */
const MAX_TRACK_BYTES = 120 * 1024 * 1024;

/** How much of a download may sit in the JS heap before being folded to disk. */
const COALESCE_BYTES = 4 * 1024 * 1024;

/**
 * Fallback ceiling, used only when a caller does not pass one. The real setting
 * lives in the store so it can be shown and changed; duplicating the number here
 * as an exported constant would give it two homes that could disagree.
 */
const FALLBACK_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;

let dbPromise = null;

export const available = () => typeof indexedDB !== 'undefined';

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_BLOB)) db.createObjectStore(STORE_BLOB);
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_PART)) db.createObjectStore(STORE_PART);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((err) => {
    console.warn('[offline] IndexedDB unavailable', err);
    return null;
  });
  return dbPromise;
}

function tx(db, stores, mode) {
  return db.transaction(stores, mode);
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/* ---------------------------------- reads ----------------------------------- */

/**
 * Verify a stored blob still matches the size recorded for it. Anything written
 * before the truncation check above could be short, and a short blob is exactly
 * the "plays for a minute then stops" failure.
 */
export async function verify(id) {
  const record = await meta(id);
  if (!record) return { ok: false, reason: 'missing' };
  const db = await open();
  if (!db) return { ok: false, reason: 'unavailable' };
  let blob;
  try {
    blob = await wrap(tx(db, [STORE_BLOB], 'readonly').objectStore(STORE_BLOB).get(String(id)));
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (!blob) return { ok: false, reason: 'missing' };
  if (record.bytes && blob.size !== record.bytes) {
    return { ok: false, reason: 'size', expected: record.bytes, actual: blob.size };
  }
  return { ok: true, bytes: blob.size };
}

export async function meta(id) {
  const db = await open();
  if (!db) return null;
  try {
    return (await wrap(tx(db, [STORE_META], 'readonly').objectStore(STORE_META).get(String(id)))) || null;
  } catch {
    return null;
  }
}

export async function has(id) {
  return Boolean(await meta(id));
}

export async function list() {
  const db = await open();
  if (!db) return [];
  try {
    const rows = await wrap(tx(db, [STORE_META], 'readonly').objectStore(STORE_META).getAll());
    return (rows || []).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  } catch {
    return [];
  }
}

/** Bytes we are holding, plus what the browser says is available. */
export async function usage() {
  const rows = await list();
  const ours = rows.reduce((n, r) => n + (r.bytes || 0), 0);
  let quota = 0;
  let used = 0;
  try {
    const est = await navigator.storage?.estimate?.();
    quota = est?.quota || 0;
    used = est?.usage || 0;
  } catch {
    /* not supported */
  }
  return { count: rows.length, bytes: ours, quota, used };
}

/**
 * Ask the browser not to evict us under pressure. Without this, everything here
 * is "best effort" storage and can vanish silently — which for a download the
 * listener deliberately made is the wrong default.
 */
/** Whether the browser has already promised not to reclaim this data. */
export async function isPersisted() {
  try {
    return Boolean(await navigator.storage?.persisted?.());
  } catch {
    return false;
  }
}

export async function requestPersistence() {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return Boolean(await navigator.storage?.persist?.());
  } catch {
    return false;
  }
}

/* ------------------------------- object urls -------------------------------- */

const liveUrls = new Map();

/**
 * A playable url for a stored track, or null. Callers must call `release(id)`
 * when done — an object url pins its blob in memory until revoked.
 */
export async function objectUrl(id) {
  const key = String(id);
  if (liveUrls.has(key)) return liveUrls.get(key);

  const db = await open();
  if (!db) return null;
  let blob;
  try {
    blob = await wrap(tx(db, [STORE_BLOB], 'readonly').objectStore(STORE_BLOB).get(key));
  } catch {
    return null;
  }
  if (!blob) return null;

  const url = URL.createObjectURL(blob);
  liveUrls.set(key, url);
  return url;
}

export function release(id) {
  const key = String(id);
  const url = liveUrls.get(key);
  if (!url) return;
  URL.revokeObjectURL(url);
  liveUrls.delete(key);
}

export function releaseAllExcept(keepId) {
  for (const key of [...liveUrls.keys()]) {
    if (key !== String(keepId)) release(key);
  }
}

/* ---------------------------------- writes ---------------------------------- */

async function readPart(db, id) {
  try {
    return (await wrap(tx(db, [STORE_PART], 'readonly').objectStore(STORE_PART).get(String(id)))) || null;
  } catch {
    return null;
  }
}

async function writePart(db, id, blob) {
  try {
    const t = tx(db, [STORE_PART], 'readwrite');
    t.objectStore(STORE_PART).put(blob, String(id));
  } catch {
    /* a lost partial only costs progress */
  }
}

/**
 * fetch() needs CORS to read a response body, where an <audio> element does not.
 * So a url that plays perfectly well can be undownloadable, depending entirely
 * on whether that CDN sends the header. A failed direct attempt retries through
 * our own relay, which is same-origin — one extra hop, but it works everywhere
 * playback does.
 */
async function fetchAudio(url, signal, from = 0) {
  const relayable = /^https?:/i.test(url) && new URL(url, location.href).origin !== location.origin;
  const init = { signal };
  if (from > 0) init.headers = { range: `bytes=${from}-` };

  try {
    const res = await fetch(url, init);
    if (res.ok && res.body) return res;
    if (!relayable) throw new Error(`下载失败（${res.status}）`);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    if (!relayable) throw err;
  }

  const viaRelay = await fetch(`/api/stream?url=${encodeURIComponent(url)}`, init);
  if (!viaRelay.ok || !viaRelay.body) throw new Error(`下载失败（${viaRelay.status}）`);
  return viaRelay;
}

export async function save(song, { onProgress, signal, quota = FALLBACK_QUOTA_BYTES } = {}) {
  if (!available()) throw new Error('这个浏览器不支持离线存储');
  if (!song?.url) throw new Error('没有可下载的地址');

  const db = await open();
  if (!db) throw new Error('离线存储打不开');

  const id = String(song.id);

  /**
   * Resume where a previous attempt stopped. Backgrounding a PWA suspends the
   * read loop, and on iOS there is no background fetch to fall back on — so
   * rather than pretend otherwise, what arrived is kept and the next attempt
   * asks for the rest with a Range header. A server that ignores Range answers
   * 200 and the partial is discarded, which is correct rather than corrupt.
   */
  let carried = await readPart(db, id);
  let from = carried ? carried.size : 0;

  const res = await fetchAudio(song.url, signal, from);
  if (from > 0 && res.status !== 206) {
    carried = null;
    from = 0;
  }

  const declared = Number(res.headers.get('content-length')) || 0;
  const total = from > 0 ? from + declared : declared;
  if (total > MAX_TRACK_BYTES) {
    throw new Error(`这首 ${(total / 1048576).toFixed(0)} MB，超过单曲上限`);
  }

  // Make room before writing rather than after, so the ceiling is never
  // exceeded even briefly. 8 MB is the fallback when Content-Length is absent.
  const evicted = quota ? await evictTo(total || 8 * 1024 * 1024, quota) : [];

  const reader = res.body.getReader();

  // Chunks fold into disk-backed Blobs every few megabytes rather than piling up
  // in the JS heap. Holding a 100 MB master in the heap is enough to get a tab
  // killed on a phone.
  const parts = carried ? [carried] : [];
  let pending = [];
  let pendingBytes = 0;
  let received = from;

  const fold = () => {
    if (!pending.length) return;
    parts.push(new Blob(pending));
    pending = [];
    pendingBytes = 0;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending.push(value);
      pendingBytes += value.length;
      received += value.length;
      if (received > MAX_TRACK_BYTES) {
        reader.cancel().catch(() => {});
        throw new Error('文件超过单曲上限，已中止');
      }
      if (pendingBytes >= COALESCE_BYTES) fold();
      onProgress?.(received, total);
    }
    fold();
  } catch (err) {
    // Keep whatever arrived so the next attempt is shorter.
    fold();
    if (parts.length) await writePart(db, id, new Blob(parts));
    throw err;
  }

  if (total && received !== total) {
    // Not an error as far as fetch is concerned — the stream simply ended.
    // Stored, it would play for a while and stop dead with nothing explaining it.
    await writePart(db, id, new Blob(parts));
    throw new Error(`传输中断（${received} / ${total} 字节），下次会接着下`);
  }
  if (!received) throw new Error('没有收到任何数据');

  const blob = new Blob(parts, {
    type: res.headers.get('content-type') || song.type || 'application/octet-stream',
  });

  const record = {
    id,
    name: song.name || '',
    artist: song.artist || '',
    album: song.album || '',
    cover: song.cover || '',
    level: song.level || '',
    levelLabel: song.levelLabel || '',
    duration: song.duration ?? null,
    // No lyric snapshot. It was captured at download time and could belong to a
    // different cut of the song than the file; lyrics are fetched by id and
    // cached under the same key playback uses, which works offline just as well
    // and cannot drift.
    bytes: blob.size,
    type: blob.type,
    savedAt: Date.now(),
    lastPlayed: Date.now(),
  };

  await new Promise((resolve, reject) => {
    const t = tx(db, [STORE_BLOB, STORE_META, STORE_PART], 'readwrite');
    t.objectStore(STORE_BLOB).put(blob, record.id);
    t.objectStore(STORE_META).put(record);
    t.objectStore(STORE_PART).delete(record.id);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('存储被中止，可能是空间不足'));
  });

  return { ...record, evicted };
}

/** Bytes already carried for an unfinished download, for reporting. */
export async function partialSize(id) {
  const db = await open();
  if (!db) return 0;
  const part = await readPart(db, id);
  return part ? part.size : 0;
}

/**
 * Patch a stored record's metadata in place, leaving its audio alone.
 *
 * Waits for the transaction to commit. Returning as soon as `put` is queued
 * meant a caller could read back the old value and conclude the write had not
 * happened — which, in a caller that retries until the data looks right, is an
 * infinite loop.
 */
export async function amend(id, fields) {
  const record = await meta(id);
  if (!record) return false;
  const db = await open();
  if (!db) return false;
  try {
    await new Promise((resolve, reject) => {
      const t = tx(db, [STORE_META], 'readwrite');
      t.objectStore(STORE_META).put({ ...record, ...fields });
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
    return true;
  } catch {
    return false;
  }
}

/** Mark a track as just played, so eviction knows what is actually in use. */
export async function touch(id) {
  const record = await meta(id);
  if (!record) return;
  const db = await open();
  if (!db) return;
  try {
    const t = tx(db, [STORE_META], 'readwrite');
    t.objectStore(STORE_META).put({ ...record, lastPlayed: Date.now() });
  } catch {
    /* bookkeeping only */
  }
}

/**
 * Evict least-recently-played tracks until `headroom` more bytes would fit under
 * the ceiling. Without this the store grows until the browser starts refusing
 * writes, which surfaces as a download failing for no visible reason.
 */
export async function evictTo(headroom, quota = FALLBACK_QUOTA_BYTES) {
  const rows = await list();
  let total = rows.reduce((n, r) => n + (r.bytes || 0), 0);
  if (total + headroom <= quota) return [];

  // Oldest use first; savedAt stands in for tracks never played since download.
  const byAge = [...rows].sort(
    (a, b) => (a.lastPlayed || a.savedAt || 0) - (b.lastPlayed || b.savedAt || 0)
  );

  const dropped = [];
  for (const row of byAge) {
    if (total + headroom <= quota) break;
    await remove(row.id).catch(() => {});
    total -= row.bytes || 0;
    dropped.push(row);
  }
  return dropped;
}

/**
 * Drop anything whose blob no longer matches its recorded size. Cheap enough to
 * run at startup: IndexedDB hands back a Blob handle, and reading `.size` does
 * not pull its bytes into memory.
 */
export async function pruneCorrupt() {
  const rows = await list();
  const dropped = [];
  for (const row of rows) {
    const v = await verify(row.id).catch(() => ({ ok: false, reason: 'error' }));
    if (!v.ok) {
      await remove(row.id).catch(() => {});
      dropped.push({ id: row.id, name: row.name, reason: v.reason });
    }
  }
  return dropped;
}

/* --------------------------------- importing -------------------------------- */

const dec = (buf) => new TextDecoder('utf-8', { fatal: false }).decode(buf);

/**
 * Minimal ID3v2 reader: title, artist, album. Only the three frames worth
 * having, and only enough of the spec to find them.
 */
function readId3(bytes) {
  if (dec(bytes.subarray(0, 3)) !== 'ID3') return null;
  const major = bytes[3];
  const size = (bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9];
  const out = {};
  let at = 10;

  while (at + 10 <= Math.min(bytes.length, size + 10)) {
    const id = dec(bytes.subarray(at, at + 4));
    if (!/^[A-Z0-9]{4}$/.test(id)) break;

    const b = bytes.subarray(at + 4, at + 8);
    // v2.4 made frame sizes syncsafe too; v2.3 left them plain.
    const len =
      major >= 4
        ? (b[0] << 21) | (b[1] << 14) | (b[2] << 7) | b[3]
        : (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3];
    if (len <= 0 || at + 10 + len > bytes.length) break;

    const body = bytes.subarray(at + 10, at + 10 + len);
    const encoding = body[0];
    let text;
    if (encoding === 1 || encoding === 2) {
      text = new TextDecoder(encoding === 1 ? 'utf-16' : 'utf-16be', { fatal: false }).decode(
        body.subarray(1)
      );
    } else {
      text = dec(body.subarray(1));
    }
    text = text.replace(/\0+$/, '').trim();

    if (id === 'TIT2') out.name = text;
    else if (id === 'TPE1') out.artist = text;
    else if (id === 'TALB') out.album = text;

    at += 10 + len;
  }
  return out;
}

/** FLAC keeps tags in a VORBIS_COMMENT metadata block. */
function readFlac(bytes) {
  if (dec(bytes.subarray(0, 4)) !== 'fLaC') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 4;

  while (at + 4 <= bytes.length) {
    const header = bytes[at];
    const last = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const len = (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
    const start = at + 4;
    if (start + len > bytes.length) break;

    if (type === 4) {
      const out = {};
      let p = start;
      const vlen = view.getUint32(p, true);
      p += 4 + vlen;
      const count = view.getUint32(p, true);
      p += 4;
      for (let i = 0; i < count && p + 4 <= start + len; i++) {
        const clen = view.getUint32(p, true);
        p += 4;
        const [key, ...rest] = dec(bytes.subarray(p, p + clen)).split('=');
        const value = rest.join('=').trim();
        const k = key.toUpperCase();
        if (k === 'TITLE') out.name = value;
        else if (k === 'ARTIST') out.artist = value;
        else if (k === 'ALBUM') out.album = value;
        p += clen;
      }
      return out;
    }
    if (last) break;
    at = start + len;
  }
  return {};
}

/** "周杰伦 - 晴天.flac" is the most common shape when there are no tags at all. */
function fromFilename(filename) {
  const stem = filename.replace(/\.[^.]+$/, '').trim();
  const m = stem.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  return m ? { artist: m[1].trim(), name: m[2].trim() } : { name: stem };
}

/**
 * Take a file off the device and keep it like any other offline track.
 *
 * Only the first 256 KB is read for tags — enough for an ID3 header or a FLAC
 * comment block, and it avoids pulling a 40 MB file through the JS heap just to
 * learn its title.
 */
export async function importFile(file, { quota = FALLBACK_QUOTA_BYTES } = {}) {
  if (!available()) throw new Error('这个浏览器不支持离线存储');
  if (file.size > MAX_TRACK_BYTES) {
    throw new Error(`${file.name} 有 ${(file.size / 1048576).toFixed(0)} MB，超过单曲上限`);
  }

  const db = await open();
  if (!db) throw new Error('离线存储打不开');

  let tags = {};
  try {
    const head = new Uint8Array(await file.slice(0, 262144).arrayBuffer());
    tags = readId3(head) || readFlac(head) || {};
  } catch {
    tags = {};
  }
  const guessed = fromFilename(file.name);
  const evicted = quota ? await evictTo(file.size, quota) : [];

  const record = {
    // `local:` keeps imports from ever colliding with an upstream song id, and
    // marks them as the one kind of track that cannot be re-fetched if lost.
    id: `local:${crypto.randomUUID()}`,
    name: tags.name || guessed.name || file.name,
    artist: tags.artist || guessed.artist || '本地文件',
    album: tags.album || '',
    cover: '',
    level: '',
    levelLabel: (file.name.match(/\.(\w+)$/) || [, 'LOCAL'])[1].toUpperCase(),
    duration: null,
    bytes: file.size,
    type: file.type || 'application/octet-stream',
    local: true,
    savedAt: Date.now(),
    lastPlayed: Date.now(),
  };

  await new Promise((resolve, reject) => {
    const t = tx(db, [STORE_BLOB, STORE_META], 'readwrite');
    t.objectStore(STORE_BLOB).put(file, record.id);
    t.objectStore(STORE_META).put(record);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('存储被中止，可能是空间不足'));
  });

  return { ...record, evicted };
}

export async function remove(id) {
  const key = String(id);
  release(key);
  const db = await open();
  if (!db) return false;
  await new Promise((resolve, reject) => {
    const t = tx(db, [STORE_BLOB, STORE_META], 'readwrite');
    t.objectStore(STORE_BLOB).delete(key);
    t.objectStore(STORE_META).delete(key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
  return true;
}

export async function clear() {
  for (const key of [...liveUrls.keys()]) release(key);
  const db = await open();
  if (!db) return;
  await new Promise((resolve, reject) => {
    const t = tx(db, [STORE_BLOB, STORE_META], 'readwrite');
    t.objectStore(STORE_BLOB).clear();
    t.objectStore(STORE_META).clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
