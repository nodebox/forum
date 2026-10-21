// Point links to the old forum (support.nodebox.net, nodebox.tenderapp.com) inside posts
// that are already in the forum straight at their new place. The first import ran
// before the importer rewrote links, so those posts still rely on the old domain
// redirecting.
//
//   npm run rewrite:links -- --remote   # reads production D1; writes ../data/rewrite-links.sql and ../data/rewrite-links.md
//   npm run rewrite:links -- --local    # the same against the local database
//
// Nothing is written to the database. Read the report, then apply the SQL with
// `npx wrangler d1 execute nodebox-forum --remote --file ../data/rewrite-links.sql`.
// Each UPDATE only applies while the post's body is still what was read, so a post
// edited in between is left alone. Links are resolved exactly as the Worker resolves
// them (src/legacy.ts); a link it can't place is left as it is and listed.
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isLegacyHost, resolveLegacyPath } from "../src/legacy.ts";
import { attachmentId, sql } from "./import-tender.ts";

export interface LinkSnapshot {
  /** Posts that may hold old links. */
  posts: { id: number; topic_id: number; tender_number: number | null; body: string }[];
  /** Every post's place in its Tender discussion, to find which comment an old attachment hung on. */
  numbers: { topic_id: number; tender_number: number }[];
  redirects: { path: string; topic_id: number }[];
  topics: { id: number; slug: string }[];
  categories: { slug: string }[];
  attachments: { id: string; filename: string }[];
}

export interface LinkChange {
  postId: number;
  topicId: number;
  from: string;
  /** null: left as it is, nothing on the forum to point at. */
  to: string | null;
}

const LEGACY_HOSTS = ["support.nodebox.net"];
const LINK = /https?:\/\/[^\s)"'<>\]]+|(?<![\w/.-])\/discussions\/[^\s)"'<>\]]+/g;

