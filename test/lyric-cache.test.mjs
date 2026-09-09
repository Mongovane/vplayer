/**
 * How many times a deployment pays for the same lyric.
 *
 * Before this, once per device: the client caches, so the cost was one metered
 * call per track *per device* — every member's phone paid separately, a new
 * phone paid again, and a Safari storage sweep made it pay a third time.
 * Auto-downloading 收藏 turned that from a trickle into two hundred paid calls
 * for words the deployment already had.
 *
 * Note what is deliberately not the fix here: reading tracks.lyric. NetEase
 * resolves carry no lyric at all, so a library-first check would have looked
 * like a saving and delivered nothing — which is why the cache is its own
 * table rather than a column on tracks.
 *
 *   node test/lyric-cache.test.mjs
 */

import assert from 'node:assert/strict';

const { onRequest } = await import('../functions/api/[[path]].js');

const realFetch = globalThis.fetch;

/* ---------------------------------- stubs ---------------------------------- */

/**
 * Enough of D1 to answer the statements this path uses: the table existence
 * probe, the cache read, the tracks read, and the upsert.
 */
function makeDB({ hasTable = true, rows = new Map(), tracks = new Map() } = {}) {
  const stats = { reads: 0, writes: 0 };
  return {
    stats,
    rows,
    prepare(sql) {
      const s = String(sql);
      let bound = [];
      const self = {
        bind(...args) {
          bound = args;
          return self;
        },
        async first() {
          if (s.includes('sqlite_master')) {
            return hasTable && s.includes('lyric_cache') ? { name: 'lyric_cache' } : null;
          }
          if (s.includes('FROM lyric_cache')) {
            stats.reads += 1;
            return rows.get(String(bound[0])) || null;
          }
          if (s.includes('FROM tracks')) return tracks.get(String(bound[0])) || null;
          return null;
        },
        async run() {
          if (s.includes('INSERT INTO lyric_cache')) {
            stats.writes += 1;
            const [id, lrc, tlrc, rlrc] = bound;
            rows.set(String(id), { lrc, tlrc, rlrc });
          }
          return { success: true };
        },
        async all() {
          return { results: [] };
        },
      };
      return self;
    },
  };
}

/** Counts what the metered upstream was asked for. */
function stubUpstream(reply) {
  const hits = { count: 0 };
  globalThis.fetch = async (input) => {
    const url = String(input?.url ?? input);
    if (url.includes('/163_lyric')) {
      hits.count += 1;
      return new Response(JSON.stringify(reply), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected upstream call: ${url}`);
  };
  return hits;
}

const WORDS = { code: 200, data: { lrc: '[00:01.00]一句', tlyric: '[00:01.00]a line', romalrc: '' } };

/** waitUntil is awaited here, so a write has landed before the next call. */
async function call(db, path) {
  const pending = [];
  const res = await onRequest({
    request: new Request(`https://vplayer.test/api/${path}`),
    env: { DB: db },
    params: { path: path.split('?')[0].split('/') },
    waitUntil: (p) => pending.push(p),
  });
  const body = await res.json().catch(() => ({}));
  await Promise.all(pending);
  return { status: res.status, body, res };
}

/* --------------------------------- runner ---------------------------------- */

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err });
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ---------------------------------- tests ---------------------------------- */

// This one runs first on purpose. lyricCacheReady memoises a positive probe
// for the life of the isolate — correct in production, where the table does
// not get dropped, but it means the table-missing state is only observable
// before some other test has seen the table.
await test('before schema.sql is run it still works, just without the saving', async () => {
  // Code and schema deploy separately. Throwing until somebody runs schema.sql
  // would be worse than paying the upstream for a while longer.
  const db = makeDB({ hasTable: false });
  const hits = stubUpstream(WORDS);
  const { status, body } = await call(db, 'lyric?id=123');
  assert.equal(status, 200);
  assert.equal(body.lrc, '[00:01.00]一句');
  await call(db, 'lyric?id=123');
  assert.equal(hits.count, 2, 'without the table there is nowhere to cache');
});

await test('the second request for a lyric costs nothing upstream', async () => {
  const db = makeDB();
  const hits = stubUpstream(WORDS);

  const first = await call(db, 'lyric?id=123');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.lrc, '[00:01.00]一句');
  assert.equal(hits.count, 1, 'the first call has to go and get it');

  const second = await call(db, 'lyric?id=123');
  assert.equal(second.body.lrc, '[00:01.00]一句');
  assert.equal(hits.count, 1, 'it paid for the same lyric twice');
});

