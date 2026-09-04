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
/** Rough bytes per minute, for showing what a download will actually cost. */
const MEMBER_TOKEN_KEY = 'vane.memberToken';

export function memberToken() {
  try { return localStorage.getItem(MEMBER_TOKEN_KEY) || ''; } catch { return ''; }
}
export function setMemberToken(token) {
  try {
    if (token) localStorage.setItem(MEMBER_TOKEN_KEY, token);
    else localStorage.removeItem(MEMBER_TOKEN_KEY);
  } catch {}
}
/** Authorization header for the current member, or {} when signed out. */
function authHeaders() {
  const t = memberToken();
  return t ? { authorization: `Bearer ${t}` } : {};
}
/** Append ?token= to a URL for tags that can't send headers (audio/img). */
/** True if the URL is a same-origin /api/ endpoint (absolute or relative). */
export function isApiUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url, location.origin);
    return u.origin === location.origin && u.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

export function withToken(url) {
  const t = memberToken();
  if (!t || !isApiUrl(url)) return url;
  const u = new URL(url, location.origin);
  u.searchParams.set('token', t);
  return u.pathname + u.search;
}

export const BYTES_PER_MIN = {
  standard: 0.96e6,
  exhigh: 2.4e6,
  lossless: 10.6e6,
  hires: 34e6,
  jyeffect: 26e6,
  sky: 26e6,
  jymaster: 34e6,
};

export const QUALITY = [
  { level: 'auto', bft: null, name: '自动', note: '按设备推荐：移动无损，桌面母带' },
  { level: 'standard', bft: 2, name: '轻风', note: '128 kbps · 流量最省' },
  { level: 'exhigh', bft: 5, name: '强风', note: '320 kbps · 兼容性最好' },
  { level: 'lossless', bft: 8, name: '大风', note: '48 kHz / 16 bit 无损' },
  { level: 'hires', bft: 10, name: '狂风', note: '192 kHz / 24 bit 高解析' },
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

// The app registers a callback here; when any request comes back 401 (token
// missing, expired, or revoked by the owner) we invoke it so the UI can show
// the login gate instead of leaving the user staring at silent failures.
let onUnauthorized = null;
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function call(path, params = {}, { signal } = {}) {
  const url = new URL(`/api/${path}`, location.origin);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { signal, headers: { accept: 'application/json', ...authHeaders() } });

  if (res.status === 401 && onUnauthorized) onUnauthorized();

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

export function song(id, level, signal, resolver, rotate) {
  return call(
    'song',
    {
      id,
      level: resolveQuality(level),
      via: resolver === 'lx' ? 'lx' : undefined,
      rotate: rotate ? String(rotate) : undefined,
    },
    { signal }
  ).then((b) => b.song);
}

/** Config only — no upstream probe, so this is free to call on every load. */
export function health() {
  return call('health');
}

/** Test which fallback backends are alive. */
export function lxTest(id, level) {
  return call('lxtest', { id, level });
}

/* ---------------------------- server-side library --------------------------- */

export function library() {
  return call('library');
}

/** Copy a track into R2 so its url stops expiring. */
export async function libraryIngest(id, level, rotate, meta) {
  const url = new URL(`/api/library/${encodeURIComponent(id)}`, location.origin);
  if (level) url.searchParams.set('level', resolveQuality(level));
  if (rotate) url.searchParams.set('rotate', String(rotate));
  // Send the metadata the client already knows (name/artist/cover). The
  // fallback resolver returns only a url, so without this a track ingested via
  // the backup source lands in the library with an empty name → "未知歌曲".
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: meta ? JSON.stringify(meta) : undefined,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.ok === false) throw new Error(body?.error || `入库失败（${res.status}）`);
  return body;
}

export async function libraryRemove(id) {
  const res = await fetch(`/api/library/${encodeURIComponent(id)}`, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) throw new Error(`删除失败（${res.status}）`);
  return res.json();
}

export async function libraryPrune() {
  const res = await fetch('/api/library/prune', { method: 'POST', headers: authHeaders() });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.ok === false) throw new Error(body?.error || '清理失败');
  return body;
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

