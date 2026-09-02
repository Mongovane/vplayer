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
const LX_SOURCE = { 163: 'wy', qq: 'tx', kg: 'kg' };

const LX_QUALITY = {
  standard: '128k',
  exhigh: '320k',
  lossless: 'flac',
  hires: 'flac24bit',
  jyeffect: 'flac24bit',
  sky: 'flac24bit',
  jymaster: 'flac24bit',
};

/** lx-music-api-server's numeric result codes. */
const LX_CODES = {
  1: 'IP 被上游封禁',
  2: '备用源没有这首歌的地址',
  4: '备用源的远程服务器出错',
  5: '请求过于频繁，缓一下',
  6: '请求参数有误',
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

const lxConfigured = (env) => Boolean(env.LX_API_URL && env.LX_API_KEY);

/**
 * Ask the fallback resolver for a playable url. Metadata stays whatever the
 * search result already knew — this returns nulls for everything else and the
 * client merges field by field.
 */
async function resolveViaLx(env, origin, id, level, signal) {
  if (!lxConfigured(env)) throw new Error('未配置备用源（LX_API_URL / LX_API_KEY）');

  const src = LX_SOURCE[sourceOf(id)];
  const quality = LX_QUALITY[level] || 'flac';
  const base = String(env.LX_API_URL).replace(/\/+$/, '');

  const res = await fetch(`${base}/url/${src}/${encodeURIComponent(bare(id))}/${quality}`, {
    signal,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-request-key': env.LX_API_KEY,
      'user-agent': 'lx-music-request/2.0.0',
    },
    redirect: 'follow',
  });

  if (!res.ok) throw new Error(`备用源返回 ${res.status}`);
  const body = await res.json().catch(() => null);
  if (!body || Number.isNaN(Number(body.code))) throw new Error('备用源返回了无法解析的内容');
  if (Number(body.code) !== 0) {
    throw new Error(LX_CODES[Number(body.code)] || body.msg || `备用源 code ${body.code}`);
  }

  const url = String(body.data || '');
  if (!url) throw new Error('备用源没有返回地址');

  return {
    id,
    url: url.startsWith('http://') ? `${origin}/api/stream?url=${encodeURIComponent(url)}` : https(url),
    name: null,
    artist: null,
    album: null,
    cover: null,
    source: 'LX',
    level: quality === 'flac24bit' ? 'hires' : quality === 'flac' ? 'lossless' : quality === '320k' ? 'exhigh' : 'standard',
    levelLabel: `${quality.toUpperCase()} · 备用源`,
    duration: null,
    lyric: '',
    via: 'lx',
  };
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
    const level = new URL(request.url).searchParams.get('level');
    let resolved;
    try {
      resolved = await song(env, origin, id, level, request.signal);
    } catch (err) {
      if (!lxConfigured(env)) throw err;
      resolved = await resolveViaLx(env, origin, id, level, request.signal);
    }
    const result = await ingestTrack(env, resolved, request.signal);
    return json({ ok: true, id, ...result });
  }

  return fail('不支持的方法', 405);
}

/* --------------------------------- kugou import ----------------------------- */

/**
 * Resolve a KuGou share link and fetch the full song list.
 *
 * Flow:
 * 1. Resolve the short URL (t1.kugou.com) to get the full share URL
 * 2. Extract userid and global_specialid from the URL parameters
 * 3. Call pubsongs.kugou.com/v1/get_list_info to get the collection metadata
 * 4. Paginate through the songs (30 per page)
 */
