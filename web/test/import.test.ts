import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { attachmentId, convert } from "../scripts/import-tender.ts";

const root = path.join(import.meta.dirname, "..");
const tenderSchema = fs.readFileSync(path.join(root, "../migrations/0001_tender_import.sql"), "utf8");
const forumSchema = fs.readFileSync(path.join(root, "migrations/0001_init.sql"), "utf8");

function fixture(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(tenderSchema);
  const t = "2014-05-02T10:00:00Z";
  db.exec(`
    INSERT INTO categories (id, name, permalink, summary, public, raw, fetched_at) VALUES
      (10, 'Problems', 'problems', 'Things that break', 1, '{}', '${t}'),
      (11, 'Staff only', 'staff', '', 0, '{}', '${t}');
    INSERT INTO users (id, name, email, created_at, raw) VALUES
      (1, 'Ann', 'Ann@Example.com', '${t}', '{}'),
      (2, 'Ann (second account)', 'ann@example.com', '${t}', '{}'),
      (3, 'Bob', 'bob@example.com', '${t}', '{}'),
      (4, 'Unused', 'unused@example.com', '${t}', '{}');
    INSERT INTO discussions (id, category_id, title, state, public, user_id, html_href, created_at, raw, fetched_at) VALUES
      (100, 10, 'Crash on import', 'resolved', 1, 1, 'https://support.nodebox.net/discussions/problems/100-crash-on-import', '${t}', '{}', '${t}'),
      (101, 10, 'Pakketmelding', 'open', 1, 3, 'https://support.nodebox.net/discussions/problems/101-pakket', '${t}', '{}', '${t}'),
      (102, 11, 'Internal', 'open', 1, 1, NULL, '${t}', '{}', '${t}'),
      (103, 10, 'Private one', 'open', 0, 1, NULL, '${t}', '{}', '${t}'),
      (104, 10, 'Spam', 'spam', 1, 1, NULL, '${t}', '{}', '${t}');
    INSERT INTO comments (discussion_id, number, user_id, author_name, author_email, body, internal, created_at, raw) VALUES
      (100, 1, 1, 'Ann', NULL, 'It crashes. See ![shot](https://support.nodebox.net/assets/abc/shot.png) and /discussions/problems/100-crash-on-import', 0, '2014-05-02T10:00:00Z', '{}'),
      (100, 2, NULL, 'Guest', 'guest@example.com', 'Same here', 0, '2014-05-02T11:00:00Z', '{}'),
      (100, 3, 2, 'Ann', NULL, 'Internal note', 1, '2014-05-02T12:00:00Z', '{}'),
      (100, 4, 3, 'Bob', NULL, 'Buy cheap pills', 0, '2014-05-02T13:00:00Z', '{}'),
      (100, 5, 2, 'Ann', NULL, 'Fixed, thanks', 0, '2014-05-03T09:00:00Z', '{}'),
      (101, 1, 3, 'Bob', NULL, 'Uw pakket', 0, '2014-05-04T09:00:00Z', '{}'),
      (102, 1, 1, 'Ann', NULL, 'secret', 0, '${t}', '{}'),
      (103, 1, 1, 'Ann', NULL, 'private', 0, '${t}', '{}');
    INSERT INTO attachments (download_path, discussion_id, comment_number, filename, content_type, size, raw) VALUES
      ('/assets/abc/shot.png', 100, 1, 'shot.png', 'image/png', 1234, '{}'),
      ('/assets/def/project.zip', 100, 5, 'project.zip', 'application/zip', 99999, '{}'),
      ('/assets/ghi/note.txt', 100, 3, 'note.txt', 'text/plain', 1, '{}');
    -- Same shape as the spam filter's migrations/0002_spam.sql.
    CREATE TABLE spam_verdicts (discussion_id INTEGER NOT NULL, comment_number INTEGER NOT NULL, verdict TEXT NOT NULL, confidence REAL,
      source TEXT NOT NULL, reason TEXT, model TEXT, classified_at TEXT NOT NULL, PRIMARY KEY (discussion_id, comment_number));
    CREATE TABLE spam_decisions (discussion_id INTEGER NOT NULL, comment_number INTEGER NOT NULL, decision TEXT NOT NULL, decided_at TEXT NOT NULL,
      PRIMARY KEY (discussion_id, comment_number));
    CREATE VIEW spam_excluded AS
      SELECT discussion_id, comment_number FROM spam_decisions WHERE decision = 'spam'
      UNION
      SELECT v.discussion_id, v.comment_number FROM spam_verdicts v
      LEFT JOIN spam_decisions m ON m.discussion_id = v.discussion_id AND m.comment_number = v.comment_number
      WHERE m.decision IS NULL AND v.verdict = 'spam' AND (v.source <> 'model' OR v.confidence >= 0.9);
    INSERT INTO spam_verdicts VALUES
      (101, 0, 'spam', 0.99, 'model', 'phishing', 'm', '${t}'),
      (100, 0, 'ham', 0.95, 'model', NULL, 'm', '${t}'),
      (100, 5, 'spam', 0.6, 'model', 'unsure pharma', 'm', '${t}');
    INSERT INTO spam_decisions VALUES (100, 4, 'spam', '${t}');
  `);
  return db;
}

