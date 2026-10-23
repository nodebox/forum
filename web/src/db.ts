import { now, slugify } from "./util.ts";

export interface User {
  id: number;
  email: string | null;
  name: string;
  is_admin: number;
  banned_at: string | null;
  created_at: string;
  tender_id: number | null;
  claimed_at: string | null;
  email_digest: number;
  /** Profile picture (src/avatars.ts); null shows initials. */
  avatar: string | null;
}

export type PostStatus = "visible" | "spam" | "removed";

export interface Category {
  id: number;
  slug: string;
  name: string;
  description: string;
  position: number;
  topic_count: number;
  /** No new topics; listed apart in the sidebar. */
  archived: number;
}

export interface TopicRow {
  id: number;
  category_id: number;
  user_id: number;
  title: string;
  slug: string;
  created_at: string;
  last_post_at: string;
  post_count: number;
  pinned: number;
  locked: number;
  tender_id: number | null;
  status: PostStatus;
  author_name: string;
  last_post_user_id: number | null;
  last_post_user_name: string | null;
  category_slug: string;
  category_name: string;
  category_archived: number;
}

export interface PostRow {
  id: number;
  topic_id: number;
  user_id: number;
  body: string;
  created_at: string;
  edited_at: string | null;
  tender_number: number | null;
  status: PostStatus;
  moderation_reason: string | null;
  author_name: string;
  /** Null for no picture, and while the author is banned. */
  author_avatar: string | null;
  author_is_admin: number;
  author_tender_id: number | null;
}

export interface Attachment {
  id: string;
  user_id: number;
  post_id: number | null;
  r2_key: string;
  filename: string;
  content_type: string;
  size: number;
  image_id: string | null;
  width: number | null;
  height: number | null;
  created_at: string;
}

export interface ReactionSummary {
  post_id: number;
  emoji: string;
  count: number;
  names: string;
  mine: number;
}

/** The fixed set of reactions. Order is display order. */
/** Only the heart (Frederik, 2026-10-23). Rows with other emoji from before stay in the table, unshown. */
export const REACTIONS = ["❤️"] as const;

const TOPIC_SELECT = `
  SELECT t.*, u.name AS author_name, lu.name AS last_post_user_name,
         c.slug AS category_slug, c.name AS category_name, c.archived AS category_archived
  FROM topics t
  JOIN users u ON u.id = t.user_id
  LEFT JOIN users lu ON lu.id = t.last_post_user_id
  JOIN categories c ON c.id = t.category_id`;

export async function listCategories(db: D1Database): Promise<Category[]> {
  const { results } = await db.prepare("SELECT * FROM categories ORDER BY position, name").all<Category>();
  return results;
}

export async function getCategory(db: D1Database, slug: string): Promise<Category | null> {
  return db.prepare("SELECT * FROM categories WHERE slug = ?").bind(slug).first<Category>();
}

/** A topic in a list: the topic plus the start of its opening post, for the excerpt line. */
export interface ListTopic extends TopicRow {
  first_body: string | null;
}

const LIST_SELECT = TOPIC_SELECT.replace(
  "c.name AS category_name",
  `c.name AS category_name,
         (SELECT substr(p.body, 1, 600) FROM posts p WHERE p.topic_id = t.id AND p.status = 'visible' ORDER BY p.created_at, p.id LIMIT 1) AS first_body`,
);

/** Topics nobody has answered yet: only the opening post. */
const UNANSWERED = "t.post_count <= 1 AND t.locked = 0 AND t.category_id NOT IN (SELECT id FROM categories WHERE archived = 1)";

export async function latestTopics(db: D1Database, limit: number, offset = 0, opts: { unanswered?: boolean } = {}): Promise<ListTopic[]> {
  const { results } = await db
    .prepare(`${LIST_SELECT} WHERE t.status = 'visible' ${opts.unanswered ? `AND ${UNANSWERED}` : ""} ORDER BY t.last_post_at DESC LIMIT ? OFFSET ?`)
    .bind(limit, offset)
    .all<ListTopic>();
  return results;
}

