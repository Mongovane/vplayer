/**
 * api.js — everything that leaves the tab.
 *
 * All requests are same-origin (/api/*) and land in the Pages Function, which
 * holds the upstream key. The browser no longer knows the upstream exists.
 *
 * Quality ladder mapped onto the Beaufort wind scale, because a player built
 * around a weather vane should measure its own fidelity in wind force.
 */

/**
 * The ladder as the upstream actually defines it. There is no `higher` level —
 * an earlier version of this list invented one, and requesting it would have
 * been silently coerced. NetEase accepts all seven; QQ and KuGou map onto a
 * shorter native ladder server-side (128k/320k/flac/hires/master).
 */
export const QUALITY = [
  { level: 'auto', bft: null, name: '自动', note: '按设备推荐：移动无损，桌面母带' },
  { level: 'standard', bft: 2, name: '轻风', note: '128 kbps · 流量最省' },
  { level: 'exhigh', bft: 5, name: '强风', note: '320 kbps · 兼容性最好' },
  { level: 'lossless', bft: 8, name: '大风', note: '48 kHz / 16 bit FLAC' },
  { level: 'hires', bft: 10, name: '狂风', note: '192 kHz / 24 bit FLAC' },
  { level: 'jyeffect', bft: 11, name: '暴风', note: '96 kHz / 24 bit 高清臻音' },
  { level: 'sky', bft: 11, name: '环流', note: '5.1 声道沉浸环绕声 · 由输出设备决定下混' },
  { level: 'jymaster', bft: 12, name: '飓风', note: '192 kHz / 24 bit 超清母带' },
];

const BY_LEVEL = new Map(QUALITY.map((q) => [q.level, q]));

/** Beaufort force for a level, for the little bar gauge next to the title. */
export function forceOf(level) {
  return BY_LEVEL.get(level)?.bft ?? null;
}

export function labelOf(level) {
  const q = BY_LEVEL.get(level);
  return q ? `bft ${q.bft ?? '—'} · ${q.name}` : level || '未知';
}

/**
 * `auto` resolves per device: phones and tablets get lossless (a 24/192 master
 * over cellular is a bad trade), desktops get the master.
 */
export function resolveQuality(level) {
  if (level !== 'auto') return level;
  const ua = navigator.userAgent;
  const mobile = /Android|iPhone|iPad|iPod|HarmonyOS|Windows Phone/i.test(ua) ||
    (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
  return mobile ? 'lossless' : 'jymaster';
}

/* ---------------------------------- fetch ---------------------------------- */

async function call(path, params = {}, { signal } = {}) {
  const url = new URL(`/api/${path}`, location.origin);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { signal, headers: { accept: 'application/json' } });

  // A 200 carrying HTML means the request never reached the Function and Pages
  // served the SPA shell instead — usually a _routes.json mistake. Say so here
  // rather than letting `null` surface as a property error three frames later.
  const body = await res.json().catch(() => null);
  if (body === null) {
    throw new Error(
      res.ok
        ? `/api/${path} 返回的不是 JSON —— 接口未生效，检查 _routes.json 与 Function 部署`
        : `请求失败（${res.status}）`
    );
  }
  if (!res.ok || body.ok === false) {
    throw new Error(body.error || `请求失败（${res.status}）`);
  }
  return body;
}

export const sourceOf = (id) => {
  const s = String(id ?? '');
  if (s.startsWith('qq:')) return 'qq';
  if (s.startsWith('kg:')) return 'kg';
  return '163';
};

export const SOURCE_NAME = { 163: 'NetEase', qq: 'QQ', kg: 'KuGou' };

/* -------------------------------- IndexedDB -------------------------------- */

const DB_NAME = 'vplayer';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ['playlists', 'lyrics']) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((err) => {
    console.warn('[api] IndexedDB unavailable, running without cache', err);
    return null;
  });
  return dbPromise;
}

async function cacheGet(store, key) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result?.value ?? null);
    req.onerror = () => resolve(null);
  });
}

async function cachePut(store, key, value) {
  const db = await openDb();
  if (!db) return;
  try {
    db.transaction(store, 'readwrite').objectStore(store).put({ key, value, at: Date.now() });
  } catch {
    /* cache writes are best effort */
  }
}

/* --------------------------------- endpoints -------------------------------- */

export function search(query, source, signal) {
  return call('search', { q: query, source }, { signal }).then((b) => b.items || []);
}

export function song(id, level, signal) {
  return call('song', { id, level: resolveQuality(level) }, { signal }).then((b) => b.song);
}

/**
 * Playlists are served cache-first and refreshed in the background, so a
 * returning listener sees their queue instantly. `onFresh` fires only when the
 * network copy differs from what was handed back synchronously.
 */
export async function playlist(id, { onFresh } = {}) {
  const key = `pl:${id}`;
  const cached = await cacheGet('playlists', key);

  const network = call('playlist', { id })
    .then((b) => b.playlist)
    .then((fresh) => {
      cachePut('playlists', key, fresh);
      if (cached && onFresh && fresh.tracks.length !== cached.tracks.length) onFresh(fresh);
      return fresh;
    });

  if (cached) {
    network.catch(() => {}); // background refresh must not surface as unhandled
    return cached;
  }
  return network;
}

export async function lyrics(id) {
  const key = `ly:${id}`;
  const cached = await cacheGet('lyrics', key);
  if (cached) return cached;
  const body = await call('lyric', { id });
  const parsed = parseLyrics(body.lrc, body.tlrc, body.rlrc);
  cachePut('lyrics', key, parsed);
  return parsed;
}

/** Covers go through the relay so the canvas stays untainted for colour lifting. */
export function coverUrl(url, size = 220) {
  if (!url) return '';
  const direct = /music\.126\.net/.test(url) ? `${url}?param=${size}y${size}` : url;
  return `/api/image?url=${encodeURIComponent(direct)}`;
}

