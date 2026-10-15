-- The forum has no "solved" state (Frederik, 2026-10-15). Tender's resolved flag goes too.
ALTER TABLE topics DROP COLUMN solved;
