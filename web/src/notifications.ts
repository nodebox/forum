import type { Bindings } from "./env.ts";
import { sendMail } from "./mailer.ts";
import { now, randomId } from "./util.ts";

/** At most one digest per person in this window; the hourly cron sends the first one soon after a reply. */
const DIGEST_EVERY_HOURS = 20;

export interface TopicUserState {
  watching: number;
  last_seen_at: string | null;
}

export async function topicUserState(db: D1Database, userId: number, topicId: number): Promise<TopicUserState | null> {
  return db.prepare("SELECT watching, last_seen_at FROM topic_users WHERE user_id = ? AND topic_id = ?").bind(userId, topicId).first<TopicUserState>();
}

/** Record that someone opened a topic (for "new" counts, and so digests skip what they've read). */
export async function markSeen(db: D1Database, userId: number, topicId: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO topic_users (user_id, topic_id, last_seen_at) VALUES (?, ?, ?)
       ON CONFLICT DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    )
    .bind(userId, topicId, now())
    .run();
}

export async function setWatching(db: D1Database, userId: number, topicId: number, watching: boolean): Promise<void> {
  await db
    .prepare(
      `INSERT INTO topic_users (user_id, topic_id, watching, last_seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT DO UPDATE SET watching = excluded.watching`,
    )
    .bind(userId, topicId, watching ? 1 : 0, now())
    .run();
}

export interface YourThread {
  id: number;
  title: string;
  slug: string;
  last_post_at: string;
  post_count: number;
  watching: number;
  started: number;
  new_posts: number;
  category_id: number;
  category_name: string;
  category_slug: string;
  pinned: number;
  locked: number;
  solved: number;
}

/** Topics someone started, replied to or watches, newest activity first, with unread counts. */
export async function yourThreads(db: D1Database, userId: number, limit = 100): Promise<YourThread[]> {
  const { results } = await db
    .prepare(
      `SELECT t.id, t.title, t.slug, t.last_post_at, t.post_count, coalesce(tu.watching, 0) AS watching,
              t.user_id = ?1 AS started, t.category_id, t.pinned, t.locked, t.solved, c.name AS category_name, c.slug AS category_slug,
              (SELECT count(*) FROM posts p WHERE p.topic_id = t.id AND p.status = 'visible' AND p.user_id <> ?1
                 AND p.created_at > coalesce(tu.last_seen_at, '')) AS new_posts
       FROM topics t
       JOIN categories c ON c.id = t.category_id
       LEFT JOIN topic_users tu ON tu.topic_id = t.id AND tu.user_id = ?1
       WHERE t.status = 'visible'
         AND (tu.watching = 1 OR t.user_id = ?1 OR EXISTS (SELECT 1 FROM posts p WHERE p.topic_id = t.id AND p.user_id = ?1))
       ORDER BY t.last_post_at DESC LIMIT ?2`,
    )
    .bind(userId, limit)
    .all<YourThread>();
  return results;
}

export async function unsubscribeToken(db: D1Database, userId: number): Promise<string> {
  const row = await db.prepare("SELECT unsubscribe_token FROM users WHERE id = ?").bind(userId).first<{ unsubscribe_token: string | null }>();
  if (row?.unsubscribe_token) return row.unsubscribe_token;
  const token = randomId(24);
  await db.prepare("UPDATE users SET unsubscribe_token = coalesce(unsubscribe_token, ?) WHERE id = ?").bind(token, userId).run();
  return (await db.prepare("SELECT unsubscribe_token FROM users WHERE id = ?").bind(userId).first<{ unsubscribe_token: string }>())!.unsubscribe_token;
}

interface DigestTopic {
  topic_id: number;
  title: string;
  slug: string;
  new_posts: number;
  authors: string;
  first_post_id: number;
}

/**
 * Send grouped email digests: one email per person listing every watched topic
 * with replies they haven't seen, at most once per DIGEST_EVERY_HOURS.
 * Run from the hourly cron. Returns how many emails went out.
 */
