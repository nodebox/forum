-- Full-text search over topic titles and post bodies (FTS5, kept in sync by triggers).
CREATE VIRTUAL TABLE topics_fts USING fts5(title, content = 'topics', content_rowid = 'id', tokenize = 'unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE posts_fts USING fts5(body, content = 'posts', content_rowid = 'id', tokenize = 'unicode61 remove_diacritics 2');

CREATE TRIGGER topics_fts_insert AFTER INSERT ON topics BEGIN
  INSERT INTO topics_fts(rowid, title) VALUES (new.id, new.title);
END;
CREATE TRIGGER topics_fts_delete AFTER DELETE ON topics BEGIN
  INSERT INTO topics_fts(topics_fts, rowid, title) VALUES ('delete', old.id, old.title);
END;
CREATE TRIGGER topics_fts_update AFTER UPDATE OF title ON topics BEGIN
  INSERT INTO topics_fts(topics_fts, rowid, title) VALUES ('delete', old.id, old.title);
  INSERT INTO topics_fts(rowid, title) VALUES (new.id, new.title);
END;

CREATE TRIGGER posts_fts_insert AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts(rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER posts_fts_delete AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;
CREATE TRIGGER posts_fts_update AFTER UPDATE OF body ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, body) VALUES ('delete', old.id, old.body);
  INSERT INTO posts_fts(rowid, body) VALUES (new.id, new.body);
END;

-- Index what is already there.
INSERT INTO topics_fts(topics_fts) VALUES ('rebuild');
INSERT INTO posts_fts(posts_fts) VALUES ('rebuild');
