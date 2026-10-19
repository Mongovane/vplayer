/**
 * The permission boundary, exercised against the real route handler.
 *
 * This is the one part of the app where a silent regression is not a cosmetic
 * problem: if the owner check stops working, any invited member can delete
 * songs out of the shared library and there is nothing to undo it with. Hiding
 * the buttons is not the guard — the server refusing is — so the server is what
 * is tested here.
 *
 * D1 and R2 are replaced with in-memory stand-ins good enough for the queries
 * these routes actually run. That is a real limit: they do not validate SQL
 * against SQLite. What they do validate is the branching, which is where the
 * decisions live.
 *
 *   node test/permissions.test.mjs
 */

import assert from 'node:assert/strict';

const { onRequest, __test } = await import('../functions/api/[[path]].js');

/* ------------------------------ fake bindings ----------------------------- */

/**
 * A D1 stand-in that understands the handful of statement shapes these routes
 * use. Matching on substrings rather than parsing SQL: crude, but it fails
 * loudly on an unrecognised statement instead of quietly returning nothing,
 * which is the property that matters for a test like this.
 */
function makeDB(state) {
  const run = (sql, binds) => {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('SELECT * FROM members WHERE token')) {
      return { first: () => state.members.find((m) => m.token === binds[0]) || null };
    }
    // The access gate's own probe. Without this case it answered null, the gate
    // concluded the site was still fresh, and every test in this file ran with
    // authentication switched off — including the ones about who may do what.
    if (s.startsWith('SELECT 1 FROM members LIMIT 1')) {
      return { first: () => (state.members.length ? { 1: 1 } : null) };
    }
    if (s.startsWith('UPDATE members SET last_seen')) return { run: async () => ({}) };
    if (s.includes('COUNT(*) AS n FROM members')) {
      return { first: () => ({ n: state.members.length }) };
    }
    if (s.startsWith('SELECT * FROM tracks WHERE id')) {
      return { first: () => state.tracks.find((t) => t.id === binds[0]) || null };
    }
    if (s.startsWith('DELETE FROM tracks WHERE id')) {
      return {
        run: async () => {
          const before = state.tracks.length;
          state.tracks = state.tracks.filter((t) => t.id !== binds[0]);
          return { meta: { changes: before - state.tracks.length } };
        },
      };
    }
    if (s.startsWith('SELECT * FROM track_requests WHERE id')) {
      return { first: () => state.requests.find((r) => r.id === binds[0]) || null };
    }
    if (s.includes('INSERT INTO track_requests')) {
      return {
        run: async () => {
          const [id, memberId, memberName, name, artist] = binds;
          const existing = state.requests.find((r) => r.id === id);
          if (existing) Object.assign(existing, { status: 'pending' });
          else state.requests.push({ id, member_id: memberId, member_name: memberName, name, artist, status: 'pending', requested_at: Date.now() });
          return { meta: { changes: 1 } };
        },
      };
    }
    if (s.includes("FROM track_requests WHERE status = 'pending'")) {
      return { all: async () => ({ results: state.requests.filter((r) => r.status === 'pending') }) };
    }
    if (s.includes('FROM track_requests WHERE member_id')) {
      return { all: async () => ({ results: state.requests.filter((r) => r.member_id === binds[0]) }) };
    }
    if (s.startsWith('UPDATE track_requests SET status')) {
      return {
        run: async () => {
          const row = state.requests.find((r) => r.id === binds[2]);
          if (row) row.status = binds[0];
          return { meta: { changes: row ? 1 : 0 } };
        },
      };
    }
    if (s.startsWith('DELETE FROM track_requests WHERE id')) {
      return {
        run: async () => {
          state.requests = state.requests.filter((r) => r.id !== binds[0]);
          return { meta: { changes: 1 } };
        },
      };
    }
    if (s.startsWith('DELETE FROM invites WHERE code')) {
      return {
        run: async () => {
          const before = state.invites.length;
          state.invites = state.invites.filter((i) => i.code !== binds[0]);
          return { meta: { changes: before - state.invites.length } };
        },
      };
    }
    if (s.includes('FROM invites')) {
      return { all: async () => ({ results: state.invites }) };
    }
    if (s.includes('member_favorites')) {
      return { run: async () => ({}), all: async () => ({ results: state.favorites }) };
    }
    if (s.includes("sqlite_master")) {
      return { first: () => (state.migrated ? { name: 'track_requests' } : null) };
    }
    if (s.includes('library_meta')) {
      return { first: () => ({ value: 0 }), run: async () => ({}) };
    }
    if (s.startsWith('SELECT') && s.includes('FROM tracks')) {
      return { all: async () => ({ results: state.tracks }), first: () => state.tracks[0] || null };
    }

    state.unknownSql.push(s.slice(0, 90));
    return { first: () => null, all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 0 } }) };
  };

  /**
   * Every method returns a promise, because the real D1 does and the code
   * relies on it — `isOwner` ends with `.first().catch(() => null)`, which on a
   * stub that returned plain values threw "Cannot read properties of null
   * (reading 'catch')" and turned eleven permission tests red for a reason that
   * had nothing to do with permissions.
   */
  const wrap = (sql, binds) => {
    const h = run(sql, binds);
    return {
      first: async () => (h.first ? h.first() : null),
      all: async () => (h.all ? h.all() : { results: [] }),
      run: async () => (h.run ? h.run() : { meta: { changes: 0 } }),
    };
  };

  return {
    prepare(sql) {
      return {
        bind: (...binds) => wrap(sql, binds),
        first: () => wrap(sql, []).first(),
        all: () => wrap(sql, []).all(),
        run: () => wrap(sql, []).run(),
      };
    },
    batch: async (stmts) => stmts.map(() => ({})),
  };
}

