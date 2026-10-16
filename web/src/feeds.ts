// RSS 2.0 feeds. Public and the same for everyone: only visible posts in visible topics,
// whoever asks, so a moderator's reader never shows hidden posts.
import { ftsQuery, attachmentsForPosts, type Attachment } from "./db.ts";
import { fileUrl, imageUrls, isImage } from "./files.ts";
import { excerpt, referencedAttachmentIds, renderMarkdown } from "./markdown.ts";
import { formatBytes } from "./util.ts";
import type { Bindings } from "./env.ts";

/** A post as a feed item, with what's needed to say where it belongs. */
export interface FeedRow {
  post_id: number;
  topic_id: number;
  title: string;
  slug: string;
  body: string;
  created_at: string;
  author_name: string;
  category_slug: string;
  category_name: string;
  /** 1 when the post opens its topic. */
  is_first: number;
}

const FEED_COLUMNS = `
  SELECT p.id AS post_id, t.id AS topic_id, t.title, t.slug, p.body, p.created_at, u.name AS author_name,
         c.slug AS category_slug, c.name AS category_name`;
const FEED_JOINS = `
  JOIN users u ON u.id = p.user_id
  JOIN categories c ON c.id = t.category_id`;
const OPENING_POST = "(SELECT f.id FROM posts f WHERE f.topic_id = t.id ORDER BY f.created_at, f.id LIMIT 1)";
const FEED_SELECT = `${FEED_COLUMNS}, p.id = ${OPENING_POST} AS is_first
  FROM posts p JOIN topics t ON t.id = p.topic_id${FEED_JOINS}`;

export type FeedFilter = { categoryId?: number; topicId?: number };

function filterSql(f: FeedFilter): { sql: string; args: unknown[] } {
  const parts: string[] = [];
  const args: unknown[] = [];
  if (f.categoryId !== undefined) (parts.push("t.category_id = ?"), args.push(f.categoryId));
  if (f.topicId !== undefined) (parts.push("t.id = ?"), args.push(f.topicId));
  return { sql: parts.map((p) => ` AND ${p}`).join(""), args };
}

