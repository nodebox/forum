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
      (4, 'Unused', 'unused@example.com', '${t}', '{}'),
      (5, 'Carl', 'carl@example.com', '${t}', '{}');
    INSERT INTO discussions (id, category_id, title, state, public, user_id, html_href, created_at, raw, fetched_at) VALUES
      (100, 10, 'Crash on import', 'resolved', 1, 1, 'https://support.nodebox.net/discussions/problems/100-crash-on-import', '${t}', '{}', '${t}'),
      (101, 10, 'Pakketmelding', 'open', 1, 3, 'https://support.nodebox.net/discussions/problems/101-pakket', '${t}', '{}', '${t}'),
      (102, 11, 'Internal', 'open', 1, 1, NULL, '${t}', '{}', '${t}'),
      (103, 10, 'Private one', 'open', 0, 1, NULL, '${t}', '{}', '${t}'),
      (104, 10, 'Spam', 'spam', 1, 1, NULL, '${t}', '{}', '${t}'),
      (105, 10, 'Opening comment gone', 'open', 1, 4, NULL, '2014-05-05T09:00:00Z', '{}', '${t}'),
      (106, 10, 'Only spam from Carl', 'open', 1, 5, NULL, '2014-05-06T09:00:00Z', '{}', '${t}');
    INSERT INTO comments (discussion_id, number, user_id, author_name, author_email, body, internal, created_at, raw) VALUES
      (100, 1, 1, 'Ann', NULL, 'It crashes. See ![shot](https://support.nodebox.net/assets/abc/shot.png) and /discussions/problems/100-crash-on-import', 0, '2014-05-02T10:00:00Z', '{}'),
      (100, 2, NULL, 'Guest', 'guest@example.com', 'Same here', 0, '2014-05-02T11:00:00Z', '{}'),
      (100, 3, 2, 'Ann', NULL, 'Internal note', 1, '2014-05-02T12:00:00Z', '{}'),
      (100, 4, 3, 'Bob', NULL, 'Buy cheap pills', 0, '2014-05-02T13:00:00Z', '{}'),
      (100, 5, 2, 'Ann', NULL, 'Fixed, thanks', 0, '2014-05-03T09:00:00Z', '{}'),
      (101, 1, 3, 'Bob', NULL, 'Uw pakket', 0, '2014-05-04T09:00:00Z', '{}'),
      (102, 1, 1, 'Ann', NULL, 'secret', 0, '${t}', '{}'),
      (103, 1, 1, 'Ann', NULL, 'private', 0, '${t}', '{}'),
      (105, 2, NULL, 'Guest', 'guest@example.com', 'Me too', 0, '2014-05-05T10:00:00Z', '{}'),
      (106, 1, 5, 'Carl', NULL, 'Casino', 0, '2014-05-06T09:00:00Z', '{}'),
      (100, 6, 5, 'Carl', NULL, 'More casino', 0, '2014-05-06T10:00:00Z', '{}'),
      (100, 7, 3, 'Bob', NULL, 'Thanks', 0, '2014-05-07T10:00:00Z', '{}');
    INSERT INTO attachments (download_path, download_url, discussion_id, comment_number, filename, content_type, size, raw) VALUES
      ('/assets/abc/shot.png', 'https://s3.example/assets/abc/shot.png?Signature=1', 100, 1, 'shot.png', 'image/png', 1234, '{}'),
      ('/assets/def/project.zip', 'https://s3.example/assets/def/project.zip?Signature=2', 100, 5, 'project.zip', 'application/zip', 99999, '{}'),
      ('/assets/def/project.zip', 'https://s3.example/assets/def/project.zip?Signature=4', 100, 2, 'project.zip', 'application/zip', 99999, '{}'),
      ('/assets/ghi/note.txt', 'https://s3.example/assets/ghi/note.txt?Signature=3', 100, 3, 'note.txt', 'text/plain', 1, '{}');
    -- Same shape as the spam filter's migrations/0002_spam.sql.
    CREATE TABLE spam_verdicts (discussion_id INTEGER NOT NULL, comment_number INTEGER NOT NULL, verdict TEXT NOT NULL, confidence REAL,
      source TEXT NOT NULL, reason TEXT, model TEXT, classified_at TEXT NOT NULL, PRIMARY KEY (discussion_id, comment_number));
    CREATE TABLE spam_decisions (discussion_id INTEGER NOT NULL, comment_number INTEGER NOT NULL, decision TEXT NOT NULL, decided_at TEXT NOT NULL,
      PRIMARY KEY (discussion_id, comment_number));
    CREATE VIEW spam_excluded AS
      SELECT m.discussion_id, m.comment_number, COALESCE(v.reason, 'marked spam in review') AS reason
      FROM spam_decisions m LEFT JOIN spam_verdicts v ON v.discussion_id = m.discussion_id AND v.comment_number = m.comment_number
      WHERE m.decision = 'spam'
      UNION ALL
      SELECT v.discussion_id, v.comment_number, v.reason FROM spam_verdicts v
      LEFT JOIN spam_decisions m ON m.discussion_id = v.discussion_id AND m.comment_number = v.comment_number
      WHERE m.decision IS NULL AND v.verdict = 'spam' AND (v.source <> 'model' OR v.confidence >= 0.9);
    INSERT INTO spam_verdicts VALUES
      (101, 0, 'spam', 0.99, 'model', 'phishing', 'm', '${t}'),
      (106, 0, 'spam', 0.99, 'model', 'casino', 'm', '${t}'),
      (100, 6, 'spam', 0.99, 'model', 'casino', 'm', '${t}'),
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

  assert.deepEqual(db.prepare("SELECT id, slug, topic_count FROM categories").all().map((r) => ({ ...r })), [{ id: 10, slug: "problems", topic_count: 2 }]);

  const topics = db.prepare("SELECT id, title, solved, status, post_count FROM topics ORDER BY id").all().map((r) => ({ ...r }));
  assert.deepEqual(topics, [
    { id: 100, title: "Crash on import", solved: 1, status: "visible", post_count: 4 },
    { id: 101, title: "Pakketmelding", solved: 0, status: "spam", post_count: 0 },
    { id: 105, title: "Opening comment gone", solved: 0, status: "visible", post_count: 1 },
  ]);

  const posts = db.prepare("SELECT topic_id, tender_number, status, body FROM posts ORDER BY id").all() as any[];
  assert.equal(posts.length, 7, "internal note left out");
  assert.deepEqual(posts.map((p) => `${p.topic_id}:${p.tender_number}:${p.status}`), ["100:1:visible", "100:2:visible", "100:4:spam", "100:5:visible", "100:7:visible", "101:1:spam", "105:2:visible"]);
  const shot = attachmentId(100, 1, "/assets/abc/shot.png");
  assert.match(posts[0].body, new RegExp(`!\\[shot\\]\\(/files/${shot}/shot.png\\)`), "attachment link rewritten");
  assert.match(posts[0].body, /\/t\/100\/crash-on-import/, "old discussion link rewritten");

  // Ann's two accounts share an email and become one user. Only people with a visible post come over:
  // Unused started topic 105 but has no post in it, and Carl wrote nothing but spam, so his posts stay behind too.
  // Bob's spam is kept hidden because his other post is visible.
  const users = db.prepare("SELECT id, email, name, tender_id FROM users ORDER BY id").all().map((r) => ({ ...r })) as any[];
  assert.deepEqual(users.map((u) => u.email), ["ann@example.com", "bob@example.com", "guest@example.com"]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM users u WHERE NOT EXISTS (SELECT 1 FROM posts p WHERE p.user_id = u.id AND p.status = 'visible')").get()!.n, 0);
  const guest = users.find((u) => u.email === "guest@example.com").id;
  assert.equal((db.prepare("SELECT user_id FROM topics WHERE id = 105").get() as any).user_id, guest, "a topic's author is the author of its first post");
  assert.equal(new Set((db.prepare("SELECT user_id FROM posts WHERE tender_number IN (1, 5) AND topic_id = 100").all() as any[]).map((r) => r.user_id)).size, 1);

  // A file that hung on two Tender comments becomes two attachments, each with its own stored copy.
  const files = db
    .prepare("SELECT a.filename, p.tender_number, a.post_id, a.r2_key, a.image_id FROM attachments a JOIN posts p ON p.id = a.post_id ORDER BY a.filename, p.tender_number")
    .all()
    .map((r) => ({ ...r })) as any[];
  // Each file sits in the folder of its post: posts/<post id>/<attachment id>/<filename>.
  assert.deepEqual(files.map(({ post_id, ...f }) => ({ ...f, r2_key: f.r2_key.replace(`posts/${post_id}/`, "posts/N/") })), [
    { filename: "project.zip", tender_number: 2, r2_key: `posts/N/${attachmentId(100, 2, "/assets/def/project.zip")}/project.zip`, image_id: null },
    { filename: "project.zip", tender_number: 5, r2_key: `posts/N/${attachmentId(100, 5, "/assets/def/project.zip")}/project.zip`, image_id: null },
    { filename: "shot.png", tender_number: 1, r2_key: `posts/N/${shot}/shot.png`, image_id: `nodebox-forum-${shot}` },
  ]);
  assert.notEqual(files[0]!.r2_key, files[1]!.r2_key);

  assert.equal((db.prepare("SELECT topic_id FROM legacy_redirects WHERE path = '/discussions/problems/100-crash-on-import'").get() as any).topic_id, 100);
  const reasons = db.prepare("SELECT topic_id, tender_number, moderation_reason FROM posts WHERE status = 'spam' ORDER BY id").all().map((r) => ({ ...r }));
  assert.deepEqual(reasons, [
    { topic_id: 100, tender_number: 4, moderation_reason: "Spam filter: marked spam in review" },
    { topic_id: 101, tender_number: 1, moderation_reason: "Spam filter: phishing" },
  ]);
  assert.equal(stats.spamTopics, 1);
  assert.equal(stats.spamPosts, 2);
});

test("works without spam verdicts", () => {
  const db = fixture();
  db.exec("DROP VIEW spam_excluded; DROP TABLE spam_verdicts; DROP TABLE spam_decisions;");
  const { stats } = convert(db);
  assert.equal(stats.spamPosts, 0);
  assert.equal(stats.topics, 4);
});