test("converts a Tender export into forum rows", () => {
  const { statements, stats } = convert(fixture());
  const db = new DatabaseSync(":memory:");
  db.exec(forumSchema);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(statements.join("\n"));

  assert.deepEqual(db.prepare("SELECT id, slug, topic_count FROM categories").all().map((r) => ({ ...r })), [{ id: 10, slug: "problems", topic_count: 1 }]);

  const topics = db.prepare("SELECT id, title, solved, status, post_count FROM topics ORDER BY id").all().map((r) => ({ ...r }));
  assert.deepEqual(topics, [
    { id: 100, title: "Crash on import", solved: 1, status: "visible", post_count: 3 },
    { id: 101, title: "Pakketmelding", solved: 0, status: "spam", post_count: 0 },
  ]);

  const posts = db.prepare("SELECT topic_id, tender_number, status, body FROM posts ORDER BY id").all() as any[];
  assert.equal(posts.length, 5, "internal note left out");
  assert.deepEqual(posts.map((p) => `${p.topic_id}:${p.tender_number}:${p.status}`), ["100:1:visible", "100:2:visible", "100:4:spam", "100:5:visible", "101:1:spam"]);
  const shot = attachmentId("/assets/abc/shot.png");
  assert.match(posts[0].body, new RegExp(`!\\[shot\\]\\(/files/${shot}/shot.png\\)`), "attachment link rewritten");
  assert.match(posts[0].body, /\/t\/100\/crash-on-import/, "old discussion link rewritten");

  // Ann's two accounts share an email and become one user; Unused never posted and is left out.
  const users = db.prepare("SELECT id, email, name, tender_id FROM users ORDER BY id").all().map((r) => ({ ...r })) as any[];
  assert.deepEqual(users.map((u) => u.email), ["ann@example.com", "bob@example.com", "guest@example.com"]);
  assert.equal(new Set((db.prepare("SELECT user_id FROM posts WHERE tender_number IN (1, 5) AND topic_id = 100").all() as any[]).map((r) => r.user_id)).size, 1);

  const files = db.prepare("SELECT filename, r2_key, image_id FROM attachments ORDER BY filename").all().map((r) => ({ ...r }));
  assert.deepEqual(files, [
    { filename: "project.zip", r2_key: "tender/assets/def/project.zip", image_id: null },
    { filename: "shot.png", r2_key: "tender/assets/abc/shot.png", image_id: `nodebox-forum-${shot}` },
  ]);

  assert.equal((db.prepare("SELECT topic_id FROM legacy_redirects WHERE path = '/discussions/problems/100-crash-on-import'").get() as any).topic_id, 100);
  const reasons = db.prepare("SELECT topic_id, tender_number, moderation_reason FROM posts WHERE status = 'spam' ORDER BY id").all().map((r) => ({ ...r }));
  assert.deepEqual(reasons, [
    { topic_id: 100, tender_number: 4, moderation_reason: "Spam filter: marked spam in review" },
    { topic_id: 101, tender_number: 1, moderation_reason: "Spam filter (model): phishing" },
  ]);
  assert.equal(stats.spamTopics, 1);
  assert.equal(stats.spamPosts, 2);
});

test("works without spam verdicts", () => {
  const db = fixture();
  db.exec("DROP VIEW spam_excluded; DROP TABLE spam_verdicts; DROP TABLE spam_decisions;");
  const { stats } = convert(db);
  assert.equal(stats.spamPosts, 0);
  assert.equal(stats.topics, 2);
});
