// Old Tender URLs and where they live now. Used by the Worker (redirects) and by
// the importer (links inside post bodies).
//
// Tender's discussion URLs are /discussions/<category>/<number>-<slug>. The category
// and the slug changed when a discussion was moved or renamed; the number did not.
import { slugify } from "./util.ts";

/**
 * Hosts the old forum answered on: nodebox.tenderapp.com, plus custom domains such as
 * support.nodebox.net. tenderapp.com itself and help.tenderapp.com are Tender's own site.
 */
export function isLegacyHost(host: string, extra: Iterable<string> = []): boolean {
  const h = host.toLowerCase();
  if (h === "nodebox.tenderapp.com") return true;
  for (const e of extra) if (e.trim().toLowerCase() === h) return true;
  return false;
}

export function parseHosts(list: string | undefined): string[] {
  return (list ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
}

/** The discussion number in a Tender discussion path (/discussions/<category>/<number>-<slug>), or null. */
export function tenderDiscussionNumber(path: string): number | null {
  const m = /^\/discussions\/(?:[^/]+\/)?(\d+)(?:-[^/]*)?\/?$/.exec(path);
  return m ? Number(m[1]) : null;
}

/** The category permalink in a Tender category path (/discussions/<category>), or null. */
export function tenderCategoryPermalink(path: string): string | null {
  const m = /^\/discussions\/([^/]+)\/?$/.exec(path);
  return m && !/^\d+(-|$)/.test(m[1]!) ? decodeURIComponent(m[1]!).toLowerCase() : null;
}

/**
 * Where an old Tender path lives on the forum, or null when it has no counterpart
 * (knowledge-base articles, private or deleted discussions, user pages).
 */
export async function resolveLegacyPath(db: D1Database, rawPath: string): Promise<string | null> {
  // Paths below a discussion (its attachments, Tender's r?go= link redirector) stand for the discussion.
  const path = rawPath.replace(/^(\/discussions\/[^/]+\/\d[^/]*)\/.*/, "$1").replace(/\/+$/, "") || "/";
  if (path === "/" || path === "/discussions") return "/";
  const number = tenderDiscussionNumber(path);
  if (number !== null) {
    // The exact old URL first; otherwise the same discussion number under another category or slug.
    // Tender numbered per category, so a number in the old URL's own category wins over the same number elsewhere.
    const category = /^\/discussions\/([^/]+)\/\d/.exec(path)?.[1] ?? "";
    const topic = await db
      .prepare(
        `SELECT t.id, t.slug, r.path = ?1 OR substr(r.path, 1, length(?3)) = ?3 AS own FROM legacy_redirects r JOIN topics t ON t.id = r.topic_id
         WHERE r.path = ?1 OR r.path GLOB '/discussions/*/' || ?2 || '-*' OR r.path GLOB '/discussions/*/' || ?2
         ORDER BY r.path = ?1 DESC, own DESC LIMIT 1`,
      )
      .bind(path, String(number), `/discussions/${category}/`)
      .first<{ id: number; slug: string; own: number }>();
    if (topic?.own) return `/t/${topic.id}/${topic.slug}`;
    // Another category's number only when the old URL's category came over; a dropped one (private Support) goes to the front page.
    if (category && !(await db.prepare("SELECT 1 FROM categories WHERE slug = ?").bind(slugify(category, 40)).first())) return "/";
    return topic ? `/t/${topic.id}/${topic.slug}` : null;
  }
  const permalink = tenderCategoryPermalink(path);
  if (permalink) {
    const category = await db.prepare("SELECT slug FROM categories WHERE slug = ?").bind(slugify(permalink, 40)).first<{ slug: string }>();
    // A category that didn't come over, such as the private Support one: the front page.
    return category ? `/c/${category.slug}` : "/";
  }
  return null;
}

/**
 * Where to send an old path that has no counterpart: a search for the title words
 * in a discussion or knowledge-base URL, otherwise the front page.
 */
export function legacyFallback(rawPath: string): string {
  const slug =
    /^\/discussions\/(?:[^/]+\/)?\d+-([^/]+)/.exec(rawPath)?.[1] ?? /^\/kb\/(?:[^/]+\/)*([^/]+?)\/?$/.exec(rawPath)?.[1] ?? "";
  let words = slug;
  try {
    words = decodeURIComponent(slug);
  } catch {}
  words = words.replace(/[-_+]+/g, " ").trim();
  return words ? `/search?q=${encodeURIComponent(words)}` : "/";
}
