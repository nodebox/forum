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
// What comes over: public categories; open/assigned/resolved public discussions;
// comments that aren't internal notes or system messages; the users who wrote at least one visible post (deduplicated on
// email); attachment metadata (files are uploaded separately); old URLs for
// redirects. Links in bodies to old attachments, discussions and category pages
// point at their new place.
// Items the spam filter flagged (the `spam_excluded` view, if present) are
// imported with status 'spam': hidden, but admins can restore them.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isLegacyHost, tenderCategoryPermalink, tenderDiscussionNumber } from "../src/legacy.ts";

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

/** Where bare links to old discussions point after the import. FORUM_URL overrides it. */
const DEFAULT_FORUM_URL = "https://forum.nodebox.net";
/** The old forum's custom domain; *.tenderapp.com and the hosts in the export's own URLs count too. */
const LEGACY_HOSTS = ["support.nodebox.net"];
/** Candidates for old links in a body: absolute URLs, and paths to old attachments and discussions. */
const OLD_LINK = /https?:\/\/[^\s)"'<>\]]+|(?<![\w/.-])\/(?:assets|discussions)\/[^\s)"'<>\]]+/g;
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

/**
 * Stable attachment id, so re-running the import (and the uploader) agree.
 * An attachment belongs to one post: a file that hung on two Tender comments
 * gets two ids, and so two stored copies.
 */
export function attachmentId(discussionId: number, commentNumber: number, downloadPath: string): string {
  return createHash("sha256").update(`${discussionId}/${commentNumber}${downloadPath}`).digest("base64url").slice(0, 16);
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

export function convert(src: DatabaseSync, imagesPrefix = "nodebox-forum-", forumUrl = DEFAULT_FORUM_URL): { statements: string[]; stats: ImportStats } {
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
  const categoryPathByPermalink = new Map<string, string>();
  categories.forEach((c, i) => {
    if (!isPublic(c.public)) return;
    let slug = slugify(c.permalink || c.name, 40);
    while (usedSlugs.has(slug)) slug += "-x";
    usedSlugs.add(slug);
    catIds.add(c.id);
    categoryPathByPermalink.set(slugify(c.permalink || c.name, 40), `/c/${slug}`);
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

  // Old URLs -> new topic paths, for rewriting links inside bodies. Keyed by the
  // discussion number too, since old links may carry an earlier category or slug.
  const topicPathByOldUrl = new Map<string, string>();
  const topicPathByNumber = new Map<number, string>();
  const legacyHosts = new Set(LEGACY_HOSTS);
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
    if (d.html_href) {
      const old = new URL(d.html_href);
      const p = old.pathname.replace(/\/$/, "");
      topicPathByOldUrl.set(p, `/t/${d.id}/${slug}`);
      const n = tenderDiscussionNumber(p);
      if (n !== null) topicPathByNumber.set(n, `/t/${d.id}/${slug}`);
      legacyHosts.add(old.hostname.toLowerCase());
    }
  }

  const categoryCounts = new Map<number, number>();
  const visibleAuthors = new Set<number>();
  const built: {
    d: any;
    slug: string;
    topicStatus: string;
    postRows: Record<string, unknown>[];
    files: any[];
    postIdByNumber: Map<number, number>;
    visible: number;
    last: { at: string; user: number } | null;
  }[] = [];
  let postId = 0;
  for (const { d, comments, slug } of kept) {
    const files = attachmentsStmt.all(d.id) as any[];
    const fileUrlByPath = new Map<string, string>();
    for (const f of files) fileUrlByPath.set(f.download_path, `/files/${attachmentId(d.id, f.comment_number, f.download_path)}/${encodeURIComponent(f.filename ?? "file")}`);

    const rewrite = (text: string) =>
      text.replace(OLD_LINK, (match: string, offset: number) => {
        // A sentence's full stop or a Markdown emphasis mark after a bare URL is not part of it.
        const url = match.replace(/[.,;:!?*_]+$/, "");
        const tail = match.slice(url.length);
        let u: URL;
        try {
          u = new URL(url, "https://legacy.invalid");
        } catch {
          return match;
        }
        const absolute = /^https?:/i.test(url);
        const p = u.pathname.replace(/\/$/, "");
        let found: string | undefined;
        for (const [dp, fu] of fileUrlByPath) if (u.pathname === new URL(dp, "https://x").pathname) found = fu;
        if (!found && (!absolute || isLegacyHost(u.hostname, legacyHosts))) {
          const n = tenderDiscussionNumber(p);
          found = topicPathByOldUrl.get(p) ?? (n !== null ? topicPathByNumber.get(n) : undefined);
          // Category pages and the front page, only for links that name the old forum's host.
          if (!found && absolute) {
            const permalink = tenderCategoryPermalink(p);
            if (permalink) found = categoryPathByPermalink.get(slugify(permalink, 40));
            else if (p === "" || p === "/discussions") found = "/";
          }
        }
        if (!found) return match;
        // A bare URL was a link only because it was absolute, so it stays absolute; a Markdown link target can be a path.
        const inTarget = text.slice(Math.max(0, offset - 2), offset) === "](";
        return (absolute && !inTarget ? forumUrl + found : found) + tail;
      });

    const topicSpam = spamDiscussions.get(d.id) ?? (spamComments.has(`${d.id}:${comments[0].number}`) ? spamComments.get(`${d.id}:${comments[0].number}`)! : null);
    const topicStatus = topicSpam ? "spam" : "visible";
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
        visibleAuthors.add(userId);
      }
    }
    built.push({ d, slug, topicStatus, postRows, files, postIdByNumber, visible, last });
  }

  // Only people with a visible post come over. What such a person leaves behind
  // is hidden spam, and it stays in the export: those posts are dropped, and a
  // topic with no post left is dropped with them.
  for (const { d, slug, topicStatus, postRows: allPosts, files, postIdByNumber, visible, last } of built) {
    const postRows = allPosts.filter((r) => visibleAuthors.has(r.user_id as number));
    if (postRows.length === 0) {
      stats.skippedDiscussions++;
      continue;
    }
    const keptPostIds = new Set(postRows.map((r) => r.id));
    // The topic's author is whoever wrote its first post.
    const authorId = postRows[0]!.user_id as number;
    stats.spamPosts += postRows.filter((r) => r.status !== "visible").length;
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
        status: topicStatus,
        tender_id: d.id,
      }),
    );
    for (const row of postRows) out.push(insert("posts", row));
    for (const f of files) {
      const pid = postIdByNumber.get(f.comment_number);
      if (pid === undefined || !keptPostIds.has(pid)) continue; // attachment on an internal note or a dropped post
      const id = attachmentId(d.id, f.comment_number, f.download_path);
      const type = f.content_type || "application/octet-stream";
      out.push(
        insert("attachments", {
          id,
          user_id: postRows.find((r) => r.id === pid)!.user_id,
          post_id: pid,
          r2_key: `posts/${pid}/${id}/${attachmentLocalPath(f.download_path).split("/").pop()}`,
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
  const userStatements = [...users.values()]
    .filter((u) => visibleAuthors.has(u.id))
    .map((u) => insert("users", { id: u.id, email: u.email, name: u.name, created_at: u.created_at, tender_id: u.tender_id }));
  stats.users = userStatements.length;
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
  const { statements, stats } = convert(db, undefined, (process.env.FORUM_URL ?? DEFAULT_FORUM_URL).replace(/\/$/, ""));
  fs.writeFileSync(output, statements.join("\n") + "\n");
  console.log(`Wrote ${statements.length} statements to ${output}`);
  console.table(stats);
}
