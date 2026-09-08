/**
 * Run schema.sql against real SQLite and check the two things that matter.
 *
 * The only real danger in a single "apply everything" file is that the second
 * run does something different from the first — so it is run twice and the
 * whole database is compared byte for byte. And it is run against a database
 * seeded with the exact mess it exists to clean up, not an empty one, because
 * an empty database makes every data-fix statement pass by doing nothing.
 *
 * D1 is SQLite, but it is not stock SQLite, and that gap has already bitten:
 * a verification query with eight compound-SELECT terms ran fine here — Node's
 * build allows 500 — and was rejected by the D1 console with "too many terms in
 * compound SELECT". So the checks below include D1's own restrictions, not only
 * what SQLite will accept. What is still unchecked is wrangler's statement
 * splitting and any D1 limit nobody has hit yet.
 *
 *   node scripts/check-schema.mjs
 */

import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const SQL = await readFile('schema.sql', 'utf8');
const problems = [];

/** Everything in the database, ordered, as a comparable string. */
function snapshot(db) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);
  const out = [];
  for (const t of tables) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    out.push(`# ${t}(${cols.join(',')})`);
    const rows = db.prepare(`SELECT * FROM ${t}`).all();
    for (const r of rows.map((r) => JSON.stringify(r)).sort()) out.push(`  ${r}`);
  }
  return out.join('\n');
}

