import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Config } from "./config.ts";
import { HttpError, TenderClient, idFromHref } from "./client.ts";
import { type DB, clearState, getState, now, setState, tx, upsert } from "./db.ts";

export interface Ctx {
  config: Config;
  client: TenderClient;
  db: DB;
  refresh: boolean;
}

const log = (...args: unknown[]) => console.log(...args);

/**
 * Walk every page of a list endpoint, calling `onItems` per page.
 * Progress is stored per list so an interrupted run resumes where it stopped.
 */
async function walkList(ctx: Ctx, listPath: string, onItems: (items: any[]) => void) {
  const stateKey = `list:${listPath}`;
  const saved = getState(ctx.db, stateKey);
  if (saved === "done" && !ctx.refresh) {
    log(`  ${listPath}: already complete, skipping (use --refresh to re-walk)`);
    return;
  }
  let page = saved && saved !== "done" && !ctx.refresh ? Number(saved) + 1 : 1;
  let seen = 0;
  for (;;) {
    const res = await ctx.client.page(listPath, page);
    if (res.items.length === 0) break;
    tx(ctx.db, () => {
      onItems(res.items);
      setState(ctx.db, stateKey, String(page));
    });
    seen += res.items.length;
    const total = res.total !== undefined ? `/${res.total}` : "";
    log(`  ${listPath} page ${page}: ${res.items.length} items (${(res.offset ?? seen - res.items.length) + res.items.length}${total})`);
    const perPage = res.perPage ?? 30;
    if (res.items.length < perPage) break;
    if (res.total !== undefined && res.offset !== undefined && res.offset + res.items.length >= res.total) break;
    page++;
  }
  setState(ctx.db, stateKey, "done");
}

// ---------------------------------------------------------------------------

export async function ping(ctx: Ctx) {
  const profile = await ctx.client.get("/profile");
  const site = await ctx.client.get("");
  log(`Authenticated as ${profile.name} <${profile.email}> on site "${site.name ?? ctx.config.site}".`);
}

export async function categories(ctx: Ctx) {
  log("Categories");
  // Always re-walk: it is a handful of requests and the discussion step depends on it.
  clearState(ctx.db, "list:/categories");
  await walkList(ctx, "/categories", (items) => {
    for (const c of items) {
      const id = idFromHref(c.href);
      if (id === null) throw new Error(`category without id: ${JSON.stringify(c).slice(0, 200)}`);
      upsert(ctx.db, "categories", ["id"], {
        id,
        name: c.name,
        permalink: c.permalink,
        summary: c.summary,
        public: c.public,
        html_href: c.html_href,
        created_at: c.created_at,
        updated_at: c.updated_at,
        raw: c,
        fetched_at: now(),
      });
    }
  });
}

function upsertDiscussion(ctx: Ctx, d: any, categoryId: number | null, listState: string) {
  const id = idFromHref(d.href);
  if (id === null) throw new Error(`discussion without id: ${JSON.stringify(d).slice(0, 200)}`);
  const existing = ctx.db
    .prepare("SELECT json_extract(raw, '$.updated_at') AS updated_at, detail_fetched_at FROM discussions WHERE id = ?")
    .get(id) as { updated_at: string | null; detail_fetched_at: string | null } | undefined;
  const state = listState === "deleted" ? "deleted" : (d.state ?? listState);
  upsert(ctx.db, "discussions", ["id"], {
    id,
    category_id: categoryId ?? idFromHref(d.category_href),
    number: d.number,
    title: d.title,
    permalink: d.permalink,
    state,
    public: d.public,
    author_name: d.author_name,
    author_email: d.author_email,
    user_id: idFromHref(d.user_href),
    comments_count: d.comments_count,
    html_href: d.html_href,
    created_at: d.created_at,
    updated_at: d.updated_at,
    last_updated_at: d.last_updated_at,
    raw: d,
    fetched_at: now(),
  });
  // Changed since we fetched its comments: queue it for a fresh detail fetch.
  if (existing?.detail_fetched_at && existing.updated_at !== (d.updated_at ?? null)) {
    ctx.db.prepare("UPDATE discussions SET detail_fetched_at = NULL WHERE id = ?").run(id);
  }
}

