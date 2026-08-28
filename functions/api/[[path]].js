/**
 * /api/* — Cloudflare Pages Function
 *
 * Why this exists: the old build called api.chksz.com straight from the page and
 * kept the personal key in localStorage, so the key was readable by anyone with
 * devtools and the upstream had to keep an Origin allowlist to compensate.
 * Now the browser only ever talks to its own origin. The key lives in
 * env.MUSIC_API_KEY (a Pages secret) and is attached here.
 *
 * Routes
 *   /api/search?q=&source=163|qq|kg      unified search
 *   /api/song?id=&level=                 playable url + metadata
 *   /api/lyric?id=                       lrc + translation
 *   /api/playlist?id=                    netease playlist
 *   /api/stream?url=                     byte-range audio relay (kugou is http-only)
 *   /api/image?url=                      cover relay, gives us CORS for colour lifting
 *   /api/sync/*                          passthrough to the sync service
 */

const MUSIC_UPSTREAM = 'https://api.chksz.com/api';
const SYNC_UPSTREAM = 'https://sync.chksz.top/api/v1';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });
}

function fail(message, status = 502) {
  return json({ ok: false, error: message }, status);
}

/** Upstream URL with the server-side key attached. */
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
  if (!res.ok) throw new Error(`upstream ${path} responded ${res.status}`);
  return res.json();
}

const https = (u) => String(u || '').replace(/^http:/, 'https:');

/* ------------------------------------------------------------------ *
 * Source dispatch. Song ids stay wire-compatible with the old build:
 * bare digits = netease, `qq:<mid>`, `kg:<hash>`.
 * ------------------------------------------------------------------ */

function sourceOf(id) {
  const s = String(id || '');
  if (s.startsWith('qq:')) return 'qq';
  if (s.startsWith('kg:')) return 'kg';
  return '163';
}
const bare = (id) => String(id || '').replace(/^(qq|kg):/, '');

/* ---------------------------------- search ---------------------------------- */

async function search(env, q, source, signal) {
  if (source === 'qq') {
    const d = await getJson(env, '/qq_music', { msg: q, num: 30 }, signal);
    return (Array.isArray(d.list) ? d.list : []).map((it) => ({
      id: `qq:${it.id}`,
      name: it.name || '未知歌曲',
      artist: it.artists || '未知艺术家',
      album: '',
      cover: https(it.cover),
      source: 'QQ',
    }));
  }

  if (source === 'kg') {
    const d = await getJson(env, '/kugou_music', { msg: q }, signal);
    const list = d.code === 200 && Array.isArray(d.list) ? d.list : [];
    return list.map((it) => ({
      id: `kg:${it.id}`,
      name: it.SongName || '未知歌曲',
      artist: it.SingerName || '未知艺术家',
      album: it.AlbumName || '',
      cover: https(it.Image),
      source: 'KuGou',
    }));
  }

  const d = await getJson(env, '/163_search', { keyword: q, limit: 30 }, signal);
  let items = [];
  if (d.code === 200) {
    if (Array.isArray(d.data)) items = d.data;
    else if (Array.isArray(d.data?.songs)) items = d.data.songs;
    else if (Array.isArray(d.result?.songs)) items = d.result.songs;
  }
  return items.map((it) => ({
    id: it.id,
    name: it.name,
    artist: Array.isArray(it.artists)
      ? it.artists.map((a) => a.name).filter(Boolean).join(', ')
      : it.artists?.name || (typeof it.artists === 'string' ? it.artists : '未知艺术家'),
    album: typeof it.album === 'string' ? it.album : it.album?.name || '',
    cover: https(it.picUrl || it.album?.picUrl),
    source: 'NetEase',
  }));
}

/* ----------------------------------- song ----------------------------------- */

/** QQ encodes real quality in the filename prefix, so read it rather than guessing from the url. */
function qqQuality(url) {
  const tag = (String(url).match(/\/(F000|M800|M500|C600|C400|C200)/) || [])[1] || '';
  if (tag === 'F000') return { level: 'lossless', label: '无损 FLAC' };
  if (tag === 'M800') return { level: 'exhigh', label: '320K' };
  if (tag === 'C600') return { level: 'higher', label: '192K' };
  if (tag === 'C400' || tag === 'C200') return { level: 'standard', label: '128K M4A' };
  return { level: 'standard', label: 'QQ 音源' };
}

function kgQuality(bitRate, extName) {
  const br = Number(bitRate) || 0;
  const ext = String(extName || '').toUpperCase();
  if (ext === 'FLAC' || br >= 900000) return { level: 'lossless', label: `无损 ${ext || 'FLAC'}` };
  if (br >= 320000) return { level: 'exhigh', label: `${Math.round(br / 1000)}K` };
  if (br > 0) return { level: 'standard', label: `${Math.round(br / 1000)}K` };
  return { level: 'standard', label: '酷狗音源' };
}

