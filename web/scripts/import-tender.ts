// Turn the Tender export (data/forum.sqlite, see ../../migrations/0001_tender_import.sql)
// into SQL for the forum schema (migrations/0001_init.sql).
//
//   npm run import:tender                      # reads ../data/forum.sqlite, writes ../data/import.sql
//   npm run import:tender -- in.sqlite out.sql
//   npx wrangler d1 execute nodebox-forum --local --file ../data/import.sql
//
// The output expects an empty, freshly migrated database: the plan is to import
// once more into a new database at cutover, before the forum opens.
//
// What comes over: public categories; open/assigned/resolved public discussions
// (resolved becomes "solved"); comments that aren't internal notes or system
// messages; the users who wrote them (deduplicated on email); attachment
// metadata (files are uploaded separately); old URLs for redirects.
// Items the spam filter flagged (the `spam_excluded` view, if present) are
// imported with status 'spam': hidden, but admins can restore them.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface ImportStats {
  categories: number;
  users: number;
  topics: number;
  posts: number;
  spamTopics: number;
  spamPosts: number;
  attachments: number;
  redirects: number;
  skippedDiscussions: number;
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Ids for placeholder users (authors without a Tender user record) start here, clear of Tender's ids. */
const PLACEHOLDER_BASE = 2_000_000_000;

