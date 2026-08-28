/**
 * _library.js — the server-side music library.
 *
 * Two bindings, each doing what it is good at:
 *   env.MUSIC (R2)  the audio bytes. Serves byte ranges natively and its egress
 *                   is free, which is what seeking through a 40 MB FLAC needs.
 *   env.DB    (D1)  the bookkeeping. Ordering by last use and summing sizes is
 *                   exactly what SQL is for; storing the audio here would not
 *                   work at all, since a query response is capped and cannot be
 *                   range-read.
 *
 * The payoff is not offline — a copy on Cloudflare is unreachable when the phone
 * has no signal. It is *stability*: upstream urls expire and their CDNs answer
 * 503, and a track in the library plays from a url that does neither.
 *
 * Leading underscore keeps this out of Pages' route table; it is imported, not
 * routed.
 */

/** Refuse anything implausible for a single song, in bytes. */
const MAX_TRACK_BYTES = 120 * 1024 * 1024;

/** Total library ceiling. Past this, least-recently-played rows are evicted. */
const DEFAULT_QUOTA_BYTES = 8 * 1024 * 1024 * 1024;

export const libraryReady = (env) => Boolean(env.MUSIC && env.DB);

const quotaOf = (env) => Number(env.LIBRARY_QUOTA_BYTES) || DEFAULT_QUOTA_BYTES;

/**
 * Object keys carry a random suffix so the library cannot be enumerated.
 * Without it a key is `audio/<song id>.flac`, and song ids are public
 * information — so a bucket with public access would be fully guessable. The
 * key is stored in D1 anyway, so nothing needs to derive it.
 */
function randomToken() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function extFor(contentType, url) {
  const fromUrl = (String(url).match(/\.(flac|mp3|m4a|ogg|wav|aac)(?:\?|$)/i) || [])[1];
  if (fromUrl) return fromUrl.toLowerCase();
  const t = String(contentType || '').toLowerCase();
  if (t.includes('flac')) return 'flac';
  if (t.includes('mp4') || t.includes('m4a') || t.includes('aac')) return 'm4a';
  if (t.includes('ogg')) return 'ogg';
  return 'mp3';
}

/* --------------------------------- queries ---------------------------------- */

export async function findTrack(env, id) {
  if (!libraryReady(env)) return null;
  const row = await env.DB.prepare('SELECT * FROM tracks WHERE id = ?').bind(String(id)).first();
  return row || null;
}

export async function listTracks(env) {
  if (!libraryReady(env)) return { tracks: [], totalBytes: 0, quotaBytes: 0 };
  const { results } = await env.DB.prepare(
    `SELECT id, source, name, artist, album, cover, bytes, level, duration,
            created_at, last_played, play_count
       FROM tracks ORDER BY last_played DESC`
  ).all();
  const total = await env.DB.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM tracks').first();
  return {
    tracks: results || [],
    totalBytes: Number(total?.n || 0),
    quotaBytes: quotaOf(env),
  };
}

/** Fire-and-forget: a play should never wait on bookkeeping. */
export function touchTrack(env, id) {
  if (!libraryReady(env)) return Promise.resolve();
  return env.DB.prepare(
    'UPDATE tracks SET last_played = ?, play_count = play_count + 1 WHERE id = ?'
  )
    .bind(Date.now(), String(id))
    .run()
    .catch(() => {});
}

export async function removeTrack(env, id) {
  if (!libraryReady(env)) throw new Error('未配置音乐库（R2 / D1）');
  const row = await findTrack(env, id);
  if (!row) return { removed: false };
  await env.MUSIC.delete(row.object_key).catch(() => {});
  await env.DB.prepare('DELETE FROM tracks WHERE id = ?').bind(String(id)).run();
  return { removed: true, bytes: row.bytes };
}

/**
 * Evict least-recently-played tracks until the library fits under `headroom`
 * bytes of the quota. Returns what was dropped so the caller can report it.
 */
export async function evictTo(env, headroom = 0) {
  if (!libraryReady(env)) return [];
  const quota = quotaOf(env);
  const evicted = [];

  for (;;) {
    const total = await env.DB.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM tracks').first();
    if (Number(total?.n || 0) + headroom <= quota) break;

    const victim = await env.DB.prepare(
      'SELECT id, name, bytes, object_key FROM tracks ORDER BY last_played ASC LIMIT 1'
    ).first();
    if (!victim) break;

    await env.MUSIC.delete(victim.object_key).catch(() => {});
    await env.DB.prepare('DELETE FROM tracks WHERE id = ?').bind(victim.id).run();
    evicted.push({ id: victim.id, name: victim.name, bytes: victim.bytes });
  }
  return evicted;
}

/* ---------------------------------- ingest ---------------------------------- */