export async function discussions(ctx: Ctx) {
  log("Discussions");
  const cats = ctx.db.prepare("SELECT id, name FROM categories ORDER BY id").all() as { id: number; name: string }[];
  if (cats.length === 0) throw new Error("No categories in the database; run the `categories` step first.");
  const states = ["open", "assigned", "resolved"];
  if (ctx.config.includeDeleted) states.push("spam", "deleted");
  for (const cat of cats) {
    log(` ${cat.name} (#${cat.id})`);
    for (const state of states) {
      try {
        await walkList(ctx, `/categories/${cat.id}/discussions/${state}`, (items) => {
          for (const d of items) upsertDiscussion(ctx, d, cat.id, state);
        });
      } catch (err) {
        // A state filter the site doesn't support shouldn't stop the export.
        if (err instanceof HttpError && (err.status === 404 || err.status === 422)) {
          log(`  ${state}: ${err.status}, skipping`);
          continue;
        }
        throw err;
      }
    }
  }
  // Safety net: the unfiltered list catches anything the per-state lists missed.
  await walkList(ctx, "/discussions", (items) => {
    for (const d of items) upsertDiscussion(ctx, d, null, d.state ?? "open");
  });
  const { n } = ctx.db.prepare("SELECT count(*) AS n FROM discussions").get() as { n: number };
  log(` ${n} discussions in the database.`);
}

function saveComment(ctx: Ctx, discussionId: number, c: any) {
  upsert(ctx.db, "comments", ["discussion_id", "number"], {
    discussion_id: discussionId,
    number: c.number,
    user_id: c.user_id ?? idFromHref(c.user_href),
    author_name: c.author_name,
    author_email: c.author_email,
    body: c.body,
    formatted_body: c.formatted_body,
    internal: c.internal,
    system_message: c.system_message,
    resolution: c.resolution,
    user_is_supporter: c.user_is_supporter,
    via: c.via,
    created_at: c.created_at,
    raw: c,
  });
  for (const a of c.assets ?? []) {
    if (!a.download_path) continue;
    upsert(ctx.db, "attachments", ["discussion_id", "comment_number", "download_path"], {
      discussion_id: discussionId,
      comment_number: c.number,
      // The URL carries a signature that changes on every fetch; the path identifies the file.
      download_path: new URL(a.download_path, "https://x").pathname,
      download_url: a.download_path,
      filename: a.filename,
      content_type: a.content_type,
      size: a.size,
      width: a.width,
      height: a.height,
      created_at: a.created_at,
      raw: a,
    });
  }
}

export async function details(ctx: Ctx) {
  log("Discussion details and comments");
  let sql = "SELECT id, title FROM discussions WHERE detail_fetched_at IS NULL AND state != 'deleted' ORDER BY id";
  if (ctx.config.limit) sql += ` LIMIT ${ctx.config.limit}`;
  const todo = ctx.db.prepare(sql).all() as { id: number; title: string }[];
  log(` ${todo.length} discussions to fetch.`);
  let i = 0;
  for (const { id, title } of todo) {
    i++;
    try {
      const comments: any[] = [];
      let detail: any;
      for (let page = 1; ; page++) {
        const d = await ctx.client.get(`/discussions/${id}`, page > 1 ? { page } : {});
        if (page === 1) detail = d;
        const batch: any[] = d.comments ?? [];
        comments.push(...batch);
        if (batch.length < 30) break;
      }
      const { comments: _omit, ...detailWithoutComments } = detail;
      tx(ctx.db, () => {
        for (const c of comments) saveComment(ctx, id, c);
        ctx.db
          .prepare("UPDATE discussions SET detail_raw = ?, detail_fetched_at = ?, detail_error = NULL WHERE id = ?")
          .run(JSON.stringify(detailWithoutComments), now(), id);
      });
      log(` [${i}/${todo.length}] #${id} ${title} (${comments.length} comments)`);
    } catch (err) {
      if (err instanceof HttpError && err.status < 500 && err.status !== 429) {
        ctx.db
          .prepare("UPDATE discussions SET detail_error = ?, detail_fetched_at = ? WHERE id = ?")
          .run(err.message, now(), id);
        log(` [${i}/${todo.length}] #${id} failed: ${err.message}`);
        continue;
      }
      throw err;
    }
  }
}

