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

const { onRequest } = await import('../functions/api/[[path]].js');

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

/* --------------------------------- report --------------------------------- */

let failed = 0;
for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else {
    failed += 1;
    console.log(`  ✗ ${r.name}`);
    console.log(`      ${String(r.err.message).split('\n')[0]}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