export async function sendDigests(env: Bindings, limit = 50): Promise<number> {
  const db = env.DB;
  const cutoff = new Date(Date.now() - DIGEST_EVERY_HOURS * 3600_000).toISOString();
  // A post is pending for a watcher when it's newer than both their last visit and their last digest.
  const pending = `
    tu.watching = 1 AND p.status = 'visible' AND t.status = 'visible' AND p.user_id <> tu.user_id
    AND p.created_at > max(coalesce(tu.last_seen_at, ''), coalesce(tu.notified_at, ''))`;
  const { results: people } = await db
    .prepare(
      `SELECT u.id, u.email, u.name FROM users u
       WHERE u.email IS NOT NULL AND u.banned_at IS NULL AND u.email_digest = 1
         AND (u.last_digest_at IS NULL OR u.last_digest_at < ?)
         AND EXISTS (
           SELECT 1 FROM topic_users tu
           JOIN posts p ON p.topic_id = tu.topic_id JOIN topics t ON t.id = tu.topic_id
           WHERE tu.user_id = u.id AND ${pending})
       LIMIT ?`,
    )
    .bind(cutoff, limit)
    .all<{ id: number; email: string; name: string }>();

  let sent = 0;
  for (const person of people) {
    const { results: topics } = await db
      .prepare(
        `SELECT t.id AS topic_id, t.title, t.slug, count(*) AS new_posts,
                group_concat(DISTINCT a.name) AS authors, min(p.id) AS first_post_id
         FROM topic_users tu
         JOIN topics t ON t.id = tu.topic_id JOIN posts p ON p.topic_id = t.id JOIN users a ON a.id = p.user_id
         WHERE tu.user_id = ? AND ${pending}
         GROUP BY t.id ORDER BY max(p.created_at) DESC LIMIT 20`,
      )
      .bind(person.id)
      .all<DigestTopic>();
    if (topics.length === 0) continue;
    const base = env.PUBLIC_URL.replace(/\/$/, "");
    const unsubscribe = `${base}/unsubscribe?u=${person.id}&t=${await unsubscribeToken(db, person.id)}`;
    const mail = digestMail(env.SITE_NAME, base, topics, unsubscribe);
    try {
      await sendMail(env, { to: person.email, ...mail, headers: { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
    } catch (err) {
      console.error(`digest for user ${person.id} failed`, err);
      continue;
    }
    const t = now();
    await db.batch([
      db.prepare("UPDATE users SET last_digest_at = ? WHERE id = ?").bind(t, person.id),
      ...topics.map((x) => db.prepare("UPDATE topic_users SET notified_at = ? WHERE user_id = ? AND topic_id = ?").bind(t, person.id, x.topic_id)),
    ]);
    sent++;
  }
  return sent;
}

function digestMail(siteName: string, base: string, topics: DigestTopic[], unsubscribe: string) {
  const total = topics.reduce((n, t) => n + t.new_posts, 0);
  const subject =
    topics.length === 1
      ? `New ${topics[0]!.new_posts === 1 ? "reply" : "replies"} in “${topics[0]!.title}”`
      : `${total} new replies in ${topics.length} topics you follow`;
  const line = (t: DigestTopic) => {
    const who = t.authors.split(",").slice(0, 3).join(", ");
    return { text: `${t.title}\n  ${t.new_posts} new from ${who}\n  ${base}/t/${t.topic_id}/${t.slug}#post-${t.first_post_id}`, t, who };
  };
  const lines = topics.map(line);
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const text =
    `New replies on the ${siteName} in topics you follow:\n\n` +
    lines.map((l) => l.text).join("\n\n") +
    `\n\nYou get at most one of these a day. Stop them: ${unsubscribe}\n`;
  const html =
    `<div style="font-family:system-ui,sans-serif;color:#041a32;max-width:560px">` +
    `<p>New replies on the ${esc(siteName)} in topics you follow:</p>` +
    lines
      .map(
        (l) =>
          `<p style="margin:0 0 16px"><a href="${esc(`${base}/t/${l.t.topic_id}/${l.t.slug}#post-${l.t.first_post_id}`)}" style="color:#041a32;font-weight:700">${esc(l.t.title)}</a><br>` +
          `<span style="color:#5c6b80">${l.t.new_posts} new from ${esc(l.who)}</span></p>`,
      )
      .join("") +
    `<p style="color:#5c6b80;font-size:13px;margin-top:24px">You get at most one of these a day. <a href="${esc(unsubscribe)}" style="color:#5c6b80">Stop these emails</a>.</p></div>`;
  return { subject, text, html };
}
