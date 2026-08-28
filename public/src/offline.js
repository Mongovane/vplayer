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
const DB_VERSION = 1;
const STORE_BLOB = 'blobs';
const STORE_META = 'meta';

/** Refuse to start on anything implausible for one song. */
const MAX_TRACK_BYTES = 120 * 1024 * 1024;

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

/**
 * Download a resolved track and keep it.
 *
 * Progress is read from the response stream rather than from an XHR event,
 * which means it works for the streamed relay too. `onProgress` gets
 * (receivedBytes, totalBytes|0) — total is 0 when the source omits
 * Content-Length, which the relay sometimes does.
 */
export async function save(song, { onProgress, signal } = {}) {
  if (!available()) throw new Error('这个浏览器不支持离线存储');
  if (!song?.url) throw new Error('没有可下载的地址');

  const db = await open();
  if (!db) throw new Error('离线存储打不开');

  const res = await fetch(song.url, { signal });
  if (!res.ok || !res.body) throw new Error(`下载失败（${res.status}）`);

  const total = Number(res.headers.get('content-length')) || 0;
  if (total > MAX_TRACK_BYTES) {
    throw new Error(`这首 ${(total / 1048576).toFixed(0)} MB，超过单曲上限`);
  }

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (received > MAX_TRACK_BYTES) {
      reader.cancel().catch(() => {});
      throw new Error('文件超过单曲上限，已中止');
    }
    onProgress?.(received, total);
  }

  const blob = new Blob(chunks, {
    type: res.headers.get('content-type') || 'application/octet-stream',
  });

  const record = {
    id: String(song.id),
    name: song.name || '',
    artist: song.artist || '',
    album: song.album || '',
    cover: song.cover || '',
    level: song.level || '',
    levelLabel: song.levelLabel || '',
    duration: song.duration ?? null,
    lyric: song.lyric || '',
    bytes: blob.size,
    type: blob.type,
    savedAt: Date.now(),
  };

  await new Promise((resolve, reject) => {
    const t = tx(db, [STORE_BLOB, STORE_META], 'readwrite');
    t.objectStore(STORE_BLOB).put(blob, record.id);
    t.objectStore(STORE_META).put(record);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('存储被中止，可能是空间不足'));
  });

  return record;
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