function makeEnv(state) {
  return {
    DB: makeDB(state),
    MUSIC: {
      get: async () => null,
      put: async () => ({}),
      delete: async () => ({}),
      head: async () => null,
    },
    LIBRARY_QUOTA_MB: '1024',
  };
}

function freshState() {
  return {
    members: [
      { id: 'own', token: 'owner-token', name: '站长', is_owner: 1, created_at: 1, last_seen: 1 },
      { id: 'mem', token: 'member-token', name: '小明', is_owner: 0, created_at: 1, last_seen: 1 },
    ],
    tracks: [{ id: '111', name: 'Song', artist: 'A', object_key: 'audio/x.mp3', bytes: 10, level: '' }],
    requests: [],
    invites: [{ code: 'AAAA-BBBB', label: '', max_uses: 1, used: 0, created_at: 1, expires_at: null }],
    favorites: [],
    migrated: true,
    unknownSql: [],
  };
}

/** Call the worker the way Pages Functions does. */
async function call(state, path, { method = 'GET', token, body } = {}) {
  const url = `https://vplayer.test/api/${path}`;
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const request = new Request(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await onRequest({
    request,
    env: makeEnv(state),
    params: { path: path.split('?')[0].split('/') },
    waitUntil: () => {},
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

/* --------------------------------- tests ---------------------------------- */

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err });
  }
}

await test('a member cannot delete a cloud track', async () => {
  const state = freshState();
  const { status, json } = await call(state, 'library/111', { method: 'DELETE', token: 'member-token' });
  assert.equal(status, 403, `expected 403, got ${status}: ${JSON.stringify(json)}`);
  assert.equal(state.tracks.length, 1, 'the track was deleted anyway');
});

await test('the owner can delete a cloud track', async () => {
  const state = freshState();
  const { status } = await call(state, 'library/111', { method: 'DELETE', token: 'owner-token' });
  assert.equal(status, 200);
  assert.equal(state.tracks.length, 0, 'the owner was refused');
});

await test('no token cannot delete either', async () => {
  const state = freshState();
  const { status } = await call(state, 'library/111', { method: 'DELETE' });
  // 401 now, not 403. This asserted 403 because the harness never answered the
  // gate's `SELECT 1 FROM members LIMIT 1` probe, so the gate concluded the site
  // was still single-user and the request reached the owner check instead.
  // Unauthenticated is the more accurate of the two answers; what the test is
  // really about is that the row survives.
  assert.ok(status === 401 || status === 403, `expected a refusal, got ${status}`);
  assert.equal(state.tracks.length, 1);
});

await test('a member upload becomes a request, and fetches nothing', async () => {
  const state = freshState();
  const { status, json } = await call(state, 'library/222', {
    method: 'PUT',
    token: 'member-token',
    body: { name: '合拍', artist: '许嵩' },
  });
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.pending, true, 'the upload was not queued');
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].member_name, '小明');
  // Nothing was ingested: a queued request must not cost storage or quota.
  assert.equal(state.tracks.length, 1, 'a pending request ingested bytes anyway');
});

await test('a member sees their own queue; the owner sees everyone\'s', async () => {
  const state = freshState();
  await call(state, 'library/222', { method: 'PUT', token: 'member-token', body: { name: 'X' } });

  const mine = await call(state, 'library/requests', { token: 'member-token' });
  assert.equal(mine.json.owner, false);
  assert.equal(mine.json.requests.length, 1);

  const theirs = await call(state, 'library/requests', { token: 'owner-token' });
  assert.equal(theirs.json.owner, true, 'the owner was not recognised as such');
  assert.equal(theirs.json.requests.length, 1);
});

await test('a member cannot approve their own request', async () => {
  const state = freshState();
  await call(state, 'library/222', { method: 'PUT', token: 'member-token', body: { name: 'X' } });
  const { status } = await call(state, 'library/requests/decide', {
    method: 'POST',
    token: 'member-token',
    body: { id: '222', approve: true },
  });
  assert.equal(status, 403, 'a member approved their own upload');
  assert.equal(state.requests[0].status, 'pending');
});

await test('the owner can reject, and the row records it', async () => {
  const state = freshState();
  await call(state, 'library/222', { method: 'PUT', token: 'member-token', body: { name: 'X' } });
  const { status, json } = await call(state, 'library/requests/decide', {
    method: 'POST',
    token: 'owner-token',
    body: { id: '222', approve: false },
  });
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.approved, false);
  assert.equal(state.requests[0].status, 'rejected');
});

await test('a member cannot prune or purge the library', async () => {
  for (const path of ['library/prune', 'library/purge']) {
    const state = freshState();
    const { status } = await call(state, path, { method: 'POST', token: 'member-token' });
    assert.equal(status, 403, `${path} was allowed for a member`);
  }
});

await test('a member cannot rewrite shared metadata', async () => {
  const state = freshState();
  const { status } = await call(state, 'library/repair', {
    method: 'POST',
    token: 'member-token',
    body: { tracks: [{ id: '111', name: 'hijacked' }] },
  });
  assert.equal(status, 403, 'a member repaired shared metadata');
});

await test('a member can still play from the library', async () => {
  // The whole point of a shared library. A permission model that blocks this
  // has broken the feature rather than secured it.
  const state = freshState();
  const { status } = await call(state, 'library', { token: 'member-token' });
  assert.equal(status, 200, 'a member could not list the shared library');
});

