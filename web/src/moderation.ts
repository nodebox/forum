import type { PostStatus, User } from "./db.ts";
import { now } from "./util.ts";

/** Reasons offered when removing a post, matching the acceptable use policy. */
export const REMOVAL_REASONS = [
  "Spam or advertising",
  "Abusive, harassing or hateful",
  "Illegal or infringing content",
  "Malware or harmful download",
  "Personal information about someone else",
  "Off-topic or duplicate",
] as const;

export function log(
  db: D1Database,
  entry: { adminId: number | null; action: string; postId?: number; topicId?: number; userId?: number; reason?: string | null },
): D1PreparedStatement {
  return db
    .prepare("INSERT INTO moderation_log (admin_id, action, post_id, topic_id, user_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(entry.adminId, entry.action, entry.postId ?? null, entry.topicId ?? null, entry.userId ?? null, entry.reason ?? null, now());
}

interface PostInfo {
  id: number;
  topic_id: number;
  user_id: number;
  status: PostStatus;
  category_id: number;
  topic_status: PostStatus;
  is_first: number;
}

async function postInfo(db: D1Database, postId: number): Promise<PostInfo | null> {
  return db
    .prepare(
      `SELECT p.id, p.topic_id, p.user_id, p.status, t.category_id, t.status AS topic_status,
              p.id = (SELECT id FROM posts WHERE topic_id = p.topic_id ORDER BY created_at, id LIMIT 1) AS is_first
       FROM posts p JOIN topics t ON t.id = p.topic_id WHERE p.id = ?`,
    )
    .bind(postId)
    .first<PostInfo>();
}

/**
 * Set a post's status (visible, spam, removed) and keep the counts right.
 * Hiding the opening post hides the whole topic; restoring it brings the topic back.
 * Returns the topic id, or null when the post doesn't exist.
 */
export async function setPostStatus(
  db: D1Database,
  postId: number,
  status: PostStatus,
  admin: User,
  reason: string | null,
): Promise<{ topicId: number; topicHidden: boolean } | null> {
  const p = await postInfo(db, postId);
  if (!p) return null;
  if (p.status === status) return { topicId: p.topic_id, topicHidden: p.topic_status !== "visible" };
  const t = now();
  const stmts: D1PreparedStatement[] = [
    db
      .prepare("UPDATE posts SET status = ?, moderated_by = ?, moderated_at = ?, moderation_reason = ? WHERE id = ?")
      .bind(status, admin.id, t, status === "visible" ? null : reason, postId),
    log(db, { adminId: admin.id, action: status === "visible" ? "restore" : status === "spam" ? "spam" : "remove", postId, topicId: p.topic_id, userId: p.user_id, reason }),
  ];
  const wasVisible = p.status === "visible";
  const nowVisible = status === "visible";
  if (p.is_first) {
    stmts.push(db.prepare("UPDATE topics SET status = ? WHERE id = ?").bind(status, p.topic_id));
    if (wasVisible !== nowVisible) {
      stmts.push(db.prepare(`UPDATE categories SET topic_count = topic_count ${nowVisible ? "+" : "-"} 1 WHERE id = ?`).bind(p.category_id));
    }
  }
  if (wasVisible !== nowVisible) stmts.push(...recountTopic(db, p.topic_id));
  await db.batch(stmts);
  return { topicId: p.topic_id, topicHidden: p.is_first ? !nowVisible : p.topic_status !== "visible" };
}

/** Recompute post_count and the "last post" columns from visible posts. */
function recountTopic(db: D1Database, topicId: number): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE topics SET
           post_count = (SELECT count(*) FROM posts WHERE topic_id = ?1 AND status = 'visible'),
           last_post_at = coalesce((SELECT max(created_at) FROM posts WHERE topic_id = ?1 AND status = 'visible'), created_at),
           last_post_user_id = (SELECT user_id FROM posts WHERE topic_id = ?1 AND status = 'visible' ORDER BY created_at DESC, id DESC LIMIT 1)
         WHERE id = ?1`,
      )
      .bind(topicId),
  ];
}

/** Ban a user and mark all their visible posts as spam (for spam accounts). */
export async function banUser(db: D1Database, userId: number, admin: User, alsoSpamPosts: boolean): Promise<void> {
  await db.batch([
    db.prepare("UPDATE users SET banned_at = ? WHERE id = ? AND is_admin = 0").bind(now(), userId),
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    log(db, { adminId: admin.id, action: "ban", userId }),
  ]);
  if (!alsoSpamPosts) return;
  const { results } = await db
    .prepare("SELECT id FROM posts WHERE user_id = ? AND status = 'visible' ORDER BY created_at DESC LIMIT 200")
    .bind(userId)
    .all<{ id: number }>();
  for (const { id } of results) await setPostStatus(db, id, "spam", admin, "Posted by a banned spam account");
}

export async function unbanUser(db: D1Database, userId: number, admin: User): Promise<void> {
  await db.batch([
    db.prepare("UPDATE users SET banned_at = NULL WHERE id = ?").bind(userId),
    log(db, { adminId: admin.id, action: "unban", userId }),
  ]);
}

export async function setAdmin(db: D1Database, userId: number, isAdmin: boolean, admin: User): Promise<void> {
  await db.batch([
    db.prepare("UPDATE users SET is_admin = ? WHERE id = ? AND banned_at IS NULL").bind(isAdmin ? 1 : 0, userId),
    log(db, { adminId: admin.id, action: isAdmin ? "grant_admin" : "revoke_admin", userId }),
  ]);
}

export async function setTopicFlag(db: D1Database, topicId: number, flag: "pinned" | "locked", on: boolean, admin: User): Promise<void> {
  const action = flag === "pinned" ? (on ? "pin" : "unpin") : on ? "lock" : "unlock";
  await db.batch([
    db.prepare(`UPDATE topics SET ${flag} = ? WHERE id = ?`).bind(on ? 1 : 0, topicId),
    log(db, { adminId: admin.id, action, topicId }),
  ]);
}

export interface QueueItem {
  post_id: number;
  topic_id: number;
  topic_title: string;
  topic_slug: string;
  author_id: number;
  author_name: string;
  author_banned: string | null;
  body: string;
  status: PostStatus;
  moderation_reason: string | null;
  moderated_at: string | null;
  moderator_name: string | null;
  created_at: string;
}

/** Hidden posts, newest moderation first. */
export async function moderationQueue(db: D1Database, status: "spam" | "removed", limit: number, offset: number): Promise<QueueItem[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id AS post_id, p.topic_id, t.title AS topic_title, t.slug AS topic_slug, u.id AS author_id, u.name AS author_name,
              u.banned_at AS author_banned, p.body, p.status, p.moderation_reason, p.moderated_at, m.name AS moderator_name, p.created_at
       FROM posts p JOIN topics t ON t.id = p.topic_id JOIN users u ON u.id = p.user_id LEFT JOIN users m ON m.id = p.moderated_by
       WHERE p.status = ? ORDER BY coalesce(p.moderated_at, p.created_at) DESC LIMIT ? OFFSET ?`,
    )
    .bind(status, limit, offset)
    .all<QueueItem>();
  return results;
}

