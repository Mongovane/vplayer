/**
 * /api/* — Cloudflare Pages Function
 *
 * Field mappings below follow the published ChKSz API contract
 * (https://api.chksz.com/docs/*.html), verified endpoint by endpoint. An
 * earlier version of this file inherited its QQ and KuGou mappings from the
 * original CPlayer build without checking them, and every one of them was
 * wrong — see docs/upstream-api.md for the before/after.
 *
 * The browser only ever talks to this origin. env.MUSIC_API_KEY is a Pages
 * secret, attached here and never shipped to the client.
 */

import {
  libraryReady,
  findTrack,
  listTracks,
  touchTrack,
  removeTrack,
  evictTo,
  ingestTrack,
  serveTrack,
  trackAsSong,
} from './_library.js';

const MUSIC_UPSTREAM = 'https://api.chksz.com/api';

/**
 * Fallback resolver: an lx-music-api-server instance, the backend the
 * LX-source scripts talk to (github.com/lxmusics/lx-music-api-server).
 *
 *   GET {LX_API_URL}/url/{source}/{songId}/{quality}
 *   X-Request-Key: {LX_API_KEY}
 *   -> { code: 0, data: "<playable url>" }
 *
 * It returns a URL and nothing else — no search, no metadata, no lyrics — so it
 * can only ever be a second opinion on playback, never a source in its own
 * right. Both values are Pages secrets; when either is missing the whole
 * fallback path is inert and the client hides its switch.
 */
const LX_SOURCE = { 163: 'wy', qq: 'tx', kg: 'kg', kw: 'kw', mg: 'mg' };

const LX_QUALITY = {
  standard: '128k',
  exhigh: '320k',
  lossless: 'flac',
  hires: 'flac24bit',
  jyeffect: 'flac24bit',
  sky: 'flac24bit',
  jymaster: 'flac24bit',
};

/** Error codes across lx-style backends (lx-api-server 1-6, ikun/juhe 4xx-5xx). */
const LX_CODES = {
  1: 'IP 被上游封禁',
  2: '备用源没有这首歌的地址',
  4: '备用源的远程服务器出错',
  5: '请求过于频繁，缓一下',
  6: '请求参数有误',
  403: '备用源 Key 失效或鉴权失败',
  429: '请求过于频繁，缓一下',
  500: '备用源的远程服务器出错',
};

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
}

function fail(message, status = 502) {
  return json({ ok: false, error: message }, status);
}