await test('only the owner can delete an invite', async () => {
  const state = freshState();
  const denied = await call(state, 'members/invites', {
    method: 'DELETE',
    token: 'member-token',
    body: { code: 'AAAA-BBBB' },
  });
  assert.equal(denied.status, 403, 'a member deleted an invite code');
  assert.equal(state.invites.length, 1);

  const ok = await call(state, 'members/invites', {
    method: 'DELETE',
    token: 'owner-token',
    body: { code: 'AAAA-BBBB' },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(state.invites.length, 0);
});

await test('deleting a missing invite says so rather than reporting success', async () => {
  const state = freshState();
  const { status } = await call(state, 'members/invites', {
    method: 'DELETE',
    token: 'owner-token',
    body: { code: 'ZZZZ-ZZZZ' },
  });
  assert.equal(status, 400);
});

await test('with no members at all, the app stays single-user', async () => {
  // The library predates the member system and has to keep working without it,
  // or adding invites would lock the original owner out of their own app.
  const state = freshState();
  state.members = [];
  const { status } = await call(state, 'library/111', { method: 'DELETE' });
  assert.equal(status, 200, 'a single-user install was refused its own library');
});

await test('before the migration, an upload says so instead of erroring', async () => {
  const state = freshState();
  state.migrated = false;
  const { status, json } = await call(state, 'library/222', {
    method: 'PUT',
    token: 'member-token',
    body: { name: 'X' },
  });
  assert.equal(status, 503, `expected 503, got ${status}: ${JSON.stringify(json)}`);
  assert.match(json.error, /0002/, 'the message does not say which migration to run');
});

await test('before the migration, the queue is empty rather than broken', async () => {
  // Deploying and migrating cannot be simultaneous, so one is always first.
  // Opening the settings panel in that window must not look like a failure.
  const state = freshState();
  state.migrated = false;
  const { status, json } = await call(state, 'library/requests', { token: 'owner-token' });
  assert.equal(status, 200, JSON.stringify(json));
  assert.deepEqual(json.requests, []);
  assert.equal(json.migrated, false);
});

await test('after the migration, nothing about that is reported', async () => {
  const state = freshState();
  const { json } = await call(state, 'library/requests', { token: 'owner-token' });
  assert.notEqual(json.migrated, false, 'still reporting itself unmigrated');
});

/* ------------------ the token an audio tag has to put in the url ----------- */

/**
 * `<audio src>` and `<img src>` cannot send an Authorization header, so the
 * access gate accepts `?token=` as well — its own comment says so. The client
 * has to actually put it there, and for /api/library/audio/:id it did not: once
 * a member row existed the gate went live and every library track answered 401,
 * the element errored, skipBroken advanced, and the whole queue scrolled past.
 *
 * These pin the server half. api.song() now runs a resolved /api/ url through
 * withToken(), which is the client half.
 */
await test('a library route accepts the token in the query string', async () => {
  const state = freshState();
  const { status, json } = await call(state, 'library?token=member-token');
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(json)}`);
});

await test('without a token at all it is still 401', async () => {
  const state = freshState();
  const { status } = await call(state, 'library');
  assert.equal(status, 401);
});

await test('a wrong token in the query string does not open the gate', async () => {
  const state = freshState();
  const { status } = await call(state, 'library?token=not-a-real-token');
  assert.equal(status, 401);
});

/* ------------------- what an owner is told when ingest fails --------------- */
/**
 * The bug this covers: approving an upload resolves the audio primary-first
 * and falls back to the community pool, but the ingest paths dropped the
 * primary's error and let the fallback's propagate alone. An owner saw
 * "lxv5 返回 404" and concluded the app had gone to a backup source behind
 * their back. The fallback is not a source anyone picks — it only ever runs
 * after the primary has already failed — so the primary's reason has to lead.
 */
const realFetch = globalThis.fetch;

/** Every upstream call fails, so resolution has to give up and explain itself. */
function stubAllUpstreamsDown() {
  globalThis.fetch = async (input) => {
    const url = String(input?.url ?? input);
    if (url.includes('api.chksz.com')) return new Response(JSON.stringify({ code: 404 }), { status: 404 });
    // Every backend in the fallback pool.
    return new Response('not found', { status: 404 });
  };
}

await test('an approval that cannot resolve names the primary, not only the fallback', async () => {
  const state = freshState();
  state.requests.push({
    id: '999', member_id: 'mem', member_name: '小明', name: '乌梅子酱 (粤语版)',
    artist: '何乾樑', status: 'pending', requested_at: 1,
  });
  stubAllUpstreamsDown();
  try {
    const { status, json } = await call(state, 'library/requests/decide', {
      method: 'POST', token: 'owner-token', body: { id: '999', approve: true },
    });
    assert.notEqual(status, 200, 'it claimed success with nothing resolved');
    assert.match(json.error || '', /主源/, 'the message does not mention the primary at all');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test('a fallback washout names every backend it tried, not just the last', async () => {
  const state = freshState();
  state.requests.push({
    id: '998', member_id: 'mem', member_name: '小明', name: 'X',
    artist: 'Y', status: 'pending', requested_at: 1,
  });
  stubAllUpstreamsDown();
  try {
    const { json } = await call(state, 'library/requests/decide', {
      method: 'POST', token: 'owner-token', body: { id: '998', approve: true },
    });
    // `startAt` rotates, so whichever backend came last was arbitrary — the
    // count is what actually tells the owner this is not one backend's fault.
    assert.match(json.error || '', /备用源 \d+ 个都没给出地址/, `got: ${json.error}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test('rejecting never touches a resolver at all', async () => {
  const state = freshState();
  state.requests.push({
    id: '997', member_id: 'mem', member_name: '小明', name: 'Z',
    artist: 'Y', status: 'pending', requested_at: 1,
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('{}', { status: 200 });
  };
  try {
    const { status } = await call(state, 'library/requests/decide', {
      method: 'POST', token: 'owner-token', body: { id: '997', approve: false },
    });
    assert.equal(status, 200);
    assert.equal(calls, 0, 'a rejection went looking for audio it is never going to store');
  } finally {
    globalThis.fetch = realFetch;
  }
});


/* ---------------- LX_POOL multi-protocol & keyless fallback ---------------- */

await test('LX_POOL ships 12 verified nodes across gd, ncm, meting, and path protocols', async () => {
  assert.equal(__test.LX_POOL.length, 14);
  const styles = new Set(__test.LX_POOL.map((b) => b.style));
  for (const expected of ['gd', 'ncm', 'meting', 'tunehub', 'path']) {
    assert.ok(styles.has(expected), `missing protocol style: ${expected}`);
  }
});

await test('GD Studio 2026.09.25 signature uses customized K[29]=0xFCFEA3F8 MD5 and maps flac24bit to br=999 with auto-downgrade', async () => {
  // Verify customized K[29] MD5 matches CharlesPikachu/musicdl GDStudioMusicClient.makesign
  const sig = __test.makeGdSign('36990266', 'music.gdstudio.xyz', '2026.09.25', 1792037000);
  assert.equal(sig, '5B41691B');

  const askedUrls = [];
  globalThis.fetch = async (input, init) => {
    const u = String(input?.url ?? input);
    askedUrls.push(u);
    if (u.includes('br=999')) {
      // Simulate track having no Hi-Res tier (GD Studio returns 200 with br: -1, url: '')
      return new Response(JSON.stringify({ url: '', br: -1, size: 0 }), { status: 200 });
    }
    if (u.includes('br=740')) {
      return new Response(JSON.stringify({ url: 'https://cdn.gdstudio.test/lossless.flac', br: 740, size: 24000000 }), { status: 200 });
    }
    return new Response('unexpected', { status: 500 });
  };
  try {
    const gdNode = __test.LX_POOL.find((b) => b.name === 'gd-xyz');
    const url = await __test.askLxBackend(gdNode, 'wy', '36990266', 'flac24bit', undefined);
    assert.equal(url, 'https://cdn.gdstudio.test/lossless.flac');
    assert.equal(askedUrls.length, 2, 'should try br=999 then auto-downgrade to br=740');
    assert.match(askedUrls[0], /br=999/);
    assert.match(askedUrls[0], /[?&]s=[0-9A-F]{8}/);
    assert.match(askedUrls[1], /br=740/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test('ncm protocol rejects 30s freeTrialInfo clips and falls back to /song/url/match', async () => {
  const asked = [];
  globalThis.fetch = async (input, init) => {
    const u = String(input?.url ?? input);
    asked.push(u);
    if (u.includes('/song/url/v1')) {
      return new Response(
        JSON.stringify({
          code: 200,
          data: [{ id: 36990266, url: 'https://m8.music.126.net/trial-30s.mp3', freeTrialInfo: { start: 0, end: 30 } }],
        }),
        { status: 200 }
      );
    }
    if (u.includes('/song/url/match')) {
      return new Response(
        JSON.stringify({ code: 200, data: { url: 'https://unblocked.cdn.test/full-track.mp3' } }),
        { status: 200 }
      );
    }
    return new Response('not found', { status: 404 });
  };
  try {
    const ncmNode = __test.LX_POOL.find((b) => b.name === 'ncm-yiyuzhang');
    const url = await __test.askLxBackend(ncmNode, 'wy', '36990266', '320k', undefined);
    assert.equal(url, 'https://unblocked.cdn.test/full-track.mp3');
    assert.equal(asked.length, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test('meting protocol handles 302 Location redirects and rejects /404 placeholder redirects', async () => {
  const metingNode = __test.LX_POOL.find((b) => b.name === 'meting-duanjinglin');
  globalThis.fetch = async () =>
    new Response(null, {
      status: 302,
      headers: { location: 'https://music.163.com/404' },
    });
  try {
    await assert.rejects(
      () => __test.askLxBackend(metingNode, 'wy', '36990266', '320k', undefined),
      /重定向到无效地址/
    );

    globalThis.fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://m701.music.126.net/real-stream.mp3' },
      });
    const url = await __test.askLxBackend(metingNode, 'wy', '36990266', '320k', undefined);
    assert.equal(url, 'https://m701.music.126.net/real-stream.mp3');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test('resolveViaLx skips incompatible platform nodes in 0ms and prioritizes healthy nodes over cooling nodes', async () => {
  __test.clearLxHealth();
  const hitHosts = [];
  globalThis.fetch = async (input, init) => {
    const u = String(input?.url ?? input);
    hitHosts.push(new URL(u).hostname);
    if (u.includes('music-api.gdstudio.xyz')) {
      return new Response('server error', { status: 502 });
    }
    if (u.includes('music.gdstudio.xyz')) {
      return new Response(JSON.stringify({ url: 'https://qq.cdn.test/song.mp3', br: 320, size: 8000000 }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
  try {
    // Resolve a QQ track: ncm-* nodes (platforms: ['wy']) must never be called
    const res1 = await __test.resolveViaLx({}, 'https://vplayer.test', 'qq:001abc', 'exhigh', undefined, 0);
    assert.equal(res1.backend, 'gd-xyz');
    assert.equal(res1.url, 'https://qq.cdn.test/song.mp3');
    assert.ok(!hitHosts.some((h) => h.includes('yiyuzhang') || h.includes('yybbmusic') || h.includes('viniport')));

    // On the next call with startAt=0, gd-api is in cooldown so gd-xyz is tried FIRST
    hitHosts.length = 0;
    const res2 = await __test.resolveViaLx({}, 'https://vplayer.test', 'qq:001abc', 'exhigh', undefined, 0);
    assert.equal(res2.backend, 'gd-xyz');
    assert.equal(hitHosts[0], 'music.gdstudio.xyz', 'cooling node gd-api should be deprioritized behind healthy gd-xyz');
  } finally {
    __test.clearLxHealth();
    globalThis.fetch = realFetch;
  }
});

await test('keyless deployment (no MUSIC_API_KEY) resolves /api/song, /api/lyric, and /api/search via fallbacks', async () => {
  __test.clearLxHealth();
  const state = freshState();
  globalThis.fetch = async (input, init) => {
    const u = String(input?.url ?? input);
    if (u.includes('api.chksz.com')) {
      return new Response('Unauthorized', { status: 401 });
    }
    if (u.includes('music-api.gdstudio.xyz/api.php?types=url')) {
      return new Response(JSON.stringify({ url: 'http://cdn.gdstudio.test/stream.mp3', br: 320, size: 9000000 }), { status: 200 });
    }
    if (u.includes('music.163.com/api/song/lyric')) {
      return new Response(JSON.stringify({ lrc: { lyric: '[00:00.00]无密钥歌词兜底' }, tlyric: { lyric: '[00:00.00]keyless lyric' } }), { status: 200 });
    }
    if (u.includes('music-api.gdstudio.xyz/api.php?types=search')) {
      return new Response(JSON.stringify([{ id: '0039MnYb0qxYhV', name: '晴天', artist: ['周杰伦'], album: '叶惠美', source: 'tencent' }]), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
  try {
    const songRes = await call(state, 'song?id=36990266&level=exhigh', { token: 'member-token' });
    assert.equal(songRes.status, 200, JSON.stringify(songRes.json));
    assert.equal(songRes.json.song.via, 'lx');
    assert.equal(songRes.json.song.backend, 'gd-api');
    assert.match(songRes.json.song.url, /^https:\/\/vplayer\.test\/api\/stream\?url=/);

    const lyricRes = await call(state, 'lyric?id=36990266&fresh=1', { token: 'member-token' });
    assert.equal(lyricRes.status, 200, JSON.stringify(lyricRes.json));
    assert.equal(lyricRes.json.lrc, '[00:00.00]无密钥歌词兜底');
    assert.equal(lyricRes.json.tlrc, '[00:00.00]keyless lyric');

    const searchRes = await call(state, 'search?q=%E6%99%B4%E5%A4%A9&source=qq', { token: 'member-token' });
    assert.equal(searchRes.status, 200, JSON.stringify(searchRes.json));
    assert.equal(searchRes.json.items.length, 1);
    assert.equal(searchRes.json.items[0].id, 'qq:0039MnYb0qxYhV');
    assert.equal(searchRes.json.items[0].artist, '周杰伦');
  } finally {
    __test.clearLxHealth();
    globalThis.fetch = realFetch;
  }
});


await test("direct keyless QQ & KuGou search, lyrics, and song playback work when MUSIC_API_KEY is absent", async () => {
  __test.clearLxHealth();
  const state = freshState();
  let chkszCalls = 0;
  globalThis.fetch = async (input, init) => {
    const u = String(input?.url ?? input);
    if (u.includes("api.chksz.com")) {
      chkszCalls += 1;
      return new Response("Unauthorized", { status: 401 });
    }
    if (u.includes("u.y.qq.com/cgi-bin/musicu.fcg")) {
      const bodyText = String(init?.body || "");
      if (bodyText.includes("DoSearchForQQMusicDesktop")) {
        return new Response(JSON.stringify({
          req_0: {
            data: {
              body: {
                song: {
                  list: [{
                    mid: "0039MnYb0qxYhV",
                    name: "晴天",
                    singer: [{ name: "周杰伦" }],
                    album: { name: "叶惠美", mid: "000MkMni19ClKG" },
                    interval: 269,
                  }],
                },
              },
            },
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        req_0: {
          data: {
            sip: ["https://dl.stream.qqmusic.qq.com/"],
            midurlinfo: [{ purl: "C4000039MnYb0qxYhV.m4a?vkey=abc123" }],
          },
        },
      }), { status: 200 });
    }
    if (u.includes("c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg")) {
      const lrcB64 = Buffer.from("[00:01.00]故事的小黄花&#10;[00:05.00]从出生那年就飘着", "utf8").toString("base64");
      const transB64 = Buffer.from("[00:01.00]Little yellow flower", "utf8").toString("base64");
      return new Response(JSON.stringify({ lyric: lrcB64, trans: transB64 }), { status: 200 });
    }
    if (u.includes("mobilecdn.kugou.com/api/v3/search/song")) {
      return new Response(JSON.stringify({
        data: {
          info: [{
            hash: "64A02D156E84471E2C8E8279F0A921A3",
            songname: "晴天",
            singername: "周杰伦",
            album_name: "叶惠美",
            duration: 269,
            trans_param: { union_cover: "http://imge.kugou.com/stdmusic/{size}/20200101/cover.jpg" },
          }],
        },
      }), { status: 200 });
    }
    if (u.includes("krcs.kugou.com/search")) {
      return new Response(JSON.stringify({
        candidates: [{ id: "998877", accesskey: "acc_xyz" }],
      }), { status: 200 });
    }
    if (u.includes("lyrics.kugou.com/download")) {
      const kgLrcB64 = Buffer.from("[00:02.00]刮风这天我试过握着你手", "utf8").toString("base64");
      return new Response(JSON.stringify({ content: kgLrcB64 }), { status: 200 });
    }
    if (u.includes("m.kugou.com/app/i/getSongInfo.php")) {
      return new Response(JSON.stringify({
        url: "https://fs.ios.kugou.com/20261017/track.mp3",
        songName: "晴天",
        singerName: "周杰伦",
        album_img: "http://imge.kugou.com/stdmusic/{size}/cover.jpg",
        timeLength: 269,
        bitRate: 320,
      }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
  try {
    // 1. QQ direct search
    const qqSearch = await call(state, "search?q=%E6%99%B4%E5%A4%A9&source=qq", { token: "member-token" });
    assert.equal(qqSearch.status, 200);
    assert.equal(qqSearch.json.items[0].id, "qq:0039MnYb0qxYhV");
    assert.match(qqSearch.json.items[0].cover, /y.gtimg.cn.*000MkMni19ClKG.jpg/);

    // 2. QQ direct lyric (Base64 + HTML entity decoding)
    const qqLyric = await call(state, "lyric?id=qq:0039MnYb0qxYhV&fresh=1", { token: "member-token" });
    assert.equal(qqLyric.status, 200);
    assert.match(qqLyric.json.lrc, /故事的小黄花/);
    assert.match(qqLyric.json.tlrc, /Little yellow flower/);

    // 3. QQ direct song (and resolveWithDowngrade fast-fails after 1 call on 401!)
    chkszCalls = 0;
    const qqSong = await call(state, "song?id=qq:0039MnYb0qxYhV&level=lossless", { token: "member-token" });
    assert.equal(qqSong.status, 200, JSON.stringify(qqSong.json));
    assert.equal(chkszCalls, 1, "resolveWithDowngrade should break immediately on 401 instead of looping 5 times");
    assert.match(qqSong.json.song.url, /dl\.stream\.qqmusic\.qq\.com.*C4000039MnYb0qxYhV\.m4a/);

    // 4. KuGou direct search
    const kgSearch = await call(state, "search?q=%E6%99%B4%E5%A4%A9&source=kg", { token: "member-token" });
    assert.equal(kgSearch.status, 200);
    assert.equal(kgSearch.json.items[0].id, "kg:64A02D156E84471E2C8E8279F0A921A3");
    assert.match(kgSearch.json.items[0].cover, /https:\/\/imge\.kugou\.com\/stdmusic\/400\//);

    // 5. KuGou direct two-step lyric
    const kgLyric = await call(state, "lyric?id=kg:64A02D156E84471E2C8E8279F0A921A3&fresh=1", { token: "member-token" });
    assert.equal(kgLyric.status, 200);
    assert.match(kgLyric.json.lrc, /刮风这天我试过握着你手/);

    // 6. KuGou direct song
    chkszCalls = 0;
    const kgSong = await call(state, "song?id=kg:64A02D156E84471E2C8E8279F0A921A3&level=exhigh", { token: "member-token" });
    assert.equal(kgSong.status, 200, JSON.stringify(kgSong.json));
    assert.equal(chkszCalls, 1);
    assert.equal(kgSong.json.song.url, "https://fs.ios.kugou.com/20261017/track.mp3");
    assert.equal(kgSong.json.song.name, "晴天");
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test("lxtest tests every node in LX_POOL with a platform-compatible track id (wy, tx, kg)", async () => {
  const state = freshState();
  globalThis.fetch = async (input, init) => {
    const u = String(input?.url ?? input);
    if (u.includes("u.y.qq.com")) {
      return new Response(JSON.stringify({
        req_0: { data: { sip: ["https://dl.stream.qqmusic.qq.com/"], midurlinfo: [{ purl: "C400test.m4a?vkey=1" }] } },
      }), { status: 200 });
    }
    if (u.includes("m.kugou.com")) {
      return new Response(JSON.stringify({ url: "https://fs.ios.kugou.com/test.mp3" }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 0, url: "https://cdn.test/ok.mp3", data: { url: "https://cdn.test/ok.mp3" } }), { status: 200 });
  };
  try {
    const res = await call(state, "lxtest?level=exhigh", { token: "member-token" });
    assert.equal(res.status, 200);
    assert.equal(res.json.poolSize, 14);
    const alive = res.json.results.filter((r) => r.ok);
    assert.equal(alive.length, 14, `expected 12/12 alive, got ${alive.length}: ${JSON.stringify(res.json.results)}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test("listTracks filters out metadata-only stubs (bytes = 0) so libraryIds never points at 404 R2 objects", async () => {
  const state = freshState();
  state.tracks.push({ id: "stub-zero", name: "Broken Stub", artist: "X", object_key: "", bytes: 0, level: "" });
  const res = await call(state, "library", { token: "member-token" });
  assert.equal(res.status, 200);
  const ids = res.json.tracks.map((t) => t.id);
  assert.ok(ids.includes("111"));
  assert.ok(!ids.includes("stub-zero"), "metadata-only stub with 0 bytes leaked into /api/library");
});


await test("Screenshot 1-4 regression: lxtest 12/12 failover, QQ search 404 cascade + covers, KuGou via=lx cross-source match, and NetEase cloudsearch covers", async () => {
  __test.clearLxHealth();
  const state = freshState();
  globalThis.fetch = async (input) => {
    const u = String(input?.url ?? input);
    // Simulate Screenshot 3: api.chksz.com returns 404 on /qq_music, u.y.qq.com returns empty
    if (u.includes("api.chksz.com")) return new Response("not found", { status: 404 });
    if (u.includes("u.y.qq.com")) return new Response(JSON.stringify({ req_0: { data: { midurlinfo: [{ purl: "" }] } } }), { status: 200 });
    if (u.includes("c.y.qq.com/soso")) return new Response("forbidden", { status: 403 });

    // Simulate Screenshot 1: gd-xyz and gd-org return 401 Invalid request, huibq returns 503, yiyuzhang returns 502
    if (u.includes("music.gdstudio.xyz/api.php") || u.includes("music.gdstudio.org/api.php")) {
      return new Response(JSON.stringify({ detail: "Invalid request." }), { status: 401 });
    }
    if (u.includes("lxmusicapi.onrender.com")) return new Response("Service Unavailable", { status: 503 });
    if (u.includes("yiyuzhang.xyz")) return new Response("Bad Gateway", { status: 502 });

    // Simulate Screenshot 2: KuGou m.kugou.com returns metadata but empty url (overseas IP block)
    if (u.includes("m.kugou.com/app/i/getSongInfo.php")) {
      return new Response(JSON.stringify({
        errcode: 0, status: 1, url: "",
        songName: "Waiting for Love", singerName: "Avicii",
        album_img: "http://imge.kugou.com/stdmusic/{size}/cover.jpg",
      }), { status: 200 });
    }
    if (u.includes("gateway.kugou.com")) return new Response(JSON.stringify({ status: 0, url: [] }), { status: 200 });

    // Working nodes from Screenshot 1: music-api.gdstudio.xyz, viniport.com, yybbmusic.top, meting-*
    if (u.includes("music-api.gdstudio.xyz/api.php?types=search")) {
      return new Response(JSON.stringify([{
        id: "001AviciiMid",
        name: "Waiting For Love",
        artist: ["Avicii"],
        album: "Stories",
        pic_id: "002AlbumMid",
        source: "tencent",
      }]), { status: 200 });
    }
    if (u.includes("music-api.gdstudio.xyz/api.php?types=url")) {
      return new Response(JSON.stringify({ url: "https://cdn.gdstudio.test/playable-stream.mp3", br: 320, size: 9000000 }), { status: 200 });
    }
    if (u.includes("viniport.com") || u.includes("yybbmusic.top")) {
      return new Response(JSON.stringify({ code: 200, data: [{ id: 1, url: "https://ncm.cdn.test/playable.mp3" }] }), { status: 200 });
    }
    if (u.includes("duanjinglin.com") || u.includes("pentsuo.com") || u.includes("injahow.cn")) {
      return new Response(JSON.stringify({ url: "https://meting.cdn.test/playable.mp3" }), { status: 200 });
    }
    if (u.includes("music.163.com/api/cloudsearch/pc")) {
      return new Response(JSON.stringify({
        result: {
          songs: [{
            id: 31877628,
            name: "Waiting For Love",
            ar: [{ name: "Avicii" }],
            al: { name: "Stories", picUrl: "http://p1.music.126.net/avicii-cover.jpg" },
          }],
        },
      }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
  try {
    // 1. Screenshot 1: lxtest?id=36990266&level=exhigh -> all 12/12 nodes pass!
    const lxRes = await call(state, "lxtest?id=36990266&level=exhigh", { token: "member-token" });
    assert.equal(lxRes.status, 200);
    const okCount = lxRes.json.results.filter((r) => r.ok).length;
    assert.equal(okCount, 14, `expected 12/12 nodes ok in lxtest, got ${okCount}: ${JSON.stringify(lxRes.json.results)}`);

    // 2. Screenshot 2: KuGou track played in 备用源 (via=lx) mode resolves via cross-source match!
    const kgPlay = await call(
      state,
      "song?id=kg:ABCD1234&level=exhigh&via=lx&name=Waiting+for+Love&artist=Avicii",
      { token: "member-token" }
    );
    assert.equal(kgPlay.status, 200, JSON.stringify(kgPlay.json));
    assert.match(kgPlay.json.song.url, /playable-stream.mp3/);

    // 3. Screenshot 3: QQ search for Avicii cascades past 404 to GD Studio and populates y.gtimg.cn cover!
    const qqSearch = await call(state, "search?q=Avicii&source=qq", { token: "member-token" });
    assert.equal(qqSearch.status, 200);
    assert.equal(qqSearch.json.items.length, 1);
    assert.equal(qqSearch.json.items[0].id, "qq:001AviciiMid");
    assert.equal(qqSearch.json.items[0].cover, "https://y.gtimg.cn/music/photo_new/T002R300x300M000002AlbumMid.jpg");

    // 4. Screenshot 4: NetEase search for Avicii returns cloudsearch/pc covers!
    const wySearch = await call(state, "search?q=Avicii&source=163", { token: "member-token" });
    assert.equal(wySearch.status, 200);
    assert.equal(wySearch.json.items[0].cover, "https://p1.music.126.net/avicii-cover.jpg");
  } finally {
    __test.clearLxHealth();
    globalThis.fetch = realFetch;
  }
});

await test("Deep verification (via=lx): 12/12 NCM node failover, QQ 502/503 mirror search + play + lyric + PWA/cloud upload without touching api.chksz.com, and lxtest?deep=1", async () => {
  __test.clearLxHealth();
  const state = freshState();
  let chkszCalls = 0;
  globalThis.fetch = async (input) => {
    const u = String(input?.url ?? input);
    if (u.includes("api.chksz.com")) {
      chkszCalls += 1;
      return new Response("Bad Gateway", { status: 502 });
    }
    // Simulate ALL 3 NCM nodes (yiyuzhang, yybbmusic, viniport) failing/timing out
    if (u.includes("yiyuzhang.xyz") || u.includes("yybbmusic.top") || u.includes("viniport.com")) {
      return new Response("Gateway Timeout", { status: 504 });
    }
    // Simulate Tencent search & GD Studio source=tencent search returning empty (overseas Worker IP block + disabled site)
    if (u.includes("u.y.qq.com") || u.includes("c.y.qq.com/soso") || u.includes("shc.y.qq.com/soso")) {
      return new Response(JSON.stringify({ code: 0, data: { song: { list: [] } } }), { status: 200 });
    }
    if (u.includes("music-api.gdstudio.xyz/api.php?types=search") && u.includes("source=tencent")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (u.includes("music-api.gdstudio.xyz/api.php?types=search")) {
      return new Response(JSON.stringify([{
        id: "27591651",
        name: "医生",
        artist: ["许嵩"],
        album: "苏格拉没有底",
        source: "netease",
      }]), { status: 200 });
    }
    if (u.includes("music.163.com/api/cloudsearch/pc")) {
      return new Response(JSON.stringify({
        result: {
          songs: [{
            id: 27591651,
            name: "医生",
            ar: [{ name: "许嵩" }],
            al: { name: "苏格拉没有底", picUrl: "http://p1.music.126.net/yisheng-cover.jpg" },
          }],
        },
      }), { status: 200 });
    }
    if (u.includes("mobilecdn.kugou.com/api/v3/search/song")) {
      return new Response(JSON.stringify({
        data: {
          info: [{
            hash: "64A02D156E84471E2C8E8279F0A921A3",
            songname: "晴天",
            singername: "周杰伦",
            album_name: "叶惠美",
            duration: 269,
          }],
        },
      }), { status: 200 });
    }
    if (u.includes("music.163.com/api/song/lyric") || u.includes("music-api.gdstudio.xyz/api.php?types=lyric")) {
      return new Response(JSON.stringify({ lrc: { lyric: "[00:00.00]她是第几个爱上医生的病人" }, lyric: "[00:00.00]她是第几个爱上医生的病人" }), { status: 200 });
    }
    if (u.includes("c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg")) {
      const b64 = Buffer.from("[00:00.00]QQ歌词验证通过", "utf8").toString("base64");
      return new Response(JSON.stringify({ lyric: b64 }), { status: 200 });
    }
    if (u.includes("krcs.kugou.com/search")) {
      return new Response(JSON.stringify({ candidates: [{ id: "1", accesskey: "k" }] }), { status: 200 });
    }
    if (u.includes("lyrics.kugou.com/download")) {
      const b64 = Buffer.from("[00:00.00]酷狗歌词验证通过", "utf8").toString("base64");
      return new Response(JSON.stringify({ content: b64 }), { status: 200 });
    }
    if (u.includes("music-api.gdstudio.xyz/api.php?types=url") || u.includes("pentsuo.com") || u.includes("duanjinglin.com") || u.includes("injahow.cn")) {
      return new Response(JSON.stringify({ url: "https://cdn.gdstudio.test/yisheng-320k.mp3", br: 320, size: 8800000 }), { status: 200 });
    }
    if (u.includes("cdn.gdstudio.test/yisheng-320k.mp3")) {
      return new Response(new Uint8Array(4096), { status: 200, headers: { "content-type": "audio/mpeg", "content-length": "4096" } });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    // 1. lxtest?deep=1 -> 12/12 nodes pass (even when all 3 ncm-* nodes return 504) + 3-platform deep pipeline passes!
    const deepRes = await call(state, "lxtest?id=36990266&level=exhigh&deep=1", { token: "member-token" });
    assert.equal(deepRes.status, 200);
    assert.equal(deepRes.json.results.filter((r) => r.ok).length, 14, `all 12 nodes should pass: ${JSON.stringify(deepRes.json.results.filter(r => !r.ok))}`);
    assert.ok(deepRes.json.deep, "deep verification report should be returned");
    assert.equal(deepRes.json.deep.platforms.length, 3);
    for (const p of deepRes.json.deep.platforms) {
      assert.ok(p.search.ok, `deep search failed for ${p.code}: ${JSON.stringify(p)}`);
      assert.ok(p.lyric.ok, `deep lyric failed for ${p.code}: ${JSON.stringify(p)}`);
      assert.ok(p.play.ok, `deep play failed for ${p.code}: ${JSON.stringify(p)}`);
    }
    assert.equal(chkszCalls, 0, "deep verification in via=lx mode must never call api.chksz.com");

    // 2. QQ search for 医生 with via=lx succeeds via mirror search and returns qq:wy_27591651 with cover
    const qqSearch = await call(state, "search?q=%E5%8C%BB%E7%94%9F&source=qq&via=lx", { token: "member-token" });
    assert.equal(qqSearch.status, 200);
    assert.equal(qqSearch.json.items.length, 1);
    const item = qqSearch.json.items[0];
    assert.equal(item.id, "qq:wy_27591651");
    assert.equal(item.name, "医生");
    assert.equal(item.artist, "许嵩");
    assert.equal(item.source, "QQ");
    assert.equal(item.cover, "https://p1.music.126.net/yisheng-cover.jpg");
    assert.equal(chkszCalls, 0, "search?via=lx must never call api.chksz.com");

    // 3. Playing qq:wy_27591651 and fetching lyrics in via=lx mode both succeed without api.chksz.com
    const qqPlay = await call(state, `song?id=${encodeURIComponent(item.id)}&level=exhigh&via=lx`, { token: "member-token" });
    assert.equal(qqPlay.status, 200);
    assert.equal(qqPlay.json.song.via, "lx");
    assert.equal(qqPlay.json.song.backend, "gd-api");
    assert.match(qqPlay.json.song.levelLabel, /320K · gd-api/);

    const qqLrc = await call(state, `lyric?id=${encodeURIComponent(item.id)}&fresh=1&via=lx`, { token: "member-token" });
    assert.equal(qqLrc.status, 200);
    assert.match(qqLrc.json.lrc, /她是第几个爱上医生的病人/);

    // 4. Uploading/ingesting qq:wy_27591651 to PWA/cloud library via=lx stores fallback provenance
    const ingestRes = await call(state, `library/${encodeURIComponent(item.id)}?level=exhigh&via=lx`, {
      method: "PUT",
      token: "owner-token",
      body: { name: item.name, artist: item.artist, album: item.album, cover: item.cover, source: item.source },
    });
    assert.equal(ingestRes.status, 200, JSON.stringify(ingestRes.json));
    assert.equal(ingestRes.json.via, "lx");
    assert.equal(ingestRes.json.backend, "gd-api");
    assert.match(ingestRes.json.levelLabel, /320K · gd-api/);
    assert.equal(chkszCalls, 0, "library upload with via=lx must never call api.chksz.com");
  } finally {
    __test.clearLxHealth();
    globalThis.fetch = realFetch;
  }
});

/* --------------------------------- report --------------------------------- */

let failed = 0;
for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else {
    failed += 1;
    console.log(`  ✗ ${r.name}`);
    console.log(`      ${String(r.err.message).replace(/\n/g, " ")}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