/** New topics, newest first, each with its opening post. `unanswered` keeps those nobody replied to. */
export async function feedTopics(db: D1Database, limit: number, f: FeedFilter & { unanswered?: boolean } = {}): Promise<FeedRow[]> {
  const { sql, args } = filterSql(f);
  const unanswered = f.unanswered
    ? " AND t.post_count <= 1 AND t.locked = 0 AND t.category_id NOT IN (SELECT id FROM categories WHERE archived = 1)"
    : "";
  const { results } = await db
    .prepare(
      `${FEED_COLUMNS}, 1 AS is_first
       FROM topics t JOIN posts p ON p.id = ${OPENING_POST}${FEED_JOINS}
       WHERE t.status = 'visible' AND p.status = 'visible'${sql}${unanswered}
       ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
    )
    .bind(...args, limit)
    .all<FeedRow>();
  return results;
}

/** Every visible post, replies included, newest first. */
export async function feedPosts(db: D1Database, limit: number, f: FeedFilter = {}): Promise<FeedRow[]> {
  const { sql, args } = filterSql(f);
  const { results } = await db
    .prepare(`${FEED_SELECT} WHERE p.status = 'visible' AND t.status = 'visible'${sql} ORDER BY p.created_at DESC, p.id DESC LIMIT ?`)
    .bind(...args, limit)
    .all<FeedRow>();
  return results;
}

/** Posts that match a search, newest first; a topic whose title matches brings its opening post. */
export async function feedSearch(db: D1Database, q: string, limit: number): Promise<FeedRow[]> {
  const match = ftsQuery(q);
  if (!match) return [];
  const { results } = await db
    .prepare(
      `SELECT * FROM (${FEED_SELECT} WHERE p.status = 'visible' AND t.status = 'visible'
         AND (p.id IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?1) OR t.id IN (SELECT rowid FROM topics_fts WHERE topics_fts MATCH ?1)))
       WHERE is_first = 1 OR post_id IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?1)
       ORDER BY created_at DESC, post_id DESC LIMIT ?2`,
    )
    .bind(match, limit)
    .all<FeedRow>();
  return results;
}

export interface Feed {
  title: string;
  description: string;
  /** The page this feed follows, as a path. */
  page: string;
  /** The feed's own URL, as a path with its query. */
  self: string;
  rows: FeedRow[];
}

const xml = (s: string) =>
  s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Links in posts are site-relative; a feed reader needs them absolute. */
function absolutize(htmlText: string, base: string): string {
  return htmlText.replace(/(\s(?:href|src)=")\/(?!\/)/g, `$1${base}/`);
}

/** A post's own HTML plus the attachments the topic page shows under it. */
function itemHtml(env: Bindings, row: FeedRow, attachments: Attachment[], base: string): string {
  const byId = new Map(attachments.map((a) => [a.id, a]));
  let out = renderMarkdown(row.body, { attachments: byId, image: (a) => imageUrls(env, a) });
  const inline = referencedAttachmentIds(row.body);
  const rest = attachments.filter((a) => !inline.has(a.id));
  for (const a of rest.filter((a) => isImage(a.content_type))) {
    const u = imageUrls(env, a);
    out += `<p><a href="${xml(u.full)}"><img src="${xml(u.src)}" alt="${xml(a.filename)}"></a></p>`;
  }
  const files = rest.filter((a) => !isImage(a.content_type));
  if (files.length) {
    out += `<ul>${files.map((a) => `<li><a href="${xml(fileUrl(a))}">${xml(a.filename)}</a> (${formatBytes(a.size)})</li>`).join("")}</ul>`;
  }
  return absolutize(out, base);
}

/** Renders a feed as RSS 2.0, with the full post in content:encoded and a short excerpt in description. */
export async function renderFeed(env: Bindings, db: D1Database, feed: Feed): Promise<string> {
  const base = env.PUBLIC_URL.replace(/\/+$/, "");
  const attachments = await attachmentsForPosts(db, feed.rows.map((r) => r.post_id));
  const items = feed.rows.map((row) => {
    const topicLink = `${base}/t/${row.topic_id}/${row.slug}`;
    const permalink = `${base}/p/${row.post_id}`;
    const title = row.is_first ? row.title : `Re: ${row.title}`;
    const mine = attachments.filter((a) => a.post_id === row.post_id);
    return `    <item>
      <title>${xml(title)}</title>
      <link>${xml(row.is_first ? topicLink : permalink)}</link>
      <guid isPermaLink="true">${xml(permalink)}</guid>
      <pubDate>${new Date(row.created_at).toUTCString()}</pubDate>
      <dc:creator>${xml(row.author_name)}</dc:creator>
      <category domain="${xml(`${base}/c/${row.category_slug}`)}">${xml(row.category_name)}</category>
      <comments>${xml(topicLink)}</comments>
      <description>${xml(excerpt(row.body, 300))}</description>
      <content:encoded>${xml(itemHtml(env, row, mine, base))}</content:encoded>
    </item>`;
  });
  const updated = lastModified(feed.rows);
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${xml(feed.title)}</title>
    <link>${xml(base + feed.page)}</link>
    <atom:link href="${xml(base + feed.self)}" rel="self" type="application/rss+xml"/>
    <description>${xml(feed.description)}</description>
    <language>en</language>
    <ttl>15</ttl>
${updated ? `    <lastBuildDate>${updated}</lastBuildDate>\n` : ""}${items.join("\n")}${items.length ? "\n" : ""}  </channel>
</rss>
`;
}

/** The newest item's time, for Last-Modified. */
export function lastModified(rows: FeedRow[]): string | null {
  const newest = rows.reduce((max, r) => (r.created_at > max ? r.created_at : max), "");
  return newest ? new Date(newest).toUTCString() : null;
}
