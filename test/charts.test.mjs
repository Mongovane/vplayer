/**
 * The charts route, and the one property it kept getting wrong.
 *
 * Every failure mode of this endpoint used to arrive at the browser as
 * `{ ok: true, tracks: [] }` — a truncated body, a NetEase refusal, a failed
 * second call for the track details. The client then said "这个榜单是空的",
 * which is a claim about the chart rather than about the request, and the
 * response carried `max-age=1800`, so the edge repeated the claim for half an
 * hour. That combination is what made it look intermittent: the retry never
 * left the browser.
 *
 * So what is asserted here is not "the happy path works" but "a failure is
 * shaped like a failure", and separately that nothing empty is ever cacheable.
 *
 *   node test/charts.test.mjs
 */

import assert from 'node:assert/strict';

const { onRequest } = await import('../functions/api/[[path]].js');

/* ------------------------------ fetch stubbing ----------------------------- */

const realFetch = globalThis.fetch;

/**
 * Answer upstream calls from a table keyed by a substring of the url.
 *
 * A url no entry matches is a test that has drifted away from the code, so it
 * throws rather than returning something plausible.
 */
function stubUpstream(routes) {
  globalThis.fetch = async (input) => {
    const url = String(input?.url ?? input);
    for (const [needle, reply] of Object.entries(routes)) {
      if (url.includes(needle)) return reply();
    }
    throw new Error(`test stub has no answer for ${url}`);
  };
}

const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const brokenJson = () => new Response('{"playlist":{"trac', { status: 200 });

const TOPLIST = '/api/toplist/detail';
const DETAIL = '/api/v6/playlist/detail';
const SONGS = '/api/v3/song/detail';

/** Call the worker the way Pages Functions does. Charts need no bindings. */
async function call(path) {
  const request = new Request(`https://vplayer.test/api/${path}`);
  const res = await onRequest({
    request,
    env: {},
    params: { path: path.split('?')[0].split('/') },
    waitUntil: () => {},
  });
  return { status: res.status, json: await res.json().catch(() => ({})), res };
}

/* --------------------------------- fixtures -------------------------------- */

const song = (id) => ({ id, name: `Song ${id}`, ar: [{ name: 'A' }], al: { name: 'Al', picUrl: 'http://x/y.jpg' } });

const okList = () => jsonRes({ code: 200, list: [{ id: 19723756, name: '飙升榜', updateFrequency: '每天更新', coverImgUrl: 'http://c/1.jpg', trackCount: 100 }] });

/* ---------------------------------- runner --------------------------------- */

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

/* ------------------------------- the chart list ---------------------------- */

await test('a chart list that arrives is served, and cached', async () => {
  stubUpstream({ [TOPLIST]: okList });
  const { status, json, res } = await call('charts');
  assert.equal(status, 200);
  assert.equal(json.charts.length, 1);
  assert.equal(json.charts[0].id, '19723756');
  assert.match(res.headers.get('cache-control') || '', /max-age=1800/);
});

await test('a truncated chart list is an error, not zero charts', async () => {
  stubUpstream({ [TOPLIST]: brokenJson });
  const { status, json } = await call('charts');
  assert.equal(status, 502, `expected 502, got ${status}: ${JSON.stringify(json)}`);
  assert.notEqual(json.ok, true, 'a parse failure reported success');
});

await test('a NetEase refusal on the chart list is an error', async () => {
  stubUpstream({ [TOPLIST]: () => jsonRes({ code: -460, msg: 'Cheating' }) });
  const { status, json } = await call('charts');
  assert.equal(status, 502);
  assert.match(json.error || '', /-460/, 'the upstream code should reach the log');
});

/* ------------------------------ one chart's tracks ------------------------- */

await test('a chart that returns tracks inline is served, and cached', async () => {
  stubUpstream({ [DETAIL]: () => jsonRes({ code: 200, playlist: { name: '飙升榜', tracks: [song(1), song(2)] } }) });
  const { status, json, res } = await call('charts?id=19723756');
  assert.equal(status, 200);
  assert.equal(json.tracks.length, 2);
  assert.equal(json.tracks[0].id, '1');
  assert.match(res.headers.get('cache-control') || '', /max-age=1800/);
});

await test('a chart that returns only ids is filled in, in rank order', async () => {
  stubUpstream({
    [DETAIL]: () => jsonRes({ code: 200, playlist: { name: '热歌榜', tracks: [], trackIds: [{ id: 3 }, { id: 1 }, { id: 2 }] } }),
    // Deliberately out of order: song/detail does not preserve the request
    // order, and the chart's order is the whole point of a chart.
    [SONGS]: () => jsonRes({ code: 200, songs: [song(1), song(2), song(3)] }),
  });
  const { status, json } = await call('charts?id=19723756');
  assert.equal(status, 200);
  assert.deepEqual(json.tracks.map((t) => t.id), ['3', '1', '2']);
});

await test('a failed detail call is an error, not an empty chart', async () => {
  // This is the path 热歌榜 / 飙升榜 / 新歌榜 all take, and the one that used
  // to fall through to `tracks: []` with `ok: true`.
  stubUpstream({
    [DETAIL]: () => jsonRes({ code: 200, playlist: { name: '热歌榜', tracks: [], trackIds: [{ id: 1 }] } }),
    [SONGS]: () => new Response('upstream sad', { status: 503 }),
  });
  const { status, json } = await call('charts?id=19723756');
  assert.equal(status, 502, `expected 502, got ${status}: ${JSON.stringify(json)}`);
  assert.notEqual(json.ok, true);
});

await test('a truncated detail body is an error, not an empty chart', async () => {
  stubUpstream({
    [DETAIL]: () => jsonRes({ code: 200, playlist: { name: '热歌榜', tracks: [], trackIds: [{ id: 1 }] } }),
    [SONGS]: brokenJson,
  });
  const { status } = await call('charts?id=19723756');
  assert.equal(status, 502);
});

await test('a refusal on the detail call is an error', async () => {
  stubUpstream({
    [DETAIL]: () => jsonRes({ code: 200, playlist: { name: '热歌榜', tracks: [], trackIds: [{ id: 1 }] } }),
    [SONGS]: () => jsonRes({ code: -460, msg: 'Cheating' }),
  });
  const { status, json } = await call('charts?id=19723756');
  assert.equal(status, 502);
  assert.match(json.error || '', /-460/);
});

await test('a body with no playlist at all is an error', async () => {
  stubUpstream({ [DETAIL]: () => jsonRes({ code: 200 }) });
  const { status } = await call('charts?id=19723756');
  assert.equal(status, 502);
});

await test('a genuinely empty chart is reported as empty, and never cached', async () => {
  // The one case where `tracks: []` is the truth. It still must not be stored:
  // an empty chart is cheap to re-ask and expensive to be wrong about.
  stubUpstream({ [DETAIL]: () => jsonRes({ code: 200, playlist: { name: '空榜', tracks: [], trackIds: [] } }) });
  const { status, json, res } = await call('charts?id=1');
  assert.equal(status, 200);
  assert.equal(json.tracks.length, 0);
  assert.equal(res.headers.get('cache-control'), 'no-store', 'an empty chart was left cacheable');
});

/* --------------------------------- report ---------------------------------- */

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`  ${r.ok ? '\u2713' : '\u2717'} ${r.name}`);
  if (!r.ok) console.log(`      ${r.err?.message}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
