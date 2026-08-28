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

const MUSIC_UPSTREAM = 'https://api.chksz.com/api';
const SYNC_UPSTREAM = 'https://sync.chksz.top/api/v1';

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
      throw new Error(
        keyed
          ? `上游拒绝 ${path}（${res.status}）：已附带 MUSIC_API_KEY，但被判定无效或过期${reason ? ' · ' + reason : ''}`
          : `上游拒绝 ${path}（${res.status}）：未配置 MUSIC_API_KEY${reason ? ' · ' + reason : ''}`
      );
    }
    throw new Error(`上游 ${path} 返回 ${res.status}${reason ? ' · ' + reason : ''}`);
  }

  const body = await res.json();
  // qq/kugou report failures in-band: HTTP 200 with a non-200 `code`.
  if (body && typeof body.code === 'number' && body.code !== 200) {
    throw new Error(`上游 ${path}：${body.msg || `code ${body.code}`}`);
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

async function search(env, q, source, { limit = 30, offset = 0 } = {}, signal) {
  if (source === 'qq') {
    // { code, msg, count, list: [{ n, name, singer, album, pay, mid }] }
    // No artwork in the search payload; covers only arrive on resolve.
    const d = await getJson(env, '/qq_music', { msg: q, num: Math.min(limit, 50) }, signal);
    return (Array.isArray(d.list) ? d.list : []).map((it) => ({
      id: `qq:${it.mid}`,
      name: it.name || '未知歌曲',
      artist: it.singer || '未知艺术家',
      album: it.album || '',
      cover: '',
      source: 'QQ',
    }));
  }

  if (source === 'kg') {
    // { code, msg, keyword, total, list: [{ n, id, name, singer, album, duration }] }
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
  }

  // { code, msg, data: [{ id, name, artists, album, picUrl }] }
  // `artists` is a pre-joined string here, unlike the raw NetEase API.
  const d = await getJson(env, '/163_search', { keyword: q, limit, offset }, signal);
  const items = Array.isArray(d.data) ? d.data : [];
  return items.map((it) => ({
    id: it.id,
    name: it.name || '未知歌曲',
    artist: Array.isArray(it.artists)
      ? it.artists.map((a) => a.name ?? a).filter(Boolean).join(', ')
      : it.artists || '未知艺术家',
    album: typeof it.album === 'string' ? it.album : it.album?.name || '',
    cover: https(it.picUrl),
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
    name: d.name || '未知歌曲',
    artist: d.singer || '未知艺术家',
    album: d.album || '',
    cover: https(d.cover),
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
    name: t.name,
    artist: t.artist,
    album: t.album || '',
    cover: https(t.picUrl),
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
  const pl = d.data || {};
  const raw = Array.isArray(pl.tracks) ? pl.tracks : [];

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

async function relaySync(request, path) {
  const src = new URL(request.url);
  const target = new URL(SYNC_UPSTREAM + path);
  target.search = src.search;

  const headers = new Headers();
  const auth = request.headers.get('authorization');
  if (auth) headers.set('authorization', auth);
  if (request.headers.get('content-type')) headers.set('content-type', request.headers.get('content-type'));

  const res = await fetch(target.toString(), {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
  });
  const out = new Headers(res.headers);
  out.set('cache-control', 'no-store');
  out.delete('access-control-allow-origin');
  return new Response(res.body, { status: res.status, headers: out });
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
      let upstreamStatus = null;
      let upstreamError = null;
      try {
        await getJson(env, '/163_search', { keyword: 'test', limit: 1 }, request.signal);
        upstreamStatus = 'ok';
      } catch (e) {
        upstreamStatus = 'failed';
        upstreamError = e.message;
      }
      return json({
        ok: upstreamStatus === 'ok',
        function: 'reachable',
        keyConfigured: Boolean(env.MUSIC_API_KEY),
        origin,
        upstream: upstreamStatus,
        upstreamError,
      });
    }

    if (route === 'sync') return await relaySync(request, '/' + segments.slice(1).join('/'));
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

    if (route === 'song') {
      const id = q.get('id');
      if (!id) return fail('song 需要 id 参数', 400);
      return json({ ok: true, song: await song(env, origin, id, q.get('level'), request.signal) });
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