/**
 * Copy a resolved track into the library.
 *
 * The upstream body is streamed straight into R2 rather than buffered, so a
 * large FLAC does not have to fit in the Worker's memory. That does mean the
 * size is only known afterwards, from R2's own accounting — hence the size check
 * against Content-Length up front and the recorded size taken from the object.
 */
export async function ingestTrack(env, resolved, signal) {
  if (!libraryReady(env)) throw new Error('未配置音乐库（R2 / D1）');
  if (!resolved?.url) throw new Error('没有可入库的地址');

  const id = String(resolved.id);
  const existing = await findTrack(env, id);
  if (existing) return { already: true, bytes: existing.bytes };

  const res = await fetch(resolved.url, {
    signal,
    headers: { 'user-agent': 'Mozilla/5.0' },
    redirect: 'follow',
  });
  if (!res.ok || !res.body) throw new Error(`音源返回 ${res.status}，无法入库`);

  const declared = Number(res.headers.get('content-length')) || 0;
  if (declared > MAX_TRACK_BYTES) {
    throw new Error(`单曲 ${(declared / 1048576).toFixed(0)} MB 超过上限`);
  }

  // Make room before writing, not after, so the quota is never exceeded even
  // transiently.
  const evicted = await evictTo(env, declared || 40 * 1024 * 1024);

  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  const key = `audio/${id.replace(/[^\w:.-]/g, '_')}-${randomToken()}.${extFor(contentType, resolved.url)}`;

  const object = await env.MUSIC.put(key, res.body, {
    httpMetadata: { contentType },
  });

  const bytes = Number(object?.size || declared || 0);
  if (bytes > MAX_TRACK_BYTES) {
    await env.MUSIC.delete(key).catch(() => {});
    throw new Error('入库后发现文件超过上限，已回滚');
  }

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO tracks
       (id, source, name, artist, album, cover, object_key, content_type,
        bytes, level, duration, lyric, created_at, last_played, play_count)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
     ON CONFLICT(id) DO UPDATE SET
       object_key = excluded.object_key,
       content_type = excluded.content_type,
       bytes = excluded.bytes,
       level = excluded.level,
       last_played = excluded.last_played`
  )
    .bind(
      id,
      resolved.source || '',
      resolved.name || '',
      resolved.artist || '',
      resolved.album || '',
      resolved.cover || '',
      key,
      contentType,
      bytes,
      resolved.level || '',
      resolved.duration ?? null,
      resolved.lyric || '',
      now,
      now
    )
    .run();

  return { already: false, bytes, evicted };
}

/* ---------------------------------- serving --------------------------------- */

/**
 * Range-aware read from R2. R2 does the slicing, so seeking costs one ranged
 * read rather than a full object fetch — which is the whole reason the bytes are
 * not in D1.
 */
export async function serveTrack(env, request, id) {
  const row = await findTrack(env, id);
  if (!row) return null;

  const rangeHeader = request.headers.get('range');
  let range;
  let status = 200;

  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (m) {
      const start = m[1] === '' ? undefined : Number(m[1]);
      const end = m[2] === '' ? undefined : Number(m[2]);
      if (start === undefined && end !== undefined) range = { suffix: end };
      else if (end === undefined) range = { offset: start };
      else range = { offset: start, length: end - start + 1 };
      status = 206;
    }
  }

  const object = await env.MUSIC.get(row.object_key, { range, onlyIf: undefined });
  if (!object) return null;

  const headers = new Headers();
  headers.set('content-type', row.content_type || 'application/octet-stream');
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'private, max-age=0');
  if (object.httpEtag) headers.set('etag', object.httpEtag);

  if (status === 206 && object.range) {
    const offset = object.range.offset ?? 0;
    const length = object.range.length ?? row.bytes - offset;
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${row.bytes}`);
    headers.set('content-length', String(length));
  } else {
    status = 200;
    headers.set('content-length', String(row.bytes));
  }

  return new Response(object.body, { status, headers });
}

/**
 * The library's view of a track, shaped like a resolve response.
 *
 * With R2_PUBLIC_BASE set the browser fetches from R2 directly — one less hop
 * and no Worker CPU per byte, at the cost of the bucket being public. Unset,
 * everything goes through the Function and the bucket stays private.
 */
export function trackAsSong(row, origin, env) {
  const base = env?.R2_PUBLIC_BASE ? String(env.R2_PUBLIC_BASE).replace(/\/+$/, '') : '';
  return {
    id: row.id,
    url: base
      ? `${base}/${row.object_key}`
      : `${origin}/api/library/audio/${encodeURIComponent(row.id)}`,
    name: row.name || null,
    artist: row.artist || null,
    album: row.album || null,
    cover: row.cover || null,
    source: row.source || '',
    level: row.level || 'lossless',
    levelLabel: `${(row.level || '').toUpperCase() || 'LIB'} · 库`,
    duration: row.duration ?? null,
    lyric: row.lyric || '',
    fromLibrary: true,
  };
}