export interface AdminUserRow {
  id: number;
  name: string;
  email: string | null;
  is_admin: number;
  banned_at: string | null;
  created_at: string;
  tender_id: number | null;
  post_count: number;
}

export async function searchUsers(db: D1Database, q: string, limit = 50): Promise<AdminUserRow[]> {
  const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
  const where = q ? "WHERE u.email LIKE ?1 ESCAPE '\\' OR u.name LIKE ?1 ESCAPE '\\'" : "WHERE u.is_admin = 1 OR u.banned_at IS NOT NULL";
  const stmt = db.prepare(
    `SELECT u.id, u.name, u.email, u.is_admin, u.banned_at, u.created_at, u.tender_id,
            (SELECT count(*) FROM posts p WHERE p.user_id = u.id) AS post_count
     FROM users u ${where} ORDER BY u.is_admin DESC, u.name LIMIT ${limit}`,
  );
  const { results } = await (q ? stmt.bind(like) : stmt).all<AdminUserRow>();
  return results;
}

export interface LogRow {
  id: number;
  admin_name: string | null;
  action: string;
  post_id: number | null;
  topic_id: number | null;
  user_name: string | null;
  reason: string | null;
  created_at: string;
}

export async function recentLog(db: D1Database, limit = 100): Promise<LogRow[]> {
  const { results } = await db
    .prepare(
      `SELECT l.id, a.name AS admin_name, l.action, l.post_id, l.topic_id, u.name AS user_name, l.reason, l.created_at
       FROM moderation_log l LEFT JOIN users a ON a.id = l.admin_id LEFT JOIN users u ON u.id = l.user_id
       ORDER BY l.created_at DESC, l.id DESC LIMIT ?`,
    )
    .bind(limit)
    .all<LogRow>();
  return results;
}
