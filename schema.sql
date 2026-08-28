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