/** The link behind Tender's r?go= redirector: plain or base64-encoded, and only when it is a whole http(s) URL. */
export function outboundTarget(go: string | null): string | null {
  if (!go) return null;
  const isUrl = (s: string) => /^https?:\/\/[^\s]+$/i.test(s) && URL.canParse(s);
  if (isUrl(go)) return go;
  try {
    const decoded = Buffer.from(go.replace(/ /g, "+").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return isUrl(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/** A D1Database over an in-memory SQLite copy, enough for resolveLegacyPath. */
function memoryD1(snap: LinkSnapshot): D1Database {
  const mem = new DatabaseSync(":memory:");
  mem.exec(`CREATE TABLE legacy_redirects (path TEXT PRIMARY KEY, topic_id INTEGER);
    CREATE TABLE topics (id INTEGER PRIMARY KEY, slug TEXT);
    CREATE TABLE categories (slug TEXT PRIMARY KEY);`);
  const ins = (table: string, cols: string[], rows: any[]) => {
    const st = mem.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
    for (const r of rows) st.run(...cols.map((c) => r[c]));
  };
  ins("legacy_redirects", ["path", "topic_id"], snap.redirects);
  ins("topics", ["id", "slug"], snap.topics);
  ins("categories", ["slug"], snap.categories);
  return {
    prepare(query: string) {
      const st = mem.prepare(query);
      return { bind: (...args: unknown[]) => ({ first: async () => (st.get(...(args as any[])) as unknown) ?? null }) };
    },
  } as unknown as D1Database;
}

export async function planRewrite(
  snap: LinkSnapshot,
  forumUrl = "https://forum.nodebox.net",
): Promise<{ updates: { id: number; old: string; body: string }[]; changes: LinkChange[] }> {
  const db = memoryD1(snap);
  const attachments = new Map(snap.attachments.map((a) => [a.id, a.filename]));
  const numbersByTopic = new Map<number, number[]>();
  for (const n of snap.numbers) numbersByTopic.set(n.topic_id, [...(numbersByTopic.get(n.topic_id) ?? []), n.tender_number]);
  const topicOf = async (p: string) => Number(/^\/t\/(\d+)\//.exec((await resolveLegacyPath(db, p)) ?? "")?.[1] ?? NaN);

  /** Where an old URL goes now: a forum path, an outside URL, or null. */
  async function target(u: URL, topicId: number): Promise<string | null> {
    const p = u.pathname;
    // Tender's outbound-link redirector: the link it stood for.
    const go = /\/r\/?$/.test(p) ? outboundTarget(u.searchParams.get("go")) : null;
    if (go) return go;
    // An attachment: the file it became, found through the comment it hung on.
    const assets = p.indexOf("/assets/");
    if (assets >= 0) {
      const downloadPath = p.slice(assets);
      const prefix = p.slice(0, assets);
      for (const t of [topicId, prefix ? await topicOf(prefix) : NaN]) {
        for (const n of numbersByTopic.get(t) ?? []) {
          const id = attachmentId(t, n, downloadPath);
          const filename = attachments.get(id);
          if (filename !== undefined) return `/files/${id}/${encodeURIComponent(filename)}`;
        }
      }
      return null;
    }
    const resolved = await resolveLegacyPath(db, p);
    // The front page stands in for a discussion or category that didn't come over: keep the old link, it says more.
    if (!resolved || (resolved === "/" && !/^\/(discussions\/?)?$/.test(p))) return null;
    return resolved;
  }

  const updates: { id: number; old: string; body: string }[] = [];
  const changes: LinkChange[] = [];
  for (const post of snap.posts) {
    const found: { start: number; end: number; text: string }[] = [];
    for (const m of post.body.matchAll(LINK)) {
      const url = m[0].replace(/[.,;:!?*_]+$/, "");
      found.push({ start: m.index!, end: m.index! + url.length, text: url });
    }
    let body = "";
    let at = 0;
    for (const f of found) {
      let u: URL;
      try {
        u = new URL(f.text, "https://support.nodebox.net");
      } catch {
        continue;
      }
      const absolute = /^https?:/i.test(f.text);
      if (absolute && !isLegacyHost(u.hostname, LEGACY_HOSTS)) continue;
      const to = await target(u, post.topic_id);
      if (to === null) {
        changes.push({ postId: post.id, topicId: post.topic_id, from: f.text, to: null });
        continue;
      }
      // A bare URL was a link only because it was absolute, so it stays absolute; a Markdown link target can be a path.
      const inTarget = post.body.slice(Math.max(0, f.start - 2), f.start) === "](";
      const replacement = to.startsWith("/") && absolute && !inTarget ? forumUrl + to : to;
      body += post.body.slice(at, f.start) + replacement;
      at = f.end;
      changes.push({ postId: post.id, topicId: post.topic_id, from: f.text, to: replacement });
    }
    body += post.body.slice(at);
    if (body !== post.body) updates.push({ id: post.id, old: post.body, body });
  }
  return { updates, changes };
}

export function updateStatements(updates: { id: number; old: string; body: string }[]): string[] {
  return updates.map((u) => `UPDATE posts SET body = ${sql(u.body)} WHERE id = ${u.id} AND body = ${sql(u.old)};`);
}

export function report(changes: LinkChange[], updates: number, forumUrl: string): string {
  const done = changes.filter((c) => c.to !== null);
  const left = changes.filter((c) => c.to === null);
  const row = (c: LinkChange) => `| [${c.postId}](${forumUrl}/p/${c.postId}) | ${c.from} | ${c.to ?? "left as it is"} |`;
  return [
    `# Old links in posts`,
    ``,
    `${updates} posts change; ${done.length} links point somewhere new, ${left.length} stay as they are.`,
    ``,
    `## Rewritten`,
    ``,
    `| Post | Old link | New link |`,
    `| --- | --- | --- |`,
    ...done.map(row),
    ``,
    `## Left as they are`,
    ``,
    `Nothing on the forum to point at (deleted or private on Tender). They keep going through the old domain's redirect.`,
    ``,
    `| Post | Old link | |`,
    `| --- | --- | --- |`,
    ...left.map(row),
    ``,
  ].join("\n");
}

function readSnapshot(where: "--remote" | "--local", cwd: string): LinkSnapshot {
  const query = <T>(q: string): T[] => {
    const out = execFileSync("npx", ["wrangler", "d1", "execute", "nodebox-forum", where, "--json", "--command", q], {
      cwd,
      encoding: "utf8",
      maxBuffer: 1 << 30,
      stdio: ["ignore", "pipe", "inherit"],
    });
    return (JSON.parse(out) as { results: T[] }[])[0]!.results;
  };
  return {
    posts: query(
      `SELECT id, topic_id, tender_number, body FROM posts
       WHERE body LIKE '%support.nodebox.net%' OR body LIKE '%tenderapp.com%' OR body LIKE '%/discussions/%'`,
    ),
    numbers: query("SELECT topic_id, tender_number FROM posts WHERE tender_number IS NOT NULL"),
    redirects: query("SELECT path, topic_id FROM legacy_redirects"),
    topics: query("SELECT id, slug FROM topics"),
    categories: query("SELECT slug FROM categories"),
    attachments: query("SELECT id, filename FROM attachments"),
  };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const where = process.argv.includes("--local") ? "--local" : process.argv.includes("--remote") ? "--remote" : null;
  if (!where) {
    console.error("Say which database: --remote (production) or --local.");
    process.exit(1);
  }
  const forumUrl = (process.env.FORUM_URL ?? "https://forum.nodebox.net").replace(/\/$/, "");
  const snap = readSnapshot(where, path.join(here, ".."));
  const { updates, changes } = await planRewrite(snap, forumUrl);
  const dataDir = path.join(here, "../../data");
  fs.writeFileSync(path.join(dataDir, "rewrite-links.sql"), updateStatements(updates).join("\n") + "\n");
  fs.writeFileSync(path.join(dataDir, "rewrite-links.md"), report(changes, updates.length, forumUrl));
  console.log(`${snap.posts.length} posts checked, ${updates.length} change.`);
  console.log(`${changes.filter((c) => c.to).length} links rewritten, ${changes.filter((c) => !c.to).length} left as they are.`);
  console.log(`Wrote ${path.join(dataDir, "rewrite-links.sql")} and rewrite-links.md`);
}