function saveUser(ctx: Ctx, id: number, u: any) {
  upsert(ctx.db, "users", ["id"], {
    id,
    name: u.name,
    email: u.email,
    title: u.title,
    state: u.state,
    is_supporter: u.state === "support" ? 1 : null,
    comments_count: u.comments_count,
    discussions_count: u.discussions_count,
    created_at: u.created_at,
    updated_at: u.updated_at,
    raw: u,
    fetch_error: null,
    fetched_at: now(),
  });
}

export async function users(ctx: Ctx) {
  log("Users");
  try {
    await walkList(ctx, "/users", (items) => {
      for (const u of items) {
        const id = idFromHref(u.href);
        if (id !== null) saveUser(ctx, id, u);
      }
    });
  } catch (err) {
    if (!(err instanceof HttpError && err.status < 500)) throw err;
    log(`  user list not available (${err.status}); fetching authors one by one instead.`);
  }
  // Authors we saw on discussions/comments but did not get from the list.
  const missing = ctx.db
    .prepare(
      `SELECT id FROM (
         SELECT user_id AS id FROM discussions WHERE user_id IS NOT NULL
         UNION SELECT user_id FROM comments WHERE user_id IS NOT NULL
       ) WHERE id NOT IN (SELECT id FROM users WHERE raw IS NOT NULL OR fetch_error IS NOT NULL)`,
    )
    .all() as { id: number }[];
  log(` ${missing.length} authors to fetch individually.`);
  for (const { id } of missing) {
    try {
      saveUser(ctx, id, await ctx.client.get(`/users/${id}`));
    } catch (err) {
      if (!(err instanceof HttpError && err.status < 500)) throw err;
      upsert(ctx.db, "users", ["id"], { id, fetch_error: err.message, fetched_at: now() });
    }
  }
}

export async function kb(ctx: Ctx) {
  log("Knowledge base");
  try {
    await walkList(ctx, "/sections", (items) => {
      for (const s of items) {
        const id = idFromHref(s.href);
        if (id === null) continue;
        upsert(ctx.db, "kb_sections", ["id"], { id, title: s.title ?? s.name, permalink: s.permalink, raw: s, fetched_at: now() });
      }
    });
    await walkList(ctx, "/faqs", (items) => {
      for (const a of items) {
        const id = idFromHref(a.href);
        if (id === null) continue;
        upsert(ctx.db, "kb_articles", ["id"], {
          id,
          section_id: idFromHref(a.section_href),
          title: a.title,
          permalink: a.permalink,
          body: a.body,
          formatted_body: a.formatted_body,
          keywords: a.keywords,
          published_at: a.published_at,
          html_href: a.html_href,
          created_at: a.created_at,
          updated_at: a.updated_at,
          raw: a,
          fetched_at: now(),
        });
      }
    });
  } catch (err) {
    if (!(err instanceof HttpError && err.status < 500)) throw err;
    log(`  knowledge base not available (${err.status}), skipping.`);
  }
}

/** Local path for an attachment, mirroring its Tender download path (also the future R2 key). */
export function attachmentLocalPath(downloadPath: string): string {
  const clean = new URL(downloadPath, "https://x").pathname
    .split("/")
    .filter(Boolean)
    .map((seg) => {
      let s = seg;
      try { s = decodeURIComponent(seg); } catch {}
      return s.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+$/, "_");
    });
  return clean.join("/");
}

