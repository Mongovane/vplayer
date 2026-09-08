-- Adds the upload-approval queue. Safe to run on an existing database:
-- CREATE TABLE IF NOT EXISTS touches nothing that already exists.
--
--   wrangler d1 execute vplayer --remote --file=./migrations/0002-track-requests.sql

CREATE TABLE IF NOT EXISTS track_requests (
  id           TEXT PRIMARY KEY,
  member_id    TEXT NOT NULL,
  member_name  TEXT NOT NULL DEFAULT '',
  name         TEXT NOT NULL DEFAULT '',
  artist       TEXT NOT NULL DEFAULT '',
  album        TEXT NOT NULL DEFAULT '',
  cover        TEXT NOT NULL DEFAULT '',
  source       TEXT NOT NULL DEFAULT '',
  level        TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending',
  requested_at INTEGER NOT NULL,
  decided_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_track_requests_status
  ON track_requests (status, requested_at);

SELECT COUNT(*) AS requests FROM track_requests;