/** A database as it stands today: old schema, real data, and the 163_ mess. */
function seedLegacy() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE tracks (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
      artist TEXT NOT NULL DEFAULT '', album TEXT NOT NULL DEFAULT '',
      cover TEXT NOT NULL DEFAULT '', object_key TEXT NOT NULL,
      content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      bytes INTEGER NOT NULL DEFAULT 0, level TEXT NOT NULL DEFAULT '',
      duration INTEGER, lyric TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, last_played INTEGER NOT NULL,
      play_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE library_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE members (
      id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '',
      invite_code TEXT NOT NULL DEFAULT '', is_owner INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL
    );
    CREATE TABLE member_favorites (
      member_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
      artist TEXT NOT NULL DEFAULT '', album TEXT NOT NULL DEFAULT '',
      cover TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '',
      added_at INTEGER NOT NULL, PRIMARY KEY (member_id, id)
    );
  `);

  const track = db.prepare(
    `INSERT INTO tracks (id, source, name, artist, object_key, bytes, created_at, last_played)
     VALUES (?, '163', ?, 'A', ?, 100, 1, 1)`
  );
  // Prefixed, and the bare id does NOT exist → must be renamed.
  track.run('163_2166519574', 'Chart Only', 'audio/a.mp3');
  // Prefixed, and the bare id DOES exist → the prefixed row must be dropped.
  track.run('163_65739', 'Chart Dup', 'audio/b.mp3');
  track.run('65739', 'Search Copy', 'audio/c.mp3');
  // A perfectly normal NetEase id that begins with 163 and must NOT be touched.
  // This is what the ESCAPE clause protects.
  track.run('163456789', 'Innocent', 'audio/d.mp3');
  // Other sources must be untouched too.
  track.run('qq:001abc', 'QQ Song', 'audio/e.mp3');

  db.prepare(`INSERT INTO members (id, token, name, is_owner, created_at, last_seen)
              VALUES ('own', 'tok-own', 'owner', 1, 1, 1)`).run();

  const fav = db.prepare(
    `INSERT INTO member_favorites (member_id, id, name, added_at) VALUES ('own', ?, ?, 1)`
  );
  fav.run('163_777', 'Fav Chart Only');
  fav.run('163_888', 'Fav Chart Dup');
  fav.run('888', 'Fav Search Copy');
  fav.run('163999', 'Fav Innocent');

  db.prepare("INSERT INTO library_meta (key, value) VALUES ('total_bytes', 500)").run();
  return db;
}

function ids(db, table) {
  return db.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map((r) => r.id);
}

/* ------------------------------- run 1 and 2 ------------------------------ */

const db = seedLegacy();

try {
  db.exec(SQL);
} catch (err) {
  problems.push(`first run failed: ${err.message}`);
}

const afterFirst = snapshot(db);

try {
  db.exec(SQL);
} catch (err) {
  problems.push(`second run failed: ${err.message}`);
}

const afterSecond = snapshot(db);

if (afterFirst !== afterSecond) {
  const a = afterFirst.split('\n');
  const b = afterSecond.split('\n');
  const diff = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) diff.push(`  run1: ${a[i] ?? '(nothing)'}\n  run2: ${b[i] ?? '(nothing)'}`);
  }
  problems.push(`the second run changed the database:\n${diff.slice(0, 6).join('\n')}`);
}

/* --------------------------- console-paste safety ------------------------- */

// The file is pasted into the Cloudflare D1 console, not only fed to wrangler.
// A backslash there travels through a web form and a JSON request body before
// SQLite sees it, and is not guaranteed to arrive intact — which is why the
// data fixes compare with substr instead of LIKE ... ESCAPE.
if (SQL.includes('\\')) {
  const line = SQL.split('\n').findIndex((l) => l.includes('\\')) + 1;
  problems.push(
    `line ${line} contains a backslash. It may not survive the D1 console; ` +
      `use substr(...) instead of LIKE ... ESCAPE`
  );
}

// D1 caps compound SELECT terms far lower than stock SQLite, and the cap is not
// documented. Since a scalar-subquery form is always available and reads better
// anyway, the rule here is simply not to use them in this file — a rule that
// cannot be violated by accident is worth more than guessing the limit.
{
  const stripped = SQL.replace(/--[^\n]*/g, '');
  const compound = stripped.match(/\b(UNION|INTERSECT|EXCEPT)\b/gi);
  if (compound) {
    problems.push(
      `${compound.length} compound-SELECT keyword(s) (${[...new Set(compound.map((c) => c.toUpperCase()))].join(', ')}). ` +
        `D1 rejects these past a low, undocumented limit — use scalar subqueries: ` +
        `SELECT (SELECT COUNT(*) FROM t) AS t, ...`
    );
  }
}

// Some consoles strip or mishandle comments. Stripping them must not change
// what the file does — which also catches a `--` inside a string literal, the
// one place where a naive comment stripper silently eats real SQL.
const bare = SQL.replace(/--[^\n]*/g, '');
const strippedDb = seedLegacy();
try {
  strippedDb.exec(bare);
  if (snapshot(strippedDb) !== afterFirst) {
    problems.push('the file behaves differently with comments stripped');
  }
} catch (err) {
  problems.push(`comment-stripped run failed: ${err.message}`);
}

/* -------------------------------- outcomes -------------------------------- */

const trackIds = ids(db, 'tracks');
const favIds = ids(db, 'member_favorites');

const expectTracks = ['163456789', '2166519574', '65739', 'qq:001abc'];
if (JSON.stringify(trackIds) !== JSON.stringify(expectTracks)) {
  problems.push(`tracks ids are ${JSON.stringify(trackIds)}, expected ${JSON.stringify(expectTracks)}`);
}

const expectFavs = ['163999', '777', '888'];
if (JSON.stringify(favIds) !== JSON.stringify(expectFavs)) {
  problems.push(`favourite ids are ${JSON.stringify(favIds)}, expected ${JSON.stringify(expectFavs)}`);
}

// The surviving duplicate must be the one that was already correct, not a
// renamed prefixed row that clobbered it.
const kept = db.prepare("SELECT name FROM tracks WHERE id = '65739'").get();
if (kept?.name !== 'Search Copy') {
  problems.push(`the duplicate resolution kept "${kept?.name}" instead of the existing row`);
}

// Existing data must survive untouched.
const meta = db.prepare("SELECT value FROM library_meta WHERE key = 'total_bytes'").get();
if (meta?.value !== 500) problems.push(`library_meta was reset to ${meta?.value}, expected 500`);
if (db.prepare('SELECT COUNT(*) AS n FROM members').get().n !== 1) {
  problems.push('the members table was disturbed');
}

// New tables must exist.
for (const t of ['track_requests', 'invites', 'schema_migrations']) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(t);
  if (!row) problems.push(`${t} was not created`);
}

// Indexes the code relies on for ordering and lookup.
for (const idx of [
  'idx_tracks_last_played',
  'idx_members_token',
  'idx_member_favorites_member',
  'idx_track_requests_status',
]) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?").get(idx);
  if (!row) problems.push(`${idx} was not created`);
}

// And it must build a working database from nothing, which is the other half of
// "one file": a fresh deployment runs the same thing.
const fresh = new DatabaseSync(':memory:');
try {
  fresh.exec(SQL);
  const n = fresh.prepare('SELECT COUNT(*) AS n FROM track_requests').get().n;
  if (n !== 0) problems.push(`a fresh database started with ${n} requests`);
  fresh.exec(SQL);
} catch (err) {
  problems.push(`fresh install failed: ${err.message}`);
}

/* --------------------------------- report --------------------------------- */

if (problems.length) {
  console.error(`\nschema.sql — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  process.exit(1);
}

console.log(
  `schema.sql — idempotent, and correct on legacy data ` +
    `(${trackIds.length} tracks, ${favIds.length} favourites, run twice with no drift)`
);