export async function attachments(ctx: Ctx) {
  log("Attachments");
  const todo = ctx.db
    .prepare("SELECT download_path, max(download_url) AS download_url FROM attachments WHERE downloaded_at IS NULL GROUP BY download_path ORDER BY download_path")
    .all() as { download_path: string; download_url: string }[];
  log(` ${todo.length} files to download.`);
  let i = 0;
  for (const { download_path, download_url } of todo) {
    i++;
    const rel = attachmentLocalPath(download_path);
    const dest = path.join(ctx.config.attachmentsDir, rel);
    const url = /^https?:/.test(download_url) ? download_url : ctx.config.assetBase + download_url;
    try {
      const res = await ctx.client.raw(url, { accept: "*/*" });
      if (!res.ok || !res.body) throw new HttpError(res.status, url, await res.text());
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = dest + ".part";
      const hash = crypto.createHash("sha256");
      let size = 0;
      const body = Readable.fromWeb(res.body as any);
      body.on("data", (chunk: Buffer) => { hash.update(chunk); size += chunk.length; });
      await pipeline(body, fs.createWriteStream(tmp));
      fs.renameSync(tmp, dest);
      ctx.db
        .prepare("UPDATE attachments SET local_path = ?, sha256 = ?, downloaded_size = ?, download_error = NULL, downloaded_at = ? WHERE download_path = ?")
        .run(rel, hash.digest("hex"), size, now(), download_path);
      log(` [${i}/${todo.length}] ${rel} (${size} bytes)`);
    } catch (err) {
      if (!(err instanceof HttpError) || err.status >= 500) throw err;
      // Mark as attempted so the run moves on; `--retry-failed` clears these.
      ctx.db
        .prepare("UPDATE attachments SET download_error = ?, downloaded_at = ? WHERE download_path = ?")
        .run(err.message, now(), download_path);
      log(` [${i}/${todo.length}] ${rel} failed: ${err.message}`);
    }
  }
}

export function retryFailed(ctx: Ctx) {
  const a = ctx.db.prepare("UPDATE attachments SET downloaded_at = NULL WHERE download_error IS NOT NULL").run();
  const d = ctx.db.prepare("UPDATE discussions SET detail_fetched_at = NULL WHERE detail_error IS NOT NULL").run();
  const u = ctx.db.prepare("UPDATE users SET fetch_error = NULL WHERE fetch_error IS NOT NULL AND raw IS NULL").run();
  log(`Re-queued ${d.changes} discussions, ${a.changes} attachments, ${u.changes} users.`);
}

export function stats(ctx: Ctx) {
  const q = (sql: string) => (ctx.db.prepare(sql).get() as { n: number }).n;
  log("\nDatabase:", ctx.config.dbPath);
  log(`  categories     ${q("SELECT count(*) n FROM categories")}`);
  log(`  discussions    ${q("SELECT count(*) n FROM discussions")}  (comments fetched: ${q("SELECT count(*) n FROM discussions WHERE detail_fetched_at IS NOT NULL AND detail_error IS NULL")}, failed: ${q("SELECT count(*) n FROM discussions WHERE detail_error IS NOT NULL")})`);
  log(`  comments       ${q("SELECT count(*) n FROM comments")}  (internal notes: ${q("SELECT count(*) n FROM comments WHERE internal = 1")})`);
  log(`  users          ${q("SELECT count(*) n FROM users WHERE raw IS NOT NULL")}  (failed: ${q("SELECT count(*) n FROM users WHERE fetch_error IS NOT NULL")})`);
  log(`  attachments    ${q("SELECT count(*) n FROM attachments")}  (downloaded: ${q("SELECT count(*) n FROM attachments WHERE local_path IS NOT NULL")}, failed: ${q("SELECT count(*) n FROM attachments WHERE download_error IS NOT NULL")})`);
  log(`  kb articles    ${q("SELECT count(*) n FROM kb_articles")}`);
  // Compare with the counts Tender reports per category, to spot gaps.
  const rows = ctx.db
    .prepare(
      `SELECT c.name,
              coalesce(json_extract(c.raw, '$.open_discussions_count'), 0)
            + coalesce(json_extract(c.raw, '$.assigned_discussions_count'), 0)
            + coalesce(json_extract(c.raw, '$.resolved_discussions_count'), 0) AS expected,
              (SELECT count(*) FROM discussions d WHERE d.category_id = c.id AND d.state IN ('open','assigned','resolved')) AS got
       FROM categories c ORDER BY c.name`,
    )
    .all() as { name: string; expected: number; got: number }[];
  const off = rows.filter((r) => r.expected && r.expected !== r.got);
  if (off.length) {
    log("  categories where Tender's count differs from ours:");
    for (const r of off) log(`    ${r.name}: Tender says ${r.expected}, we have ${r.got}`);
  }
}