async function importKugou(shareUrl, debug = false) {
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

  // Step 1: Resolve short URL — follow up to 3 redirects
  let resolved = shareUrl;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(resolved, { headers: { 'User-Agent': ua }, redirect: 'manual' });
      const loc = res.headers.get('location');
      if (!loc) break;
      resolved = loc.startsWith('http') ? loc : new URL(loc, resolved).href;
    } catch { break; }
  }

  // Step 2: Extract userId — it may be in the URL itself or in a nested
  // `qrcode` parameter (KuGou wraps the share URL inside a download page).
  let userId;

  // Try the resolved URL's own params first
  const tryExtract = (urlStr) => {
    try {
      // Decode first in case it's double-encoded
      const decoded = decodeURIComponent(urlStr);
      const m = decoded.match(/[?&]u=(\d+)/);
      return m?.[1];
    } catch { return null; }
  };

  userId = tryExtract(resolved);

  // If not found, look inside the qrcode param
  if (!userId) {
    try {
      const outer = new URL(resolved);
      const qrcode = outer.searchParams.get('qrcode');
      if (qrcode) {
        userId = tryExtract(qrcode);
        // Also try the decoded qrcode as the real share URL
        if (!userId) userId = tryExtract(decodeURIComponent(qrcode));
      }
    } catch {}
  }

  // Last resort: search the whole string for a userid pattern
  if (!userId) {
    const m = resolved.match(/(?:userid|u)=(\d{5,})/);
    userId = m?.[1];
  }

  if (!userId) throw new Error('无法从链接中提取用户 ID，解析到: ' + resolved.slice(0, 200));

  const log = debug ? [`resolved: ${resolved.slice(0, 200)}`, `userId: ${userId}`] : null;

  // Step 3: Paginate through the song list
  const allSongs = [];
  const pageSize = 30;
  const maxPages = 20; // 600 songs max

  for (let page = 1; page <= maxPages; page++) {
    const ts = String(Date.now());
    const params = {
      srcappid: '2919',
      clientver: '20000',
      clienttime: ts,
      mid: ts,
      uuid: ts,
      dfid: '-',
      userid: userId,
      page: String(page),
      pagesize: String(pageSize),
    };

    let songs = [];

    // Try GET first (get_other_list_file)
    try {
      const getUrl = 'https://pubsongs.kugou.com/v1/get_other_list_file?' + new URLSearchParams({ ...params, listid: '1' });
      const res = await fetch(getUrl, { headers: { 'User-Agent': ua } });
      const getJson = await res.json().catch(() => null);
      if (log) log.push(`GET page${page}: status=${res.status} error_code=${getJson?.error_code} count=${getJson?.data?.info?.length || 0} raw=${JSON.stringify(getJson).slice(0,200)}`);
      songs = getJson?.data?.info || [];
    } catch (e) { if (log) log.push(`GET page${page} error: ${e.message}`); }

    // If GET failed or returned nothing, try POST (get_list_info)
    if (!songs.length) {
      try {
        const res = await fetch('https://pubsongs.kugou.com/v1/get_list_info', {
          method: 'POST',
          headers: { 'User-Agent': ua, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(params),
        });
        const postJson = await res.json().catch(() => null);
        if (log) log.push(`POST page${page}: status=${res.status} error_code=${postJson?.error_code} count=${postJson?.data?.info?.length || 0} raw=${JSON.stringify(postJson).slice(0,200)}`);
        songs = postJson?.data?.info || [];
      } catch (e) { if (log) log.push(`POST page${page} error: ${e.message}`); }
    }

    if (!songs.length) break;
    allSongs.push(...songs);
    if (songs.length < pageSize) break;
  }

  // Step 4: Normalize the song data
  if (debug) {
    log.push(`total raw songs: ${allSongs.length}`);
    const normalized = allSongs.map(s => {
    const raw = s.name || s.filename || '';
    // KuGou format: "Artist - SongName"
    const parts = raw.split(/\s+-\s+/);
    const artist = parts.length >= 2 ? parts[0].trim() : '';
    const name = parts.length >= 2 ? parts.slice(1).join(' - ').trim() : raw.trim();
    return {
      name,
      artist,
      hash: s.hash || '',
      cover: s.album_sizable_cover || '',
    };
  }).filter(s => s.name);
    return { songs: normalized, log };
  }

  return allSongs.map(s => {
    const raw = s.name || s.filename || '';
    const parts = raw.split(/\s+-\s+/);
    const artist = parts.length >= 2 ? parts[0].trim() : '';
    const name = parts.length >= 2 ? parts.slice(1).join(' - ').trim() : raw.trim();
    return { name, artist, hash: s.hash || '', cover: s.album_sizable_cover || '' };
  }).filter(s => s.name);
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

    if (route === 'search') {
      const keyword = (q.get('q') || '').trim();
      if (!keyword) return json({ ok: true, items: [] });
      const limit = Math.min(Number(q.get('limit')) || 30, 50);
      const offset = Math.max(Number(q.get('offset')) || 0, 0);
      const items = await search(env, keyword, q.get('source') || '163', { limit, offset }, request.signal);
      return json({ ok: true, items, limit, offset });
    }

    if (route === 'library') return await libraryRoute(context, segments.slice(1), origin);

    if (route === 'import' && segments[1] === 'kugou') {
      const shareUrl = q.get('url');
      if (!shareUrl) return fail('缺少 url 参数', 400);
      const debug = q.get('debug') === '1';
      try {
        const result = await importKugou(shareUrl, debug);
        if (debug) return json({ ok: true, songs: result.songs, count: result.songs.length, debug: result.log });
        return json({ ok: true, songs: result, count: result.length });
      } catch (err) {
        return fail(`导入失败: ${err.message}`, 500);
      }
    }

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
      if (q.get('via') === 'lx') {
        return json({ ok: true, song: await resolveViaLx(env, origin, id, level, request.signal) });
      }

      try {
        return json({ ok: true, song: await song(env, origin, id, level, request.signal) });
      } catch (primaryErr) {
        if (primaryErr?.name === 'AbortError' || !lxConfigured(env)) throw primaryErr;
        try {
          const viaLx = await resolveViaLx(env, origin, id, level, request.signal);
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