function upstream(env, path, params = {}) {
  const url = new URL(MUSIC_UPSTREAM + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  if (env.MUSIC_API_KEY) url.searchParams.set('apikey', env.MUSIC_API_KEY);
  return url.toString();
}

async function getJson(env, path, params, signal) {
  const res = await fetch(upstream(env, path, params), {
    signal,
    headers: { accept: 'application/json' },
    cf: { cacheTtl: 0 },
  });

  if (!res.ok) {
    // 401/403 has two causes fixed in completely different places: no key was
    // attached, or the key was rejected. Say which. The key is never echoed.
    const keyed = Boolean(env.MUSIC_API_KEY);
    let reason = '';
    try {
      reason = (await res.text()).slice(0, 200).replace(/\s+/g, ' ').trim();
    } catch {
      /* body unreadable */
    }
    if (res.status === 401 || res.status === 403) {
      const authErr = new Error(
        keyed
          ? `上游拒绝 ${path}（${res.status}）：已附带 MUSIC_API_KEY，但被判定无效或过期${reason ? ' · ' + reason : ''}`
          : `上游拒绝 ${path}（${res.status}）：未配置 MUSIC_API_KEY${reason ? ' · ' + reason : ''}`
      );
      authErr.upstreamCode = res.status;
      throw authErr;
    }
    const httpErr = new Error(`上游 ${path} 返回 ${res.status}${reason ? ' · ' + reason : ''}`);
    // The upstream signals "no match" with an HTTP 404, not only with an
    // in-band code. Carrying the status here is what lets searchOrEmpty tell a
    // fruitless search apart from a broken one.
    httpErr.upstreamCode = res.status;
    throw httpErr;
  }

  const body = await res.json();
  // qq/kugou report failures in-band: HTTP 200 with a non-200 `code`.
  if (body && typeof body.code === 'number' && body.code !== 200) {
    const err = new Error(`上游 ${path}：${body.msg || `code ${body.code}`}`);
    err.upstreamCode = body.code;
    throw err;
  }
  return body;
}

const https = (u) => String(u || '').replace(/^http:/, 'https:');

/* ------------------------------- quality ladder ----------------------------- */

/**
 * NetEase takes `level`; QQ and KuGou take `size` from a shorter ladder. The
 * client speaks one vocabulary (NetEase's) and this maps it outward.
 *
 * The docs are explicit that QQ and KuGou do **no** alias or downgrade mapping
 * server-side: ask for `master` on a track that has none and the request
 * fails rather than quietly returning 128k.
 */
const LEVEL_TO_SIZE = {
  standard: '128k',
  exhigh: '320k',
  lossless: 'flac',
  hires: 'hires',
  jyeffect: 'master',
  sky: 'master',
  jymaster: 'master',
};

const SIZE_TO_LEVEL = {
  '128k': 'standard',
  '320k': 'exhigh',
  flac: 'lossless',
  hires: 'hires',
  master: 'jymaster',
};

const NETEASE_LEVELS = new Set(Object.keys(LEVEL_TO_SIZE));

/**
 * The fallback resolver pool. Every entry is an lx-style HTTP backend that takes
 * {source, songId, quality} and returns a playback url. These are all HTTP
 * proxies — the .js source scripts do no local decryption, they just forward to
 * these servers, so the Worker calls them directly with no sandbox.
 *
 * Endpoints and keys are extracted from the public scripts at
 * github.com/pdone/lx-music-source. They are community-shared and rate-limited;
 * pooling several and rotating between them is what makes bulk resolution
 * survivable. Availability changes over time — a backend that 403s or times out
 * is skipped and the next is tried.
 *
 * "style" selects the URL shape:
 *   - "path":  {base}/url/{source}/{songId}/{quality}   (lx-api-server, huibq)
 *   - "query": {base}/url?source=&songId=&quality=      (ikun)
 *   - "post":  POST {base}/{source}  body {songmid,quality}  (juhe)
 */
const LX_POOL = [
  { name: 'huibq', base: 'https://lxmusicapi.onrender.com', key: 'share-v3', style: 'path' },
  { name: 'ikun', base: 'https://api.ikunshare.com', key: '', style: 'query' },
  { name: 'juhe', base: 'https://api.music.lerd.dpdns.org', key: '', style: 'juhe' },
  // flower & grass: prefix goes BEFORE /url, and each request carries a "tag"
  // header = hex(JSON.stringify([songId, quality], null, 1)). No md5, no key.
  { name: 'flower', base: 'http://97.64.37.235', key: '', style: 'path', prefix: '/flower/v1', sign: 'tag' },
  { name: 'grass', base: 'http://97.64.37.235', key: '', style: 'path', prefix: '/grass/v1', sign: 'tag' },
];

/**
 * Build the effective pool: the custom LX_API_URL (if configured) first, then
 * the built-in community backends unless LX_POOL_DISABLE_BUILTIN is set. A
 * comma-separated LX_POOL env value can override the whole thing, each entry
 * "name|base|key|style".
 */
function lxPool(env) {
  const pool = [];
  if (env.LX_API_URL && env.LX_API_KEY) {
    pool.push({
      name: 'custom',
      base: String(env.LX_API_URL).replace(/\/+$/, ''),
      key: env.LX_API_KEY,
      style: String(env.LX_API_STYLE || 'path').toLowerCase(),
    });
  }
  if (env.LX_POOL) {
    for (const raw of String(env.LX_POOL).split(',')) {
      const [name, base, key = '', style = 'path'] = raw.split('|').map((v) => v.trim());
      if (base) pool.push({ name: name || base, base: base.replace(/\/+$/, ''), key, style });
    }
  } else if (env.LX_POOL_DISABLE_BUILTIN !== '1') {
    pool.push(...LX_POOL);
  }
  return pool;
}

const lxConfigured = (env) => lxPool(env).length > 0;

/** Pull the url out of whatever shape a backend returns. */
function extractLxUrl(body) {
  if (!body) return '';
  const code = Number(body.code);
  const ok = code === 0 || code === 200 || Number.isNaN(code);
  if (!ok) {
    const msg = LX_CODES[code] || body.msg || body.message || `code ${body.code}`;
    throw new Error(msg);
  }
  const candidates = [body.data, body.url, body.data?.url, body.data?.data];
  for (const c of candidates) {
    if (typeof c === 'string' && /^https?:/.test(c)) return c;
  }
  return '';
}

/** Ask one backend for a url. Throws on failure so the caller can try the next. */
async function askLxBackend(backend, src, songId, quality, signal) {
  const headers = {
    'content-type': 'application/json',
    'user-agent': 'lx-music-desktop/2.0.0',
  };
  // ikun sends an empty key header explicitly; others send their key or none.
  if (backend.key !== undefined) headers['x-request-key'] = backend.key;
  // flower/grass carry a "tag" header = hex(JSON.stringify([songId, quality], null, 1)).
  // Their music request sends ONLY these three headers — content-type or a
  // request key trips the server's 403 filter, so build a clean header set.
  if (backend.sign === 'tag') {
    const tagStr = JSON.stringify([songId, quality], null, 1);
    const tagHex = [...new TextEncoder().encode(tagStr)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const res = await fetch(
      `${backend.base}${backend.prefix || ''}/url/${src}/${encodeURIComponent(songId)}/${quality}`,
      {
        signal,
        headers: { 'user-agent': 'lx-music/desktop', ver: '2.0.0', tag: tagHex },
      }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`${backend.name} 返回 ${res.status}${detail ? ': ' + detail.slice(0, 80) : ''}`);
    }
    const body = await res.json().catch(() => null);
    const url = extractLxUrl(body);
    if (!url) throw new Error(`${backend.name} 没有返回地址`);
    return url;
  }

  const prefix = backend.prefix || '';
  let res;

  if (backend.style === 'juhe') {
    // POST {base}/{src} with body { source, type, musicInfo }. The script sends
    // just {type, musicInfo}, but including source too is harmless and some
    // backend variants validate it.
    res = await fetch(`${backend.base}/${src}`, {
      method: 'POST',
      signal,
      headers,
      body: JSON.stringify({ source: src, type: quality, musicInfo: { songmid: songId, hash: songId, copyrightId: songId } }),
    });
  } else if (backend.style === 'query') {
    res = await fetch(
      `${backend.base}${prefix}/url?source=${encodeURIComponent(src)}&songId=${encodeURIComponent(songId)}&quality=${encodeURIComponent(quality)}`,
      { signal, headers }
    );
  } else {
    // path: {base}{prefix}/url/{src}/{songId}/{quality}
    res = await fetch(
      `${backend.base}${prefix}/url/${src}/${encodeURIComponent(songId)}/${quality}`,
      { signal, headers }
    );
  }

  if (!res.ok) throw new Error(`${backend.name} 返回 ${res.status}`);
  const body = await res.json().catch(() => null);
  const url = extractLxUrl(body);
  if (!url) throw new Error(`${backend.name} 没有返回地址`);
  return url;
}

/**
 * Resolve a playback url through the fallback pool. Rotates through every
 * backend until one returns a url. `startAt` lets a batch caller stagger which
 * backend each chunk starts from, spreading load so no single community key
 * gets hammered. Metadata stays whatever the search result already had.
 */
async function resolveViaLx(env, origin, id, level, signal, startAt = 0) {
  const pool = lxPool(env);
  if (!pool.length) throw new Error('未配置备用源');

  const src = LX_SOURCE[sourceOf(id)];
  if (!src) throw new Error('备用源不支持这个来源');
  const quality = LX_QUALITY[level] || 'flac';
  const songId = bare(id);

  let lastErr;
  for (let i = 0; i < pool.length; i++) {
    const backend = pool[(startAt + i) % pool.length];
    try {
      const url = await askLxBackend(backend, src, songId, quality, signal);
      return {
        id,
        url: url.startsWith('http://') ? `${origin}/api/stream?url=${encodeURIComponent(url)}` : https(url),
        name: null,
        artist: null,
        album: null,
        cover: null,
        source: 'LX',
        level: quality === 'flac24bit' ? 'hires' : quality === 'flac' ? 'lossless' : quality === '320k' ? 'exhigh' : 'standard',
        levelLabel: `${quality.toUpperCase()} · ${backend.name}`,
        duration: null,
        lyric: '',
        via: 'lx',
        backend: backend.name,
      };
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      lastErr = err;
    }
  }
  throw lastErr || new Error('所有备用源都没有返回地址');
}

/**
 * Descending ladder for QQ and KuGou. The upstream does no downgrade mapping,
 * so asking for `master` on a track that only has 320k simply fails. NetEase
 * degrades silently on our behalf; these two do not, so we walk the ladder
 * ourselves rather than surfacing a failure the listener can't act on.
 */
const SIZE_LADDER = ['master', 'hires', 'flac', '320k', '128k'];

async function resolveWithDowngrade(env, path, params, size, signal) {
  const start = Math.max(0, SIZE_LADDER.indexOf(size));
  let lastError = null;
  for (const candidate of SIZE_LADDER.slice(start)) {
    try {
      const d = await getJson(env, path, { ...params, size: candidate }, signal);
      if (d?.url) return { detail: d, size: candidate, downgraded: candidate !== size };
      lastError = new Error(`${path} 在 ${candidate} 下未返回地址`);
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      lastError = err;
    }
  }
  throw lastError || new Error(`${path} 无可用音源`);
}

/* ------------------------------ source dispatch ----------------------------- */

function sourceOf(id) {
  const s = String(id || '');
  if (s.startsWith('qq:')) return 'qq';
  if (s.startsWith('kg:')) return 'kg';
  return '163';
}
const bare = (id) => String(id || '').replace(/^(qq|kg):/, '');

/** "3:28" → 208. QQ and KuGou report duration this way on the detail endpoint. */
function intervalToSeconds(interval) {
  const m = String(interval || '').match(/^(\d+):(\d{1,2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/* ---------------------------------- search ---------------------------------- */

/**
 * A search that finds nothing is an answer, not an error. The upstream signals
 * it with code 404 / "未找到匹配的歌曲", which as an exception would surface to
 * the listener as though the player were broken. Anything else — 503 circuit
 * breaker, 401, timeouts — still throws, because those are worth reporting.
 */
async function searchOrEmpty(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err?.upstreamCode === 404) return [];
    throw err;
  }
}

async function search(env, q, source, { limit = 30, offset = 0 } = {}, signal) {
  if (source === 'qq') {
    // { code, msg, count, list: [{ n, name, singer, album, pay, mid }] }
    // No artwork in the search payload; covers only arrive on resolve.
    return searchOrEmpty(async () => {
    const d = await getJson(env, '/qq_music', { msg: q, num: Math.min(limit, 50) }, signal);
    return (Array.isArray(d.list) ? d.list : []).map((it) => ({
      id: `qq:${it.mid}`,
      name: it.name || '未知歌曲',
      artist: it.singer || '未知艺术家',
      album: it.album || '',
      cover: '',
      source: 'QQ',
    }));
    });
  }

  if (source === 'kg') {
    // { code, msg, keyword, total, list: [{ n, id, name, singer, album, duration }] }
    return searchOrEmpty(async () => {
    const d = await getJson(env, '/kugou_music', { msg: q }, signal);
    return (Array.isArray(d.list) ? d.list : []).slice(0, limit).map((it) => ({
      id: `kg:${it.id}`,
      name: it.name || '未知歌曲',
      artist: it.singer || '未知艺术家',
      album: it.album || '',
      cover: '',
      source: 'KuGou',
      duration: it.duration ?? null,
    }));
    });
  }

  // Documented as { code, msg, data: [{ id, name, artists, album, picUrl }] },
  // but the live endpoint has also been observed returning the songs under
  // `data.songs` and `result.songs`. Probe all three: trusting the documented
  // shape alone silently returns an empty list when the endpoint drifts, which
  // is indistinguishable from "no matches" at the UI.
  const d = await getJson(env, '/163_search', { keyword: q, limit, offset }, signal);
  const items = Array.isArray(d.data)
    ? d.data
    : Array.isArray(d.data?.songs)
      ? d.data.songs
      : Array.isArray(d.result?.songs)
        ? d.result.songs
        : Array.isArray(d.songs)
          ? d.songs
          : [];
  return items.map((it) => ({
    id: it.id,
    name: it.name || '未知歌曲',
    // Joined string in the documented shape, array of objects in the raw ones.
    artist: Array.isArray(it.artists)
      ? it.artists.map((a) => a.name ?? a).filter(Boolean).join(', ')
      : Array.isArray(it.ar)
        ? it.ar.map((a) => a.name ?? a).filter(Boolean).join(', ')
        : it.artists || it.artist || '未知艺术家',
    album: typeof it.album === 'string' ? it.album : it.album?.name || it.al?.name || '',
    cover: https(it.picUrl || it.album?.picUrl || it.al?.picUrl),
    source: 'NetEase',
  }));
}

/* ----------------------------------- song ----------------------------------- */

/** QQ and KuGou share one flat detail shape; only the id field differs. */
function normalizeNativeDetail(d, { source, id, requestedSize, origin, downgraded = false }) {
  const format = String(d.format || d.bitrate || requestedSize || '').toLowerCase();
  const url = String(d.url || '');

  return {
    id,
    // The docs show https CDN urls, but KuGou has historically served http with
    // an invalid certificate. Relay only when it actually needs relaying — a
    // direct https url streams faster and doesn't spend Worker time.
    url: url.startsWith('http://') ? `${origin}/api/stream?url=${encodeURIComponent(url)}` : https(url),
    // Null, not a placeholder. QQ's resolve response omits name, singer and lrc
    // in practice despite documenting them, and a "未知歌曲" here would overwrite
    // the real title the search result already carries. The client merges only
    // the fields that actually came back.
    name: d.name || null,
    artist: d.singer || null,
    album: d.album || null,
    cover: https(d.cover) || null,
    source,
    level: SIZE_TO_LEVEL[format] || 'standard',
    // A listener set to 飓风 who lands on 320k should see why, not conclude the
    // setting was ignored. The badge carries the reason; no extra state channel.
    levelLabel: format ? `${format.toUpperCase()}${downgraded ? ' · 已降级' : ''}` : '',
    duration: intervalToSeconds(d.interval),
    // Both sources ship lyrics with resolve, saving the client a round trip.
    lyric: d.lrc || '',
  };
}

async function song(env, origin, id, level, signal) {
  const src = sourceOf(id);
  const size = LEVEL_TO_SIZE[level] || 'flac';

  if (src === 'qq') {
    const r = await resolveWithDowngrade(env, '/qq_music', { mid: bare(id) }, size, signal);
    return {
      ...normalizeNativeDetail(r.detail, {
        source: 'QQ',
        id: `qq:${r.detail.mid || bare(id)}`,
        requestedSize: r.size,
        origin,
        downgraded: r.downgraded,
      }),
    };
  }

  if (src === 'kg') {
    const r = await resolveWithDowngrade(env, '/kugou_music', { id: bare(id) }, size, signal);
    return {
      ...normalizeNativeDetail(r.detail, {
        source: 'KuGou',
        id: `kg:${r.detail.id || bare(id)}`,
        requestedSize: r.size,
        origin,
        downgraded: r.downgraded,
      }),
    };
  }

  // { code, msg, data: { id, url, br, level, size, md5, name, artist, album, picUrl } }
  const requested = NETEASE_LEVELS.has(level) ? level : 'jymaster';
  const d = await getJson(env, '/163_music', { id, level: requested }, signal);
  const t = Array.isArray(d.data) ? d.data[0] : d.data;
  if (!t?.url) throw new Error('未找到可播放音源');
  return {
    id: t.id,
    url: https(t.url),
    name: t.name || null,
    artist: t.artist || null,
    album: t.album || null,
    cover: https(t.picUrl) || null,
    source: 'NetEase',
    requestedLevel: requested,
    // NetEase may silently serve a lower tier than asked; data.level is truth.
    level: t.level || requested,
    br: t.br || null,
    lyric: '',
  };
}

/* ---------------------------------- lyric ----------------------------------- */

async function lyric(env, origin, id, signal) {
  if (sourceOf(id) !== '163') {
    // qq/kg lyrics ride along with resolve; re-resolve if the client lost them.
    const s = await song(env, origin, id, 'lossless', signal).catch(() => null);
    return { lrc: s?.lyric || '', tlrc: '', rlrc: '' };
  }
  // { code, msg, data: { lrc, tlyric, romalrc, klyric } }
  const d = await getJson(env, '/163_lyric', { id }, signal);
  const data = d.data || {};
  return { lrc: data.lrc || '', tlrc: data.tlyric || '', rlrc: data.romalrc || '' };
}

/* --------------------------------- playlist --------------------------------- */

async function playlist(env, id, signal) {
  // { data: { id, name, coverImgUrl, trackCount, creator,
  //           tracks: [{ id, name, ar: [{name}], al: {name, picUrl} }] } }
  const d = await getJson(env, '/163_playlist', { id }, signal);
  const pl = d.data || d.playlist || {};
  const raw = Array.isArray(pl.tracks)
    ? pl.tracks
    : Array.isArray(d.tracks)
      ? d.tracks
      : [];

  const tracks = raw.map((t) => ({
    id: t.id,
    name: t.name || '未知歌曲',
    artist: Array.isArray(t.ar)
      ? t.ar.map((a) => a.name ?? a).filter(Boolean).join(', ')
      : Array.isArray(t.artists)
        ? t.artists.map((a) => a.name ?? a).filter(Boolean).join(', ')
        : t.artists || t.artist || '未知艺术家',
    album: t.al?.name || (typeof t.album === 'string' ? t.album : t.album?.name) || '',
    cover: https(t.al?.picUrl || t.picUrl || t.album?.picUrl),
  }));

  return {
    id: String(pl.id ?? id),
    name: pl.name || `歌单 ${id}`,
    cover: https(pl.coverImgUrl),
    creator: pl.creator?.nickname || '',
    trackCount: pl.trackCount ?? tracks.length,
    tracks,
  };
}

/* ------------------------- binary relays: audio + art ----------------------- */

/** Range-aware relay. The body is streamed, never buffered, so seeking works. */
async function relayAudio(request, target) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return fail('stream 需要合法的 url 参数', 400);
  }
  if (!/^https?:$/.test(url.protocol)) return fail('只支持 http/https 源', 400);

  const headers = new Headers();
  const range = request.headers.get('range');
  if (range) headers.set('range', range);
  headers.set('user-agent', 'Mozilla/5.0');
  headers.set('referer', url.origin);

  const res = await fetch(url.toString(), { headers, redirect: 'follow' });
  const out = new Headers();
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const v = res.headers.get(k);
    if (v) out.set(k, v);
  }
  if (!out.has('accept-ranges')) out.set('accept-ranges', 'bytes');
  if (!out.has('content-type')) out.set('content-type', 'application/octet-stream');
  out.set('cache-control', 'private, max-age=0');
  return new Response(res.body, { status: res.status, headers: out });
}