/* ---------------------------------- lyrics --------------------------------- */

const LRC_LINE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

function parseLrc(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const words = raw.replace(LRC_LINE, '').trim();
    LRC_LINE.lastIndex = 0;
    let m;
    while ((m = LRC_LINE.exec(raw)) !== null) {
      const frac = m[3] ? Number(`0.${m[3]}`) : 0;
      out.push({ time: Number(m[1]) * 60 + Number(m[2]) + frac, words });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

/**
 * Merge the original, its translation, and its romanisation into one timeline.
 * Side tracks are matched by timestamp within 40 ms rather than by line index,
 * because upstream LRC, TLRC and ROMALRC routinely disagree on how many blank
 * lines they carry — matching by index drifts a verse in and never recovers.
 */
export function parseLyrics(lrc, tlrc, rlrc) {
  const main = parseLrc(lrc).filter((l) => l.words);
  if (!main.length) return [];

  const align = (text) => {
    const side = parseLrc(text).filter((l) => l.words);
    if (!side.length) return () => '';
    return (line) => {
      const hit = side.find((t) => Math.abs(t.time - line.time) < 0.04);
      return hit && hit.words !== line.words ? hit.words : '';
    };
  };

  const trans = align(tlrc);
  const roma = align(rlrc);
  return main.map((line) => ({ ...line, trans: trans(line), roma: roma(line) }));
}

/** Index of the line active at `time`; -1 before the first line. */
export function lyricIndexAt(lines, time) {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= time) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/* ----------------------------- playlist ingestion --------------------------- */

/** Pull a numeric playlist id out of a share blob, url, or bare id. */
export function extractPlaylistId(raw) {
  const s = String(raw || '').trim();
  if (/^\d{5,}$/.test(s)) return s;
  const m = s.match(/playlist(?:\?|\/|%3F)(?:id=)?(\d{5,})/i) || s.match(/[?&]id=(\d{5,})/);
  return m ? m[1] : null;
}

/**
 * Normalise anything a user might drop on us: a bare array, `{tracks}`,
 * `{data:{tracks}}`, or a legacy `playlist.js` that assigns
 * `window.LOCAL_PLAYLIST`. Every field is treated as untrusted text.
 */
export function normalizeImport(text) {
  let data = null;
  const trimmed = String(text || '').trim();

  try {
    data = JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/LOCAL_PLAYLIST\s*=\s*([[{][\s\S]*?)(?:;\s*)?$/);
    if (m) {
      try {
        data = JSON.parse(m[1]);
      } catch {
        data = null;
      }
    }
  }
  if (!data) throw new Error('无法解析这个文件，需要 JSON 数组或旧版 playlist.js');

  const rows = Array.isArray(data)
    ? data
    : data.tracks || data.data?.tracks || data.songs || data.data?.songs || [];
  if (!Array.isArray(rows) || !rows.length) throw new Error('文件里没有找到歌曲');

  const tracks = rows
    .map((t) => ({
      id: t.id ?? t.songId ?? null,
      name: String(t.name ?? t.title ?? '未知歌曲'),
      artist: String(
        Array.isArray(t.artists) ? t.artists.map((a) => a.name ?? a).join(', ') : t.artists ?? t.artist ?? '未知艺术家'
      ),
      album: String(typeof t.album === 'string' ? t.album : t.album?.name ?? ''),
      cover: String(t.picUrl ?? t.cover ?? t.album?.picUrl ?? ''),
    }))
    .filter((t) => t.id !== null && t.id !== '');

  if (!tracks.length) throw new Error('歌曲都缺少 id，没法播放');
  return { name: String(data.title ?? data.name ?? '导入的歌单'), tracks };
}

/* ----------------------------------- sync ---------------------------------- */

/**
 * Cloud playlists. The wire protocol is unchanged from the previous build —
 * six-character short ids, `version`/`baseVersion` optimistic concurrency, a
 * local mirror with local/dirty/cloud/public states — so existing accounts and
 * shared links keep working. Only the transport moved to /api/sync/*.
 */
const TOKEN_KEY = 'vplayer:token';

export const cloud = {
  token: localStorage.getItem(TOKEN_KEY) || '',

  get authed() {
    return Boolean(this.token);
  },

  async req(path, { method = 'GET', body } = {}) {
    const headers = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body) headers['content-type'] = 'application/json';
    const res = await fetch(`/api/sync${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (res.status === 409) {
      const err = new Error('云端有更新的版本');
      err.conflict = data;
      throw err;
    }
    if (!res.ok) throw new Error(data?.error || data?.message || `同步失败（${res.status}）`);
    return data;
  },

  setToken(token) {
    this.token = token || '';
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  },

  async login(username, password) {
    const d = await this.req('/auth/login', { method: 'POST', body: { username, password } });
    this.setToken(d.token);
    return d.user;
  },

  async register(username, password, inviteCode) {
    const d = await this.req('/auth/register', {
      method: 'POST',
      body: { username, password, inviteCode },
    });
    this.setToken(d.token);
    return d.user;
  },

  logout() {
    this.setToken('');
  },

  me() {
    return this.req('/auth/me').then((d) => d.user);
  },

  list() {
    return this.req('/playlists').then((d) => d.playlists || []);
  },

  detail(id) {
    return this.req(`/playlists/${id}`).then((d) => d.playlist);
  },

  create(name, tracks) {
    return this.req('/playlists', { method: 'POST', body: { name, tracks } }).then((d) => d.playlist);
  },

  update(id, patch, baseVersion) {
    return this.req(`/playlists/${id}`, { method: 'PATCH', body: { ...patch, baseVersion } });
  },
};
