-- VPlayer library metadata.
--
-- D1 holds the bookkeeping; the audio itself lives in R2. That split is not
-- arbitrary: D1 is SQLite with a cap on how much a single query may return and
-- no byte-range reads, so a 40 MB FLAC stored as a row could not be seeked
-- through. R2 serves ranges natively and its egress is free, which is what
-- audio needs. What D1 is good at is exactly what eviction requires — ordering
-- rows by last use and summing sizes.
--
-- Apply with:
--   wrangler d1 execute vplayer --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS tracks (
  -- Wire-compatible song id: bare digits for NetEase, qq:<mid>, kg:<hash>.
  id           TEXT PRIMARY KEY,
  source       TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  artist       TEXT NOT NULL DEFAULT '',
  album        TEXT NOT NULL DEFAULT '',
  cover        TEXT NOT NULL DEFAULT '',

  -- R2 object key. Kept explicit rather than derived, so the extension can
  -- follow whatever the upstream actually served.
  object_key   TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  bytes        INTEGER NOT NULL DEFAULT 0,
  -- The quality tier this copy actually is, not the one that was requested.
  level        TEXT NOT NULL DEFAULT '',
  duration     INTEGER,
  lyric        TEXT NOT NULL DEFAULT '',

  created_at   INTEGER NOT NULL,
  last_played  INTEGER NOT NULL,
  play_count   INTEGER NOT NULL DEFAULT 0
);

-- Eviction is least-recently-played first, so that ordering needs an index.
CREATE INDEX IF NOT EXISTS idx_tracks_last_played ON tracks (last_played);

-- Single-row table for counters that would otherwise need a full scan.
CREATE TABLE IF NOT EXISTS library_meta (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO library_meta (key, value) VALUES ('total_bytes', 0);

-- ============================================================================
-- Multi-user access (invite codes + per-member favourites)
--
-- Design: everyone shares ONE cloud library (the tracks table above) to avoid
-- storing the same song bytes multiple times. Favourites are per-member so each
-- person keeps their own list. Access is gated by an invite code the owner
-- generates; redeeming it creates a member row and returns a long-lived token.
-- ============================================================================

-- Invite codes. The owner generates these; each can be single- or multi-use.
CREATE TABLE IF NOT EXISTS invites (
  code        TEXT PRIMARY KEY,      -- the code the user types
  label       TEXT NOT NULL DEFAULT '',
  max_uses    INTEGER NOT NULL DEFAULT 1,   -- 0 = unlimited
  used        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER                        -- null = never
);

-- Members. A member is created when someone redeems an invite. The token is
-- what the client stores and sends on every request; it identifies the member
-- without a password.
CREATE TABLE IF NOT EXISTS members (
  id          TEXT PRIMARY KEY,      -- random id
  token       TEXT NOT NULL UNIQUE,  -- bearer token stored client-side
  name        TEXT NOT NULL DEFAULT '',
  invite_code TEXT NOT NULL DEFAULT '',
  is_owner    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_members_token ON members (token);

-- Per-member favourites. Metadata only — the playable id plus what's needed to
-- render a row. Playback still resolves through the shared library or upstream.
CREATE TABLE IF NOT EXISTS member_favorites (
  member_id  TEXT NOT NULL,
  id         TEXT NOT NULL,          -- song id (same wire format as tracks.id)
  name       TEXT NOT NULL DEFAULT '',
  artist     TEXT NOT NULL DEFAULT '',
  album      TEXT NOT NULL DEFAULT '',
  cover      TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT '',
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (member_id, id)
);

CREATE INDEX IF NOT EXISTS idx_member_favorites_member ON member_favorites (member_id);