export function sql(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${String(v).replace(/'/g, "''")}'`;
}

function insert(table: string, row: Record<string, unknown>): string {
  const cols = Object.keys(row);
  return `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => sql(row[c])).join(", ")});`;
}

export function slugify(text: string, max = 60): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
  return slug || "topic";
}

/** Same as the exporter's attachmentLocalPath: the file's path under data/attachments/. */
export function attachmentLocalPath(downloadPath: string): string {
  return new URL(downloadPath, "https://x").pathname
    .split("/")
    .filter(Boolean)
    .map((seg) => {
      let s = seg;
      try {
        s = decodeURIComponent(seg);
      } catch {}
      return s.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+$/, "_");
    })
    .join("/");
}

/** Stable attachment id, so re-running the import (and the uploader) agree. */
export function attachmentId(downloadPath: string): string {
  return createHash("sha256").update(downloadPath).digest("base64url").slice(0, 16);
}

const iso = (s: string | null | undefined) => (s ? new Date(s).toISOString() : null);
const isPublic = (v: unknown) => v === null || v === undefined || Number(v) !== 0;

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?").get(name));
}

/** Rough HTML to text, for comments that only have Tender's rendered HTML. */
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

export function convert(src: DatabaseSync, imagesPrefix = "nodebox-forum-"): { statements: string[]; stats: ImportStats } {
  const out: string[] = [];
  const stats: ImportStats = { categories: 0, users: 0, topics: 0, posts: 0, spamTopics: 0, spamPosts: 0, attachments: 0, redirects: 0, skippedDiscussions: 0 };

  // Spam flags from the spam filter (migrations/0002_spam.sql), if it has run.
  // `spam_excluded` already folds in review decisions and the confidence
  // threshold; comment_number 0 means the whole discussion. Every row is spam.
  const spamDiscussions = new Map<number, string>();
  const spamComments = new Map<string, string>();
  if (tableExists(src, "spam_excluded")) {
    for (const r of src.prepare("SELECT discussion_id, comment_number, reason FROM spam_excluded").all() as any[]) {
      const reason = `Spam filter${r.reason ? `: ${r.reason}` : ""}`.slice(0, 300);
      if (r.comment_number === 0) spamDiscussions.set(r.discussion_id, reason);
      else spamComments.set(`${r.discussion_id}:${r.comment_number}`, reason);
    }
  }

  // Categories
  const categories = src.prepare("SELECT id, name, permalink, summary, public FROM categories ORDER BY id").all() as any[];
  const catIds = new Set<number>();
  const usedSlugs = new Set<string>();
  categories.forEach((c, i) => {
    if (!isPublic(c.public)) return;
    let slug = slugify(c.permalink || c.name, 40);
    while (usedSlugs.has(slug)) slug += "-x";
    usedSlugs.add(slug);
    catIds.add(c.id);
    out.push(insert("categories", { id: c.id, slug, name: c.name, description: c.summary ?? "", position: i, topic_count: 0, tender_id: c.id }));
    stats.categories++;
  });

  // Users: keyed by lowercased email; Tender users without email keep their own row.
  const tenderUsers = new Map<number, any>();
  for (const u of src.prepare("SELECT id, name, email, created_at FROM users").all() as any[]) tenderUsers.set(u.id, u);
  const userByEmail = new Map<string, number>(); // email -> forum user id
  const users = new Map<number, { id: number; name: string; email: string | null; created_at: string; tender_id: number | null }>();
  const placeholders = new Map<string, number>(); // author_name -> id, for authors with neither user nor email
  let nextPlaceholder = PLACEHOLDER_BASE;

  function userFor(userId: number | null, authorName: string | null, authorEmail: string | null, when: string | null): number {
    const tu = userId !== null ? tenderUsers.get(userId) : undefined;
    const email = ((tu?.email ?? authorEmail) as string | null)?.trim().toLowerCase() || null;
    if (email && userByEmail.has(email)) return userByEmail.get(email)!;
    if (!email && tu && users.has(tu.id)) return tu.id;
    const name = (tu?.name ?? authorName ?? (email ? email.split("@")[0] : null) ?? "Former member").toString().trim().slice(0, 60) || "Former member";
    let id: number;
    if (tu) id = tu.id;
    else if (!email && placeholders.has(name)) return placeholders.get(name)!;
    else id = nextPlaceholder++;
    if (!email && !tu) placeholders.set(name, id);
    users.set(id, { id, name, email, created_at: iso(tu?.created_at) ?? iso(when) ?? new Date(0).toISOString(), tender_id: tu ? tu.id : null });
    if (email) userByEmail.set(email, id);
    return id;
  }

  // Discussions and their comments
  const discussions = src
    .prepare(
      `SELECT id, category_id, title, state, public, html_href, user_id, author_name, author_email, created_at
       FROM discussions WHERE state IN ('open', 'assigned', 'resolved') ORDER BY created_at, id`,
    )
    .all() as any[];
  const commentsStmt = src.prepare(
    `SELECT number, user_id, author_name, author_email, body, formatted_body, created_at
     FROM comments WHERE discussion_id = ? AND coalesce(internal, 0) = 0 AND coalesce(system_message, 0) = 0
     ORDER BY number`,
  );
  const attachmentsStmt = src.prepare(
    "SELECT download_path, comment_number, filename, content_type, size, width, height, created_at, local_path FROM attachments WHERE discussion_id = ?",
  );

  // Old URLs -> new topic paths, for rewriting links inside bodies.
  const topicPathByOldUrl = new Map<string, string>();
  const kept: { d: any; comments: any[]; slug: string }[] = [];
  for (const d of discussions) {
    if (!isPublic(d.public) || !catIds.has(d.category_id)) {
      stats.skippedDiscussions++;
      continue;
    }
    const comments = commentsStmt.all(d.id) as any[];
    if (comments.length === 0) {
      stats.skippedDiscussions++;
      continue;
    }
    const slug = slugify(d.title ?? "topic");
    kept.push({ d, comments, slug });
    if (d.html_href) topicPathByOldUrl.set(new URL(d.html_href).pathname.replace(/\/$/, ""), `/t/${d.id}/${slug}`);
  }

  const categoryCounts = new Map<number, number>();
  let postId = 0;
  for (const { d, comments, slug } of kept) {
    const files = attachmentsStmt.all(d.id) as any[];
    const fileUrlByPath = new Map<string, string>();
    for (const f of files) fileUrlByPath.set(f.download_path, `/files/${attachmentId(f.download_path)}/${encodeURIComponent(f.filename ?? "file")}`);

    const rewrite = (text: string) =>
      text.replace(/(https?:\/\/[^\s)"'<>]+|\/assets\/[^\s)"'<>]+|\/discussions\/[^\s)"'<>]+)/g, (url) => {
        let p: string;
        try {
          p = new URL(url, "https://x").pathname;
        } catch {
          return url;
        }
        for (const [dp, fu] of fileUrlByPath) if (p === new URL(dp, "https://x").pathname) return fu;
        return topicPathByOldUrl.get(p.replace(/\/$/, "")) ?? url;
      });

    const topicSpam = spamDiscussions.get(d.id) ?? (spamComments.has(`${d.id}:${comments[0].number}`) ? spamComments.get(`${d.id}:${comments[0].number}`)! : null);
    const topicStatus = topicSpam ? "spam" : "visible";
    const authorId = userFor(d.user_id ?? comments[0].user_id, d.author_name ?? comments[0].author_name, d.author_email ?? comments[0].author_email, d.created_at);
    const postRows: Record<string, unknown>[] = [];
    let visible = 0;
    let last: { at: string; user: number } | null = null;
    const postIdByNumber = new Map<number, number>();
    for (const c of comments) {
      const userId = userFor(c.user_id, c.author_name, c.author_email, c.created_at);
      const reason = topicSpam ?? spamComments.get(`${d.id}:${c.number}`) ?? null;
      const status = reason ? "spam" : "visible";
      const created = iso(c.created_at) ?? iso(d.created_at)!;
      postId++;
      postIdByNumber.set(c.number, postId);
      postRows.push({
        id: postId,
        topic_id: d.id,
        user_id: userId,
        body: rewrite(c.body ?? (c.formatted_body ? htmlToText(c.formatted_body) : "")),
        created_at: created,
        status,
        moderated_at: reason ? new Date().toISOString() : null,
        moderation_reason: reason,
        tender_number: c.number,
      });
      if (status === "visible") {
        visible++;
        last = { at: created, user: userId };
      } else stats.spamPosts++;
    }
    const created = iso(d.created_at) ?? (postRows[0]!.created_at as string);
    out.push(
      insert("topics", {
        id: d.id,
        category_id: d.category_id,
        user_id: authorId,
        title: (d.title ?? "Untitled").slice(0, 160),
        slug,
        created_at: created,
        last_post_at: last?.at ?? created,
        last_post_user_id: last?.user ?? authorId,
        post_count: visible,
        solved: d.state === "resolved" ? 1 : 0,
        status: topicStatus,
        tender_id: d.id,
      }),
    );
    for (const row of postRows) out.push(insert("posts", row));
    for (const f of files) {
      const pid = postIdByNumber.get(f.comment_number);
      if (pid === undefined) continue; // attachment on an internal note
      const id = attachmentId(f.download_path);
      const type = f.content_type || "application/octet-stream";
      out.push(
        insert("attachments", {
          id,
          user_id: postRows.find((r) => r.id === pid)!.user_id,
          post_id: pid,
          r2_key: `tender/${attachmentLocalPath(f.download_path)}`,
          filename: f.filename ?? "file",
          content_type: type,
          size: f.size ?? 0,
          image_id: IMAGE_TYPES.has(type) ? `${imagesPrefix}${id}` : null,
          width: f.width ?? null,
          height: f.height ?? null,
          created_at: iso(f.created_at) ?? created,
        }),
      );
      stats.attachments++;
    }
    if (d.html_href) {
      out.push(insert("legacy_redirects", { path: new URL(d.html_href).pathname.replace(/\/$/, ""), topic_id: d.id }));
      stats.redirects++;
    }
    stats.topics++;
    stats.posts += postRows.length;
    if (topicStatus === "spam") stats.spamTopics++;
    else categoryCounts.set(d.category_id, (categoryCounts.get(d.category_id) ?? 0) + 1);
  }

  for (const [catId, n] of categoryCounts) out.push(`UPDATE categories SET topic_count = ${n} WHERE id = ${catId};`);

  // Users go first so foreign keys resolve.
  const userStatements = [...users.values()].map((u) =>
    insert("users", { id: u.id, email: u.email, name: u.name, created_at: u.created_at, tender_id: u.tender_id }),
  );
  stats.users = users.size;
  return { statements: [...userStatements, ...out], stats };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const input = process.argv[2] ?? path.join(here, "../../data/forum.sqlite");
  const output = process.argv[3] ?? path.join(here, "../../data/import.sql");
  if (!fs.existsSync(input)) {
    console.error(`No export at ${input}. Run the Tender export first (npm run export in the repo root).`);
    process.exit(1);
  }
  const db = new DatabaseSync(input, { readOnly: true });
  const { statements, stats } = convert(db);
  fs.writeFileSync(output, statements.join("\n") + "\n");
  console.log(`Wrote ${statements.length} statements to ${output}`);
  console.table(stats);
}
