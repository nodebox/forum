-- Spam flags for the Tender export, written by `npm run spam`.
-- Nothing is deleted from the export: the import leaves out whatever is in
-- the `spam_excluded` view.

-- One row per classified discussion (comment_number = 0), plus one row per
-- individual spam reply inside an otherwise genuine discussion.
CREATE TABLE IF NOT EXISTS spam_verdicts (
  discussion_id   INTEGER NOT NULL,
  comment_number  INTEGER NOT NULL,   -- 0 = the whole discussion
  verdict         TEXT NOT NULL,      -- spam | ham | unsure
  confidence      REAL,               -- 0..1, from the model
  source          TEXT NOT NULL,      -- tender (Tender marked it spam) | heuristic | model
  reason          TEXT,
  model           TEXT,
  classified_at   TEXT NOT NULL,
  PRIMARY KEY (discussion_id, comment_number)
);

-- Decisions from the review CSV (`npm run spam -- apply`). They win over spam_verdicts.
CREATE TABLE IF NOT EXISTS spam_decisions (
  discussion_id   INTEGER NOT NULL,
  comment_number  INTEGER NOT NULL,   -- 0 = the whole discussion
  decision        TEXT NOT NULL,      -- spam | ham
  decided_at      TEXT NOT NULL,
  PRIMARY KEY (discussion_id, comment_number)
);

-- What the import leaves out (or hides). comment_number = 0 is the whole
-- discussion, N > 0 is only reply N. Model verdicts count only at confidence
-- >= 0.9; anything below that is excluded only after a reviewer marks it spam.
DROP VIEW IF EXISTS spam_excluded;
CREATE VIEW spam_excluded AS
SELECT m.discussion_id, m.comment_number,
       COALESCE(v.reason, 'marked spam in review') AS reason
FROM spam_decisions m
LEFT JOIN spam_verdicts v ON v.discussion_id = m.discussion_id AND v.comment_number = m.comment_number
WHERE m.decision = 'spam'
UNION ALL
SELECT v.discussion_id, v.comment_number, v.reason
FROM spam_verdicts v
LEFT JOIN spam_decisions m ON m.discussion_id = v.discussion_id AND m.comment_number = v.comment_number
WHERE m.decision IS NULL
  AND v.verdict = 'spam'
  AND (v.source <> 'model' OR v.confidence >= 0.9);
