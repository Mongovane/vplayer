-- Strip the `163_` prefix from cloud-library rows ingested from a chart.
--
-- /api/charts used to emit `163_2166519574` as a track id. Nothing in the id
-- vocabulary recognises that prefix — sourceOf() only knows `qq:` and `kg:`,
-- and bare() only stripped those two — so the id travelled verbatim to the
-- upstream resolver and every chart track was unplayable.
--
-- The endpoint now emits bare ids. Rows already written to D1 under the
-- prefixed form would no longer be found by findTrack(), so /api/song would
-- re-resolve and re-ingest the same audio, leaving an orphan row holding an R2
-- object nobody points at.
--
-- Run once, after deploying:
--   wrangler d1 execute vplayer --remote --file=./migrations/0001-strip-chart-id-prefix.sql

-- Drop any prefixed row whose bare id is ALREADY present, so the UPDATE below
-- cannot collide with the primary key. The surviving copy is the one search
-- ingested, which is the same audio.
DELETE FROM tracks
 WHERE id LIKE '163\_%' ESCAPE '\'
   AND substr(id, 5) IN (SELECT id FROM tracks WHERE id NOT LIKE '163\_%' ESCAPE '\');

UPDATE tracks
   SET id = substr(id, 5)
 WHERE id LIKE '163\_%' ESCAPE '\';

-- Sanity check: should return 0.
SELECT COUNT(*) AS remaining_prefixed FROM tracks WHERE id LIKE '163\_%' ESCAPE '\';
