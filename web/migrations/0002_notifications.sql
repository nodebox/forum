-- Per-user state for a topic: watching (email digests) and what they've seen.
CREATE TABLE topic_users (
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_id      INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  watching      INTEGER,                       -- 1 watching, 0 turned off, NULL never chosen (a reply turns it on)
  last_seen_at  TEXT,                          -- last time they opened the topic
  notified_at   TEXT,                          -- last digest that covered this topic
  PRIMARY KEY (user_id, topic_id)
);

ALTER TABLE users ADD COLUMN email_digest INTEGER NOT NULL DEFAULT 1;  -- daily summary of watched topics
ALTER TABLE users ADD COLUMN last_digest_at TEXT;
ALTER TABLE users ADD COLUMN unsubscribe_token TEXT;