export async function categoryTopics(db: D1Database, categoryId: number, limit: number, offset: number): Promise<ListTopic[]> {
  const { results } = await db
    .prepare(`${LIST_SELECT} WHERE t.category_id = ? AND t.status = 'visible' ORDER BY t.pinned DESC, t.last_post_at DESC LIMIT ? OFFSET ?`)
    .bind(categoryId, limit, offset)
    .all<ListTopic>();
  return results;
}

export async function unansweredCount(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT count(*) AS n FROM topics t WHERE t.status = 'visible' AND ${UNANSWERED}`).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Turns what someone typed into an FTS5 query: every word must appear, the last one as a prefix. */
export function ftsQuery(q: string): string | null {
  const words = q.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 8) ?? [];
  if (words.length === 0) return null;
  return words.map((w, i) => `"${w}"${i === words.length - 1 ? "*" : ""}`).join(" ");
}

export interface SearchHit extends ListTopic {
  snippet: string;
}

/** Topics whose title or visible posts match, best match first. */
export async function searchTopics(db: D1Database, q: string, limit: number, offset: number): Promise<SearchHit[]> {
  const match = ftsQuery(q);
  if (!match) return [];
  const { results } = await db
    .prepare(
      `WITH hits AS (
         SELECT p.topic_id, bm25(posts_fts) AS rank, snippet(posts_fts, 0, '', '', '…', 24) AS snippet
         FROM posts_fts JOIN posts p ON p.id = posts_fts.rowid
         WHERE posts_fts MATCH ?1 AND p.status = 'visible'
         UNION ALL
         SELECT topics_fts.rowid, bm25(topics_fts) - 10, NULL
         FROM topics_fts WHERE topics_fts MATCH ?1
       ), best AS (
         SELECT topic_id, min(rank) AS rank, max(snippet) AS snippet FROM hits GROUP BY topic_id
       )
       ${LIST_SELECT.replace("FROM topics t", "FROM best b JOIN topics t ON t.id = b.topic_id").replace("SELECT t.*", "SELECT t.*, b.snippet")}
       WHERE t.status = 'visible'
       ORDER BY b.rank LIMIT ?2 OFFSET ?3`,
    )
    .bind(match, limit, offset)
    .all<SearchHit>();
  return results;
}

/** A topic; hidden (spam/removed) topics only when `includeHidden` (admins). */
export async function getTopic(db: D1Database, id: number, includeHidden = false): Promise<TopicRow | null> {
  const where = includeHidden ? "t.id = ?" : "t.id = ? AND t.status = 'visible'";
  return db.prepare(`${TOPIC_SELECT} WHERE ${where}`).bind(id).first<TopicRow>();
}

export async function topicPosts(db: D1Database, topicId: number, limit: number, offset: number, includeHidden = false): Promise<PostRow[]> {
  const { results } = await db
    .prepare(
      `SELECT p.*, u.name AS author_name, CASE WHEN u.banned_at IS NULL THEN u.avatar END AS author_avatar, u.is_admin AS author_is_admin, u.tender_id AS author_tender_id
       FROM posts p JOIN users u ON u.id = p.user_id
       WHERE p.topic_id = ? ${includeHidden ? "" : "AND p.status = 'visible'"}
       ORDER BY p.created_at, p.id LIMIT ? OFFSET ?`,
    )
    .bind(topicId, limit, offset)
    .all<PostRow>();
  return results;
}

/** D1 caps bound parameters per statement; chunk id lists to stay well under it. */
async function byIds<T>(db: D1Database, sql: (placeholders: string) => string, ids: number[], extra: unknown[] = []): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const { results } = await db.prepare(sql(chunk.map(() => "?").join(","))).bind(...extra, ...chunk).all<T>();
    out.push(...results);
  }
  return out;
}

export async function attachmentsForPosts(db: D1Database, postIds: number[]): Promise<Attachment[]> {
  if (postIds.length === 0) return [];
  return byIds<Attachment>(db, (p) => `SELECT * FROM attachments WHERE post_id IN (${p}) ORDER BY created_at`, postIds);
}

export async function reactionsForPosts(db: D1Database, postIds: number[], viewerId: number | null): Promise<ReactionSummary[]> {
  if (postIds.length === 0) return [];
  return byIds<ReactionSummary>(
    db,
    (p) => `SELECT r.post_id, r.emoji, count(*) AS count, group_concat(u.name, ', ') AS names,
                   max(r.user_id = ?) AS mine
            FROM reactions r JOIN users u ON u.id = r.user_id
            WHERE r.post_id IN (${p}) GROUP BY r.post_id, r.emoji`,
    postIds,
    [viewerId ?? -1],
  );
}

export async function createTopic(
  db: D1Database,
  input: { categoryId: number; userId: number; title: string; body: string; attachmentIds: string[]; refused?: string | null },
): Promise<{ topicId: number; postId: number }> {
  const t = now();
  // A post the spam filter refused is stored hidden from the start, so nobody else ever sees it.
  const status = input.refused ? "spam" : "visible";
  const topic = await db
    .prepare(
      `INSERT INTO topics (category_id, user_id, title, slug, created_at, last_post_at, last_post_user_id, post_count, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(input.categoryId, input.userId, input.title, slugify(input.title), t, t, input.userId, input.refused ? 0 : 1, status)
    .first<{ id: number }>();
  const topicId = topic!.id;
  const postId = await insertPost(db, topicId, input.userId, input.body, t, input.refused);
  await batch(db, [
    ...(input.refused
      ? []
      : [
          db.prepare("UPDATE categories SET topic_count = topic_count + 1 WHERE id = ?").bind(input.categoryId),
          // People who start a topic watch it, so they hear about replies.
          db
            .prepare("INSERT INTO topic_users (user_id, topic_id, watching, last_seen_at) VALUES (?, ?, 1, ?) ON CONFLICT DO UPDATE SET watching = 1")
            .bind(input.userId, topicId, t),
        ]),
    ...claimAttachments(db, postId, input.userId, input.attachmentIds),
  ]);
  return { topicId, postId };
}

/** D1 refuses an empty batch. */
async function batch(db: D1Database, stmts: D1PreparedStatement[]): Promise<void> {
  if (stmts.length) await db.batch(stmts);
}

/** Insert a post, visible, or hidden as spam with the filter's reason. */
async function insertPost(db: D1Database, topicId: number, userId: number, body: string, t: string, refused?: string | null): Promise<number> {
  const post = await db
    .prepare(
      `INSERT INTO posts (topic_id, user_id, body, created_at, status, moderated_at, moderation_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(topicId, userId, body, t, refused ? "spam" : "visible", refused ? t : null, refused ? `Spam filter: ${refused}` : null)
    .first<{ id: number }>();
  return post!.id;
}

export async function createReply(
  db: D1Database,
  input: { topicId: number; userId: number; body: string; attachmentIds: string[]; refused?: string | null },
): Promise<number> {
  const t = now();
  const postId = await insertPost(db, input.topicId, input.userId, input.body, t, input.refused);
  await batch(db, [
    ...(input.refused
      ? []
      : [
          db
            .prepare("UPDATE topics SET post_count = post_count + 1, last_post_at = ?, last_post_user_id = ? WHERE id = ?")
            .bind(t, input.userId, input.topicId),
          // Replying watches the topic, unless the person turned watching off for it before.
          db
            .prepare(
              `INSERT INTO topic_users (user_id, topic_id, watching, last_seen_at) VALUES (?, ?, 1, ?)
               ON CONFLICT DO UPDATE SET watching = coalesce(watching, 1), last_seen_at = excluded.last_seen_at`,
            )
            .bind(input.userId, input.topicId, t),
        ]),
    ...claimAttachments(db, postId, input.userId, input.attachmentIds),
  ]);
  return postId;
}

/** Authors can edit their own posts, and a topic's opener its title, for this long after posting. */
export const EDIT_WINDOW_MS = 24 * 3600 * 1000;

export const editableUntil = (post: { created_at: string }) => Date.parse(post.created_at) + EDIT_WINDOW_MS;

/**
 * Whether this person may edit this post now: their own visible post, in a visible topic that
 * isn't locked (admins may still edit in locked ones), within the edit window.
 */
export function canEditPost(
  user: User | null,
  post: { user_id: number; created_at: string; status: PostStatus },
  topic: { locked: number; status: PostStatus },
  nowMs = Date.now(),
): boolean {
  if (!user || user.banned_at || user.id !== post.user_id) return false;
  if (post.status !== "visible" || topic.status !== "visible") return false;
  if (topic.locked && !user.is_admin) return false;
  return nowMs < editableUntil(post);
}

/** One post with what editing it needs: its topic id and whether it opens the topic. */
export async function getPostForEdit(db: D1Database, id: number): Promise<(PostRow & { opens_topic: number }) | null> {
  return db
    .prepare(
      `SELECT p.*, u.name AS author_name, NULL AS author_avatar, u.is_admin AS author_is_admin, u.tender_id AS author_tender_id,
         p.id = (SELECT id FROM posts WHERE topic_id = p.topic_id ORDER BY created_at, id LIMIT 1) AS opens_topic
       FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?`,
    )
    .bind(id)
    .first<PostRow & { opens_topic: number }>();
}

/**
 * Save an author's edit: the new text, the new title when it is the opening post, and attach
 * any files added while editing. The post shows as edited; the slug follows a new title.
 */
export async function editPost(
  db: D1Database,
  input: { postId: number; topicId: number; userId: number; body: string; title?: string; attachmentIds: string[] },
): Promise<void> {
  await batch(db, [
    db.prepare("UPDATE posts SET body = ?, edited_at = ? WHERE id = ?").bind(input.body, now(), input.postId),
    ...(input.title ? [db.prepare("UPDATE topics SET title = ?, slug = ? WHERE id = ?").bind(input.title, slugify(input.title), input.topicId)] : []),
    ...claimAttachments(db, input.postId, input.userId, input.attachmentIds),
  ]);
}

/** Attach uploads to a post. Only the uploader's own, still-unattached files can be claimed. */
function claimAttachments(db: D1Database, postId: number, userId: number, ids: string[]): D1PreparedStatement[] {
  return ids
    .slice(0, 50)
    .map((id) => db.prepare("UPDATE attachments SET post_id = ? WHERE id = ? AND user_id = ? AND post_id IS NULL").bind(postId, id, userId));
}

/** Toggle a reaction; returns whether it is now on. */
export async function toggleReaction(db: D1Database, postId: number, userId: number, emoji: string): Promise<boolean> {
  const del = await db
    .prepare("DELETE FROM reactions WHERE post_id = ? AND user_id = ? AND emoji = ?")
    .bind(postId, userId, emoji)
    .run();
  if (del.meta.changes > 0) return false;
  await db
    .prepare("INSERT OR IGNORE INTO reactions (post_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)")
    .bind(postId, userId, emoji, now())
    .run();
  return true;
}

/** Position of a post in its topic (0-based), to link to the right page. */
export async function postIndex(db: D1Database, topicId: number, postId: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT count(*) AS n FROM posts
       WHERE topic_id = ? AND status = 'visible'
         AND (created_at, id) < (SELECT created_at, id FROM posts WHERE id = ?)`,
    )
    .bind(topicId, postId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Fixed-window rate limit. Returns false when `key` is over `max` in the current window. */
export async function rateLimit(db: D1Database, key: string, max: number, windowSeconds: number): Promise<boolean> {
  const windowStart = new Date(Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds * 1000).toISOString();
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,
         window_start = excluded.window_start
       RETURNING count`,
    )
    .bind(key, windowStart)
    .first<{ count: number }>();
  return (row?.count ?? 0) <= max;
}
