-- One-shot name correction for a single session.
--
-- Usage (replace the two psql variables):
--   psql "$DATABASE_URL" \
--     -v sid="'<SESSION_UUID>'" \
--     -v wrong="'Salad'" \
--     -v right="'Salat'" \
--     -f scripts/fix_name.sql
--
-- After this runs:
--   1) Verify the row counts printed at the end match what you expect.
--   2) Clear embedding bookkeeping so the worker re-embeds:
--      UPDATE sessions SET embedded_at = NULL, embed_attempts = 0,
--        embed_error = NULL WHERE id = '<SESSION_UUID>';
--      The worker picks it up on its next embed sweep, deletes prior
--      chunks for the session, and rebuilds from the (corrected) source
--      text. embedSession.ts:215 already does the DELETE.
--
-- Word boundaries (\m / \M) are Postgres regex anchors — they prevent
-- collateral hits on the literal word "salad" if it ever appears in
-- transcribed dialogue.

\set ON_ERROR_STOP on
BEGIN;

-- 1) Per-track transcripts (text + JSON segments)
WITH affected AS (
  SELECT t.id
  FROM transcripts t
  JOIN audio_files af ON af.id = t.audio_file_id
  JOIN chapters c     ON c.id  = af.chapter_id
  WHERE c.session_id = :sid
)
UPDATE transcripts
SET full_text = regexp_replace(full_text, '\m' || :wrong || '\M', :right, 'g'),
    segments  = regexp_replace(segments::text, '\m' || :wrong || '\M', :right, 'g')::jsonb
WHERE id IN (SELECT id FROM affected);

-- 2) Combined transcript (Stage 8 chronological file)
UPDATE combined_transcripts
SET full_text = regexp_replace(full_text, '\m' || :wrong || '\M', :right, 'g'),
    segments  = regexp_replace(segments::text, '\m' || :wrong || '\M', :right, 'g')::jsonb
WHERE session_id = :sid;

-- 3) Summary (short, full, key_events JSON)
UPDATE summaries
SET short      = regexp_replace(short,            '\m' || :wrong || '\M', :right, 'g'),
    full       = regexp_replace(full,             '\m' || :wrong || '\M', :right, 'g'),
    key_events = regexp_replace(key_events::text, '\m' || :wrong || '\M', :right, 'g')::jsonb
WHERE session_id = :sid;

-- 4) Character memories
UPDATE character_memory
SET content = regexp_replace(content, '\m' || :wrong || '\M', :right, 'g')
WHERE session_id = :sid;

-- 5) Art prompts (only matters for future /regen-art runs against this session)
UPDATE art_pieces
SET prompt = regexp_replace(prompt, '\m' || :wrong || '\M', :right, 'g')
WHERE session_id = :sid;

-- Verification: count remaining occurrences. Should all be 0.
SELECT 'transcripts'         AS where_, COUNT(*) AS remaining
FROM transcripts t
JOIN audio_files af ON af.id = t.audio_file_id
JOIN chapters c     ON c.id  = af.chapter_id
WHERE c.session_id = :sid
  AND (t.full_text ~ ('\m' || :wrong || '\M') OR t.segments::text ~ ('\m' || :wrong || '\M'))
UNION ALL
SELECT 'combined_transcripts', COUNT(*)
FROM combined_transcripts
WHERE session_id = :sid
  AND (full_text ~ ('\m' || :wrong || '\M') OR segments::text ~ ('\m' || :wrong || '\M'))
UNION ALL
SELECT 'summaries', COUNT(*)
FROM summaries
WHERE session_id = :sid
  AND (short ~ ('\m' || :wrong || '\M')
       OR full ~ ('\m' || :wrong || '\M')
       OR key_events::text ~ ('\m' || :wrong || '\M'))
UNION ALL
SELECT 'character_memory', COUNT(*)
FROM character_memory
WHERE session_id = :sid AND content ~ ('\m' || :wrong || '\M')
UNION ALL
SELECT 'art_pieces', COUNT(*)
FROM art_pieces
WHERE session_id = :sid AND prompt ~ ('\m' || :wrong || '\M');

COMMIT;
