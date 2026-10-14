-- Tender import schema. Plain SQLite, compatible with Cloudflare D1.
-- Every table keeps the untouched API object in `raw` (JSON text), so nothing
-- is lost if a field turns out to matter later.

CREATE TABLE IF NOT EXISTS categories (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  permalink     TEXT,
  summary       TEXT,
  public        INTEGER,
  html_href     TEXT,
  created_at    TEXT,
  updated_at    TEXT,
  raw           TEXT NOT NULL,
  fetched_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id                 INTEGER PRIMARY KEY,
  name               TEXT,
  email              TEXT,
  title              TEXT,
  state              TEXT,
  is_supporter       INTEGER,
  comments_count     INTEGER,
  discussions_count  INTEGER,
  created_at         TEXT,
  updated_at         TEXT,
  raw                TEXT,             -- NULL when only seen as an author and not fetched (yet)
  fetch_error        TEXT,
  fetched_at         TEXT
);

CREATE TABLE IF NOT EXISTS discussions (
  id              INTEGER PRIMARY KEY,
  category_id     INTEGER,
  number          INTEGER,
  title           TEXT,
  permalink       TEXT,
  state           TEXT,             -- open | assigned | resolved | spam | deleted
  public          INTEGER,
  author_name     TEXT,
  author_email    TEXT,
  user_id         INTEGER,
  comments_count  INTEGER,
  html_href       TEXT,             -- old public URL, useful for redirects
  created_at      TEXT,
  updated_at      TEXT,
  last_updated_at TEXT,
  raw             TEXT NOT NULL,    -- object as returned by the list endpoint
  detail_raw      TEXT,             -- object as returned by GET /discussions/{id} (minus comments)
  detail_fetched_at TEXT,
  detail_error    TEXT,
  fetched_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discussions_category ON discussions(category_id);
CREATE INDEX IF NOT EXISTS idx_discussions_created ON discussions(created_at);

-- Tender does not expose comment ids, so a comment is keyed by its
-- position (`number`) inside the discussion.
CREATE TABLE IF NOT EXISTS comments (
  discussion_id     INTEGER NOT NULL,
  number            INTEGER NOT NULL,
  user_id           INTEGER,
  author_name       TEXT,
  author_email      TEXT,
  body              TEXT,             -- source text as written
  formatted_body    TEXT,             -- HTML rendered by Tender
  internal          INTEGER,
  system_message    INTEGER,
  resolution        INTEGER,
  user_is_supporter INTEGER,
  via               TEXT,
  created_at        TEXT,
  raw               TEXT NOT NULL,
  PRIMARY KEY (discussion_id, number)
);
CREATE INDEX IF NOT EXISTS idx_comments_user ON comments(user_id);

CREATE TABLE IF NOT EXISTS attachments (
  discussion_id   INTEGER NOT NULL,
  comment_number  INTEGER NOT NULL,
  download_path   TEXT NOT NULL,      -- /assets/{hash}/{filename}. One file can hang on several comments.
  download_url    TEXT NOT NULL,      -- where to fetch it; Tender signs this for S3 and it expires after about a day
  filename        TEXT,
  content_type    TEXT,
  size            INTEGER,
  width           INTEGER,
  height          INTEGER,
  created_at      TEXT,
  raw             TEXT NOT NULL,
  local_path      TEXT,               -- relative to the attachments dir, once downloaded
  sha256          TEXT,
  downloaded_size INTEGER,
  download_error  TEXT,
  downloaded_at   TEXT,
  PRIMARY KEY (discussion_id, comment_number, download_path)
);
CREATE INDEX IF NOT EXISTS idx_attachments_path ON attachments(download_path);

CREATE TABLE IF NOT EXISTS kb_sections (
  id          INTEGER PRIMARY KEY,
  title       TEXT,
  permalink   TEXT,
  raw         TEXT NOT NULL,
  fetched_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kb_articles (
  id            INTEGER PRIMARY KEY,
  section_id    INTEGER,
  title         TEXT,
  permalink     TEXT,
  body          TEXT,
  formatted_body TEXT,
  keywords      TEXT,
  published_at  TEXT,
  html_href     TEXT,
  created_at    TEXT,
  updated_at    TEXT,
  raw           TEXT NOT NULL,
  fetched_at    TEXT NOT NULL
);

-- Resume bookkeeping for the importer (which list pages are done, etc.).
CREATE TABLE IF NOT EXISTS sync_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