/** Covers are relayed so the canvas stays untainted for colour lifting. */
async function relayImage(ctx, target) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return fail('image 需要合法的 url 参数', 400);
  }
  const key = new Request(`https://cover.cache/${encodeURIComponent(url.toString())}`);
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit;

  const res = await fetch(url.toString(), { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!res.ok) return fail('封面拉取失败', res.status);
  const out = new Response(res.body, {
    status: 200,
    headers: {
      'content-type': res.headers.get('content-type') || 'image/jpeg',
      'cache-control': 'public, max-age=2592000, immutable',
      'access-control-allow-origin': '*',
    },
  });
  ctx.waitUntil(cache.put(key, out.clone()));
  return out;
}

/* ----------------------------------- sync ----------------------------------- */

/* ---------------------------------- library --------------------------------- */

/**
 * /api/library            GET     what is in the library, with size and quota
 * /api/library/audio/:id  GET     range-aware playback from R2
 * /api/library/:id        PUT     resolve upstream and copy it in
 * /api/library/:id        DELETE  drop it
 * /api/library/prune      POST    evict down to the quota now
 */
async function libraryRoute(context, rest, origin) {
  const { request, env } = context;
  if (!libraryReady(env)) {
    return fail('未配置音乐库：需要 R2 绑定 MUSIC 与 D1 绑定 DB', 501);
  }

  const [head, ...tail] = rest;

  if (!head) {
    if (request.method !== 'GET') return fail('只支持 GET', 405);
    return json({ ok: true, ...(await listTracks(env)) });
  }

  if (head === 'audio') {
    const id = decodeURIComponent(tail.join('/'));
    if (!id) return fail('缺少曲目 id', 400);
    const res = await serveTrack(env, request, id);
    return res || fail('库里没有这首歌', 404);
  }

  if (head === 'prune') {
    if (request.method !== 'POST') return fail('只支持 POST', 405);
    return json({ ok: true, evicted: await evictTo(env, 0) });
  }

  const id = decodeURIComponent(head);

  if (request.method === 'DELETE') {
    return json({ ok: true, ...(await removeTrack(env, id)) });
  }

  if (request.method === 'PUT') {
    // Resolve first, exactly as playback would, so the library stores whatever
    // the listener would actually have heard at their chosen quality.
    const url = new URL(request.url);
    const level = url.searchParams.get('level');
    const rotate = Math.max(0, Number(url.searchParams.get('rotate')) || 0);
    let resolved;
    try {
      resolved = await song(env, origin, id, level, request.signal);
    } catch (err) {
      if (!lxConfigured(env)) throw err;
      // Batch ingest passes a rotating index so each track starts from a
      // different backend, spreading load across the community keys instead of
      // hammering the first one until it 429s.
      resolved = await resolveViaLx(env, origin, id, level, request.signal, rotate);
    }
    const result = await ingestTrack(env, resolved, request.signal);
    return json({ ok: true, id, ...result });
  }

  return fail('不支持的方法', 405);
}