async function song(env, origin, id, level, signal) {
  const src = sourceOf(id);

  if (src === 'qq') {
    const d = await getJson(env, '/qq_music', { mid: bare(id) }, signal);
    if (!d?.url) throw new Error('QQ 未返回可播放地址');
    const q = qqQuality(d.url);
    return {
      id: `qq:${d.id || bare(id)}`,
      url: https(d.url),
      name: d.name,
      artist: Array.isArray(d.artists) ? d.artists.map((a) => a.name).filter(Boolean).join(', ') : d.artists || '未知艺术家',
      album: d.album?.name || '',
      cover: https(d.cover?.large || d.cover?.medium || d.cover?.small),
      source: 'QQ',
      level: q.level,
      levelLabel: q.label,
      // QQ ships lyrics with the resolve call — pass them through so the client
      // does not need a second round trip.
      lyric: d.lyric?.text || '',
    };
  }

  if (src === 'kg') {
    const d = await getJson(env, '/kugou_music', { id: bare(id) }, signal);
    const t = d.code === 200 ? d.data : null;
    if (!t?.url) throw new Error('酷狗未返回可播放地址');
    const q = kgQuality(t.bitRate, t.extName);
    return {
      id: `kg:${bare(id)}`,
      // Kugou's CDN is http-only with an invalid cert, so it must be relayed.
      url: `${origin}/api/stream?url=${encodeURIComponent(t.url)}`,
      name: t.songName || '未知歌曲',
      artist: t.singerName || '未知艺术家',
      album: '',
      cover: https(t.albumImage),
      source: 'KuGou',
      level: q.level,
      levelLabel: q.label,
      lyric: t.lyrics || '',
    };
  }

  const d = await getJson(env, '/163_music', { id, level: level || 'exhigh' }, signal);
  const t = d.code === 200 ? (Array.isArray(d.data) ? d.data[0] : d.data) : null;
  if (!t?.url) throw new Error('未找到可播放音源');
  return {
    id: t.id,
    url: https(t.url),
    name: t.name,
    artist: t.artist,
    album: t.album || '',
    cover: https(t.picUrl),
    source: 'NetEase',
    requestedLevel: level,
    level: t.level || null,
    br: t.br || t.bitrate || null,
    lyric: '',
  };
}

/* ---------------------------------- lyric ----------------------------------- */

async function lyric(env, id, signal) {
  if (sourceOf(id) !== '163') {
    // qq/kg lyrics arrive with /api/song; re-resolve if the client lost them.
    const s = await song(env, '', id, null, signal).catch(() => null);
    return { lrc: s?.lyric || '', tlrc: '', rlrc: '' };
  }
  const d = await getJson(env, '/163_lyric', { id }, signal);
  if (d.code === 200 && d.data) {
    return {
      lrc: d.data.lrc || '',
      tlrc: d.data.tlyric || '',
      // Upstream also carries a romanisation track. Field name varies across
      // versions of the endpoint, so accept either spelling.
      rlrc: d.data.romalrc || d.data.rlyric || '',
    };
  }
  return { lrc: '', tlrc: '', rlrc: '' };
}

/* --------------------------------- playlist --------------------------------- */

async function playlist(env, id, signal) {
  const d = await getJson(env, '/163_playlist', { id }, signal);
  const raw = d.data?.tracks || d.playlist?.tracks || d.tracks || (Array.isArray(d.data) ? d.data : []);
  const tracks = (Array.isArray(raw) ? raw : []).map((t) => ({
    id: t.id,
    name: t.name || t.title || '未知歌曲',
    artist: Array.isArray(t.artists)
      ? t.artists.map((a) => a.name || a).filter(Boolean).join(', ')
      : t.artists || t.artist || t.ar?.map?.((a) => a.name).join(', ') || '未知艺术家',
    album: typeof t.album === 'string' ? t.album : t.album?.name || '',
    cover: https(t.picUrl || t.album?.picUrl || t.al?.picUrl),
  }));
  return {
    id: String(id),
    name: d.data?.name || d.playlist?.name || `歌单 ${id}`,
    cover: https(d.data?.coverImgUrl || d.playlist?.coverImgUrl),
    tracks,
  };
}

/* ------------------------- binary relays: audio + art ----------------------- */

/**
 * Range-aware relay. We never buffer the whole file: the upstream body is
 * streamed straight through so seeking in a 200 MB FLAC still works.
 */
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
  // Upstream CDNs mislabel FLAC as audio/mpeg; a generic type keeps Safari happy.
  if (!out.has('content-type')) out.set('content-type', 'application/octet-stream');
  out.set('cache-control', 'private, max-age=0');
  return new Response(res.body, { status: res.status, headers: out });
}

/** Covers are relayed so ColorThief can read pixels without a tainted canvas. */
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

/** Thin passthrough. Auth stays a bearer token minted by the sync service. */
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
    if (route === 'sync') return await relaySync(request, '/' + segments.slice(1).join('/'));
    if (route === 'stream') return await relayAudio(request, q.get('url'));
    if (route === 'image') return await relayImage({ waitUntil }, q.get('url'));

    if (route === 'search') {
      const keyword = (q.get('q') || '').trim();
      if (!keyword) return json({ ok: true, items: [] });
      return json({ ok: true, items: await search(env, keyword, q.get('source') || '163', request.signal) });
    }

    if (route === 'song') {
      const id = q.get('id');
      if (!id) return fail('song 需要 id 参数', 400);
      return json({ ok: true, song: await song(env, origin, id, q.get('level'), request.signal) });
    }

    if (route === 'lyric') {
      const id = q.get('id');
      if (!id) return fail('lyric 需要 id 参数', 400);
      return json({ ok: true, ...(await lyric(env, id, request.signal)) });
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
