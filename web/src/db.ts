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
}

export type PostStatus = "visible" | "spam" | "removed";

export interface Category {
  id: number;
  slug: string;
  name: string;
  description: string;
  position: number;
  topic_count: number;
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
  solved: number;
  tender_id: number | null;
  status: PostStatus;
  author_name: string;
  last_post_user_id: number | null;
  last_post_user_name: string | null;
  category_slug: string;
  category_name: string;
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
export const REACTIONS = ["👍", "❤️", "😄", "🎉", "🤔", "👀"] as const;

const TOPIC_SELECT = `
  SELECT t.*, u.name AS author_name, lu.name AS last_post_user_name,
         c.slug AS category_slug, c.name AS category_name
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

export async function latestTopics(db: D1Database, limit: number, offset = 0): Promise<TopicRow[]> {
  const { results } = await db
    .prepare(`${TOPIC_SELECT} WHERE t.status = 'visible' ORDER BY t.last_post_at DESC LIMIT ? OFFSET ?`)
    .bind(limit, offset)
    .all<TopicRow>();
  return results;
}

export async function categoryTopics(db: D1Database, categoryId: number, limit: number, offset: number): Promise<TopicRow[]> {
  const { results } = await db
    .prepare(`${TOPIC_SELECT} WHERE t.category_id = ? AND t.status = 'visible' ORDER BY t.pinned DESC, t.last_post_at DESC LIMIT ? OFFSET ?`)
    .bind(categoryId, limit, offset)
    .all<TopicRow>();
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
      `SELECT p.*, u.name AS author_name, u.is_admin AS author_is_admin, u.tender_id AS author_tender_id
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
  input: { categoryId: number; userId: number; title: string; body: string; attachmentIds: string[] },
): Promise<{ topicId: number; postId: number }> {
  const t = now();
  const topic = await db
    .prepare(
      `INSERT INTO topics (category_id, user_id, title, slug, created_at, last_post_at, last_post_user_id, post_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1) RETURNING id`,
    )
    .bind(input.categoryId, input.userId, input.title, slugify(input.title), t, t, input.userId)
    .first<{ id: number }>();
  const topicId = topic!.id;
  const post = await db
    .prepare("INSERT INTO posts (topic_id, user_id, body, created_at) VALUES (?, ?, ?, ?) RETURNING id")
    .bind(topicId, input.userId, input.body, t)
    .first<{ id: number }>();
  await db.batch([
    db.prepare("UPDATE categories SET topic_count = topic_count + 1 WHERE id = ?").bind(input.categoryId),
    ...claimAttachments(db, post!.id, input.userId, input.attachmentIds),
  ]);
  return { topicId, postId: post!.id };
}

export async function createReply(
  db: D1Database,
  input: { topicId: number; userId: number; body: string; attachmentIds: string[] },
): Promise<number> {
  const t = now();
  const post = await db
    .prepare("INSERT INTO posts (topic_id, user_id, body, created_at) VALUES (?, ?, ?, ?) RETURNING id")
    .bind(input.topicId, input.userId, input.body, t)
    .first<{ id: number }>();
  await db.batch([
    db
      .prepare("UPDATE topics SET post_count = post_count + 1, last_post_at = ?, last_post_user_id = ? WHERE id = ?")
      .bind(t, input.userId, input.topicId),
    ...claimAttachments(db, post!.id, input.userId, input.attachmentIds),
  ]);
  return post!.id;
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
