-- Forum schema (Cloudflare D1). Times are ISO 8601 UTC strings.

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  email         TEXT UNIQUE,                 -- lowercased; NULL for imported authors without an address
  name          TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  banned_at     TEXT,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT,
  tender_id     INTEGER UNIQUE,              -- set for users imported from Tender
  claimed_at    TEXT                         -- first sign-in of an imported user
);

-- External identities (Google). A user can have several.
CREATE TABLE identities (
  provider      TEXT NOT NULL,
  subject       TEXT NOT NULL,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email         TEXT,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
);

CREATE TABLE sessions (
  token_hash    TEXT PRIMARY KEY,            -- sha-256 of the cookie value
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Magic sign-in links.
CREATE TABLE login_tokens (
  token_hash    TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  used_at       TEXT,
  next          TEXT                         -- where to go after signing in
);
CREATE INDEX idx_login_tokens_email ON login_tokens(email, created_at);

CREATE TABLE categories (
  id            INTEGER PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  position      INTEGER NOT NULL DEFAULT 0,
  topic_count   INTEGER NOT NULL DEFAULT 0,
  tender_id     INTEGER UNIQUE
);

CREATE TABLE topics (
  id            INTEGER PRIMARY KEY,
  category_id   INTEGER NOT NULL REFERENCES categories(id),
  user_id       INTEGER NOT NULL REFERENCES users(id),
  title         TEXT NOT NULL,
  slug          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_post_at  TEXT NOT NULL,
  last_post_user_id INTEGER REFERENCES users(id),
  post_count    INTEGER NOT NULL DEFAULT 0,
  pinned        INTEGER NOT NULL DEFAULT 0,
  locked        INTEGER NOT NULL DEFAULT 0,
  solved        INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'visible',  -- visible | spam | removed (follows its opening post)
  tender_id     INTEGER UNIQUE
);
CREATE INDEX idx_topics_category ON topics(category_id, status, pinned DESC, last_post_at DESC);
CREATE INDEX idx_topics_latest ON topics(status, last_post_at DESC);

CREATE TABLE posts (
  id            INTEGER PRIMARY KEY,
  topic_id      INTEGER NOT NULL REFERENCES topics(id),
  user_id       INTEGER NOT NULL REFERENCES users(id),
  body          TEXT NOT NULL,               -- Markdown
  created_at    TEXT NOT NULL,
  edited_at     TEXT,
  status        TEXT NOT NULL DEFAULT 'visible',  -- visible | spam | removed
  moderated_by  INTEGER REFERENCES users(id),     -- NULL for the importer's spam filter
  moderated_at  TEXT,
  moderation_reason TEXT,
  tender_number INTEGER                      -- comment number inside the Tender discussion
);
CREATE INDEX idx_posts_status ON posts(status, moderated_at);
CREATE INDEX idx_posts_topic ON posts(topic_id, created_at);
CREATE INDEX idx_posts_user ON posts(user_id);

CREATE TABLE attachments (
  id            TEXT PRIMARY KEY,            -- random, also used in URLs
  user_id       INTEGER NOT NULL REFERENCES users(id),
  post_id       INTEGER REFERENCES posts(id), -- NULL while the post is still being written
  r2_key        TEXT NOT NULL UNIQUE,
  filename      TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  size          INTEGER NOT NULL,
  image_id      TEXT,                        -- Cloudflare Images id (nodebox-forum-...), images only
  width         INTEGER,
  height        INTEGER,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_attachments_post ON attachments(post_id);

CREATE TABLE reactions (
  post_id       INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (post_id, user_id, emoji)
);

-- Old Tender URL paths, so links from the old forum keep working.
CREATE TABLE legacy_redirects (
  path          TEXT PRIMARY KEY,
  topic_id      INTEGER NOT NULL REFERENCES topics(id)
);

-- Simple fixed-window rate limiting (sign-in emails, uploads).
CREATE TABLE rate_limits (
  key           TEXT PRIMARY KEY,
  window_start  TEXT NOT NULL,
  count         INTEGER NOT NULL
);

-- Every moderation action, for accountability between admins.
CREATE TABLE moderation_log (
  id            INTEGER PRIMARY KEY,
  admin_id      INTEGER REFERENCES users(id),  -- NULL for command-line and import actions
  action        TEXT NOT NULL,                 -- spam | remove | restore | ban | unban | grant_admin | revoke_admin | lock | unlock | pin | unpin
  post_id       INTEGER,
  topic_id      INTEGER,
  user_id       INTEGER,
  reason        TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_moderation_log_created ON moderation_log(created_at DESC);