/* --------------------------------- entrypoint -------------------------------- */

export async function onRequest(context) {
  const { request, env, params, waitUntil } = context;
  const url = new URL(request.url);
  const segments = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);
  const route = segments[0] || '';
  const q = url.searchParams;
  const origin = url.origin;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
        'access-control-allow-headers': 'authorization,content-type',
      },
    });
  }

  try {
    if (route === 'health') {
      // Config only by default — the client calls this on every load just to
      // learn whether the fallback exists, and probing would bill the metered
      // upstream for it. ?probe=1 does the live check.
      let upstreamStatus = null;
      let upstreamError = null;
      if (q.get('probe') === '1') {
        try {
          await getJson(env, '/163_search', { keyword: 'test', limit: 1 }, request.signal);
          upstreamStatus = 'ok';
        } catch (e) {
          upstreamStatus = 'failed';
          upstreamError = e.message;
        }
      }
      return json({
        ok: upstreamStatus !== 'failed',
        function: 'reachable',
        keyConfigured: Boolean(env.MUSIC_API_KEY),
        fallbackConfigured: lxConfigured(env),
        libraryConfigured: libraryReady(env),
        origin,
        upstream: upstreamStatus,
        upstreamError,
      });
    }

    if (route === 'stream') return await relayAudio(request, q.get('url'));
    if (route === 'image') return await relayImage({ waitUntil }, q.get('url'));

    // Test every backend in the fallback pool against a known song, so you can
    // see which are alive. GET /api/lxtest?id=wy_36990266&level=exhigh
    if (route === 'lxtest') {
      const testId = q.get('id') || '163_36990266';
      const level = q.get('level') || 'exhigh';
      const pool = lxPool(env);
      const src = LX_SOURCE[sourceOf(testId)] || 'wy';
      const quality = LX_QUALITY[level] || '320k';
      const songId = bare(testId);
      const results = [];
      for (const backend of pool) {
        const started = Date.now();
        try {
          const url = await askLxBackend(backend, src, songId, quality, request.signal);
          results.push({ name: backend.name, style: backend.style, ok: true, ms: Date.now() - started, url: url.slice(0, 60) + '…' });
        } catch (err) {
          results.push({ name: backend.name, style: backend.style, ok: false, ms: Date.now() - started, error: err.message });
        }
      }
      return json({ ok: true, tested: `${src}/${songId}/${quality}`, poolSize: pool.length, results });
    }

    if (route === 'search') {
      const keyword = (q.get('q') || '').trim();
      if (!keyword) return json({ ok: true, items: [] });
      const limit = Math.min(Number(q.get('limit')) || 30, 50);
      const offset = Math.max(Number(q.get('offset')) || 0, 0);
      const items = await search(env, keyword, q.get('source') || '163', { limit, offset }, request.signal);
      return json({ ok: true, items, limit, offset });
    }

    if (route === 'library') return await libraryRoute(context, segments.slice(1), origin);


    if (route === 'song') {
      const id = q.get('id');
      if (!id) return fail('song 需要 id 参数', 400);
      const level = q.get('level');

      // A copy in the library is preferred over anything upstream, and not for
      // speed: upstream urls expire and their CDNs answer 503, and this one
      // does neither. `fresh=1` bypasses it, for re-fetching at a new quality.
      if (q.get('fresh') !== '1') {
        const row = await findTrack(env, id);
        if (row) {
          waitUntil(touchTrack(env, id));
          return json({ ok: true, song: trackAsSong(row, origin, env) });
        }
      }

      // via=lx forces the fallback. Otherwise the primary is tried first and
      // the fallback only covers for it, so a working primary is never skipped.
      // ?rotate=N staggers which pool backend the fallback starts from, so a
      // batch caller can spread load across community keys instead of hammering
      // one. The client sends its running track index as rotate.
      const rotate = Math.max(0, Number(q.get('rotate')) || 0);
      if (q.get('via') === 'lx') {
        return json({ ok: true, song: await resolveViaLx(env, origin, id, level, request.signal, rotate) });
      }

      try {
        return json({ ok: true, song: await song(env, origin, id, level, request.signal) });
      } catch (primaryErr) {
        if (primaryErr?.name === 'AbortError' || !lxConfigured(env)) throw primaryErr;
        try {
          const viaLx = await resolveViaLx(env, origin, id, level, request.signal, rotate);
          return json({ ok: true, song: { ...viaLx, primaryError: primaryErr.message } });
        } catch {
          // Report the primary's reason: it is the one that was supposed to work.
          throw primaryErr;
        }
      }
    }

    if (route === 'lyric') {
      const id = q.get('id');
      if (!id) return fail('lyric 需要 id 参数', 400);
      return json({ ok: true, ...(await lyric(env, origin, id, request.signal)) });
    }

    if (route === 'playlist') {
      const id = q.get('id');
      if (!id) return fail('playlist 需要 id 参数', 400);
      const data = await playlist(env, id, request.signal);
      return json({ ok: true, playlist: data }, 200, { 'cache-control': 'public, max-age=300' });
    }

    return fail(`未知接口 /api/${route}`, 404);
  } catch (err) {
    if (err?.name === 'AbortError') return new Response(null, { status: 499 });
    return fail(err?.message || '上游请求失败');
  }
}