export async function lyrics(id, meta) {
  // Imported files have no upstream identity; asking for one returns whatever
  // the endpoint makes of a nonsense id, which is how lyrics end up belonging to
  // a different song than the audio.
  if (String(id).startsWith('local:')) return [];

  const key = `ly:${id}`;
  const cached = await cacheGet('lyrics', key);
  // An empty result is not worth remembering. Caching one meant a track whose
  // lyrics were briefly unavailable — a QQ resolve that came back without them,
  // an upstream blip — never showed lyrics again, because the empty array kept
  // winning long after the endpoint recovered.
  if (cached?.length) return cached;

  // Primary: the track's own id.
  try {
    const body = await call('lyric', { id });
    const parsed = parseLyrics(body.lrc, body.tlrc, body.rlrc);
    if (parsed.length) { cachePut('lyrics', key, parsed); return parsed; }
  } catch {}

  // Fallback: if the primary source had no lyrics and we know the song's name
  // and artist, search other sources for the same song and try their lyrics.
  // A song missing lyrics on QQ often has them on NetEase and vice versa.
  if (meta?.name) {
    const term = meta.artist ? `${meta.name} ${meta.artist}` : meta.name;
    for (const src of ['163', 'qq', 'kugou']) {
      // Skip the source the id already belongs to.
      if (String(id).startsWith(src === '163' ? 'wy' : src)) continue;
      try {
        const found = await search(term, src);
        const hit = found.find((r) => r.name === meta.name) || found[0];
        if (!hit) continue;
        const body = await call('lyric', { id: hit.id });
        const parsed = parseLyrics(body.lrc, body.tlrc, body.rlrc);
        if (parsed.length) { cachePut('lyrics', key, parsed); return parsed; }
      } catch {}
    }
  }

  return [];
}

/** Covers go through the relay so the canvas stays untainted for colour lifting. */
export function coverUrl(url, size = 220) {
  if (!url) return '';
  const direct = /music\.126\.net/.test(url) ? `${url}?param=${size}y${size}` : url;
  return withToken(`/api/image?url=${encodeURIComponent(direct)}`);
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

/* ------------------------------- membership -------------------------------- */
// Multi-user access. The token lives in localStorage and is sent as a Bearer
// header on member requests. With no token, none of this is used and VPlayer is
// the single-user app it always was.

async function memberCall(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api/members/${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `请求失败（${res.status}）`);
  return data;
}

/** Redeem an invite code → stores the token, returns the member. */
export async function joinWithInvite(code, name) {
  const data = await memberCall('redeem', { method: 'POST', body: { code, name } });
  if (data.member?.token) setMemberToken(data.member.token);
  return data.member;
}

/** Owner bootstrap with the secret → stores the token. */
export async function bootstrapOwner(secret, name) {
  const data = await memberCall('bootstrap', { method: 'POST', body: { secret, name } });
  if (data.member?.token) setMemberToken(data.member.token);
  return data.member;
}

export async function whoAmI() {
  if (!memberToken()) return null;
  try { return (await memberCall('me')).member; } catch { return null; }
}

export function memberFavorites() {
  return memberCall('favorites').then((d) => d.favorites || []);
}
export function saveMemberFavorites(favorites) {
  return memberCall('favorites', { method: 'PUT', body: { favorites } });
}

export function createInvite(opts) {
  return memberCall('invites', { method: 'POST', body: opts }).then((d) => d.invite);
}
export function listInvites() {
  return memberCall('invites').then((d) => d.invites || []);
}
export function listMembers() {
  return memberCall('list').then((d) => d.members || []);
}
export function removeMember(memberId) {
  return memberCall('remove', { method: 'POST', body: { memberId } });
}

/** Backfill metadata onto nameless cloud-library rows from the given tracks. */
export async function libraryRepair(tracks) {
  const res = await fetch('/api/library/repair', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ tracks }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.ok === false) throw new Error(body?.error || `修复失败（${res.status}）`);
  return body;
}

/** Delete cloud-library rows that still have no name after a repair. */
export async function libraryPurge() {
  const res = await fetch('/api/library/purge', { method: 'POST', headers: authHeaders() });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.ok === false) throw new Error(body?.error || `清理失败（${res.status}）`);
  return body;
}
