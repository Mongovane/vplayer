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
  // `private`, never `public`: this route is behind the member gate, and a
  // CDN keyed without the token would serve one member's answer to another.
  assert.match(res.headers.get('cache-control') || '', /^private, max-age=1800$/);
});

await test('a truncated chart list is an error, not zero charts', async () => {
  stubUpstream({ [TOPLIST]: brokenJson });
  const { status, json } = await call('charts');
  assert.equal(status, 502, `expected 502, got ${status}: ${JSON.stringify(json)}`);
  assert.notEqual(json.ok, true, 'a parse failure reported success');
});

await test('a NetEase refusal on the chart list is a non-retryable 503', async () => {
  stubUpstream({ [TOPLIST]: () => jsonRes({ code: -460, msg: 'Cheating' }) });
  const { status, json } = await call('charts');
  // Not a 502: -460/-461/-462 attach to the egress IP and last minutes, so the
  // client has to be told to stop rather than to try harder.
  assert.equal(status, 503, `expected 503, got ${status}: ${JSON.stringify(json)}`);
  assert.equal(json.retryable, false, 'without this the client hammers a wall three times');
  assert.match(json.error || '', /-460/);
});

await test('the chart list is asked for with a mainland source IP', async () => {
  let seen = null;
  globalThis.fetch = async (input, init) => {
    seen = new Headers(init?.headers);
    return okList();
  };
  await call('charts');
  assert.equal(seen.get('x-real-ip'), '116.25.146.177', 'the -460/-462 workaround is missing');
  assert.match(seen.get('cookie') || '', /os=pc/);
});

/* ------------------------------ one chart's tracks ------------------------- */

await test('a chart that returns tracks inline is served, and cached', async () => {
  stubUpstream({ [DETAIL]: () => jsonRes({ code: 200, playlist: { name: '飙升榜', tracks: [song(1), song(2)] } }) });
  const { status, json, res } = await call('charts?id=19723756');
  assert.equal(status, 200);
  assert.equal(json.tracks.length, 2);
  assert.equal(json.tracks[0].id, '1');
  // `private`, never `public`: this route is behind the member gate, and a
  // CDN keyed without the token would serve one member's answer to another.
  assert.match(res.headers.get('cache-control') || '', /^private, max-age=1800$/);
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

await test('a refusal on the detail call is a non-retryable 503', async () => {
  stubUpstream({
    [DETAIL]: () => jsonRes({ code: 200, playlist: { name: '热歌榜', tracks: [], trackIds: [{ id: 1 }] } }),
    [SONGS]: () => jsonRes({ code: -462, msg: '需要验证' }),
  });
  const { status, json } = await call('charts?id=19723756');
  assert.equal(status, 503);
  assert.equal(json.retryable, false);
  assert.match(json.error || '', /-462/);
});

await test('a body with no playlist at all is an error', async () => {
  stubUpstream({ [DETAIL]: () => jsonRes({ code: 200 }) });
  const { status } = await call('charts?id=19723756');
  assert.equal(status, 502);
});

await test('no tracks and no ids is a stripped response, not an empty chart', async () => {
  // `code: 200` with both lists gone is what risk control looks like when it
  // doesn't bother setting a code. Official charts are curated and never
  // empty, so reporting this as emptiness put "这个榜单是空的" under 电音榜.
  stubUpstream({ [DETAIL]: () => jsonRes({ code: 200, playlist: { name: '电音榜', tracks: [], trackIds: [] } }) });
  const { status, json } = await call('charts?id=1899724206');
  assert.equal(status, 502, `expected 502, got ${status}: ${JSON.stringify(json)}`);
  assert.notEqual(json.ok, true);
});

await test('the chart detail tries the keyed upstream before music.163.com', async () => {
  // The upstream serves playlists with a key from an egress NetEase does not
  // risk-control, and a chart is a playlist. This is the fix for -462, not a
  // nicety: music.163.com should not be reached at all when this works.
  let direct = 0;
  stubUpstream({
    '/163_playlist': () =>
      jsonRes({ data: { id: 19723756, name: '飙升榜', tracks: [song(7), song(8)] } }),
    'music.163.com': () => {
      direct += 1;
      return jsonRes({ code: -462 });
    },
  });
  const { status, json } = await call('charts?id=19723756');
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(json)}`);
  assert.deepEqual(json.tracks.map((t) => t.id), ['7', '8']);
  assert.equal(direct, 0, 'it fell through to the direct call despite the upstream working');
});

await test('a failing upstream falls back to music.163.com', async () => {
  stubUpstream({
    '/163_playlist': () => new Response('nope', { status: 500 }),
    [DETAIL]: () => jsonRes({ code: 200, playlist: { name: '飙升榜', tracks: [song(9)] } }),
  });
  const { status, json } = await call('charts?id=19723756');
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(json)}`);
  assert.equal(json.tracks[0].id, '9');
});

/* --------------------------------- report ---------------------------------- */

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`  ${r.ok ? '\u2713' : '\u2717'} ${r.name}`);
  if (!r.ok) console.log(`      ${r.err?.message}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