await test('translations survive the round trip', async () => {
  // tracks.lyric is a single column, so serving from the library would have
  // silently dropped these. The cache table keeps all three.
  const db = makeDB();
  stubUpstream(WORDS);
  await call(db, 'lyric?id=123');
  const again = await call(db, 'lyric?id=123');
  assert.equal(again.body.tlrc, '[00:01.00]a line');
});

await test('an empty lyric is not remembered', async () => {
  // Caching one meant a track whose lyric was briefly unavailable never showed
  // lyrics again — the client already learned this the hard way.
  const db = makeDB();
  const hits = stubUpstream({ code: 200, data: { lrc: '' } });
  await call(db, 'lyric?id=404');
  await call(db, 'lyric?id=404');
  assert.equal(hits.count, 2, 'an empty result got cached');
  assert.equal(db.stats.writes, 0);
});

await test('an empty result is not left cacheable at the edge either', async () => {
  const db = makeDB();
  stubUpstream({ code: 200, data: { lrc: '' } });
  const { res } = await call(db, 'lyric?id=404');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

await test('fresh=1 goes past the cache', async () => {
  const db = makeDB();
  const hits = stubUpstream(WORDS);
  await call(db, 'lyric?id=123');
  await call(db, 'lyric?id=123&fresh=1');
  assert.equal(hits.count, 2, 'fresh=1 was served from the cache');
});

await test('a QQ ingest that already stored its lyric is not paid for again', async () => {
  // QQ and KuGou resolves ship lyrics, so an ingested track already has one
  // sitting in tracks.lyric — paying for that one again would be particularly
  // silly.
  const db = makeDB({ tracks: new Map([['qq:abc', { lyric: '[00:02.00]来自入库' }]]) });
  const hits = stubUpstream(WORDS);
  const { body } = await call(db, 'lyric?id=qq:abc');
  assert.equal(body.lrc, '[00:02.00]来自入库');
  assert.equal(hits.count, 0, 'it went upstream for a lyric it already had');
});

/* --------------------------- capture during ingest ------------------------- */

/**
 * The point of doing this at ingest: the deployment buys one lyric either way,
 * but at ingest it is the owner buying it once, not whichever member plays the
 * track first buying it again on every phone they own.
 *
 * These call cacheLyricOnIngest through the module rather than through a full
 * approval, which would need R2, the members table and an audio fetch to say
 * anything about lyrics.
 */
const { __test } = await import('../functions/api/[[path]].js');

await test('a ride-along lyric is stored without an upstream call', async () => {
  const db = makeDB();
  const hits = stubUpstream(WORDS);
  await __test.cacheLyricOnIngest(
    { DB: db },
    'https://vplayer.test',
    'qq:xyz',
    { lyric: '[00:03.00]随解析而来' }
  );
  assert.equal(hits.count, 0, 'QQ ships the lyric; nothing should have been bought');
  assert.equal(db.rows.get('qq:xyz')?.lrc, '[00:03.00]随解析而来');
});

await test('a NetEase ingest buys the lyric once, at ingest', async () => {
  const db = makeDB();
  const hits = stubUpstream(WORDS);
  await __test.cacheLyricOnIngest({ DB: db }, 'https://vplayer.test', '777', { lyric: '' });
  assert.equal(hits.count, 1);

  // And now the first member to play it pays nothing.
  const played = await call(db, 'lyric?id=777');
  assert.equal(played.body.lrc, '[00:01.00]一句');
  assert.equal(hits.count, 1, 'the ingest capture did not actually land');
});

await test('a track already cached from an earlier play is not bought again', async () => {
  const db = makeDB({ rows: new Map([['888', { lrc: '[00:04.00]早就有了', tlrc: '', rlrc: '' }]]) });
  const hits = stubUpstream(WORDS);
  await __test.cacheLyricOnIngest({ DB: db }, 'https://vplayer.test', '888', { lyric: '' });
  assert.equal(hits.count, 0, 'somebody played it before ingest; the words were here');
  assert.equal(db.rows.get('888').lrc, '[00:04.00]早就有了', 'it overwrote a good lyric');
});

await test('a failed lyric capture does not throw at the ingest', async () => {
  // The track is in the library whether or not its words came along, so this
  // has to swallow everything — it runs inside waitUntil, where a rejection is
  // an unhandled one.
  const db = makeDB();
  globalThis.fetch = async () => {
    throw new Error('upstream on fire');
  };
  await __test.cacheLyricOnIngest({ DB: db }, 'https://vplayer.test', '999', { lyric: '' });
  assert.equal(db.stats.writes, 0);
});

/* --------------------------------- report ---------------------------------- */

let failed = 0;
for (const r of results) {
  if (r.ok) console.log(`  \u2713 ${r.name}`);
  else {
    failed += 1;
    console.log(`  \u2717 ${r.name}`);
    console.log(`      ${String(r.err.message).split('\n')[0]}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
