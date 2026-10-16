// Old Tender URLs and where they live now. Used by the Worker (redirects) and by
// the importer (links inside post bodies).
//
// Tender's discussion URLs are /discussions/<category>/<number>-<slug>. The category
// and the slug changed when a discussion was moved or renamed; the number did not.
import { slugify } from "./util.ts";

/** Hosts the old forum answered on. LEGACY_HOSTS (comma-separated) adds custom domains such as support.nodebox.net. */
export function isLegacyHost(host: string, extra: Iterable<string> = []): boolean {
  const h = host.toLowerCase();
  if (h === "tenderapp.com" || h.endsWith(".tenderapp.com")) return true;
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
  const path = rawPath.replace(/\/+$/, "") || "/";
  if (path === "/" || path === "/discussions") return "/";
  const number = tenderDiscussionNumber(path);
  if (number !== null) {
    // The exact old URL first; otherwise the same discussion number under another category or slug.
    const topic = await db
      .prepare(
        `SELECT t.id, t.slug FROM legacy_redirects r JOIN topics t ON t.id = r.topic_id
         WHERE r.path = ?1 OR r.path GLOB '/discussions/*/' || ?2 || '-*' OR r.path GLOB '/discussions/*/' || ?2
         ORDER BY r.path = ?1 DESC LIMIT 1`,
      )
      .bind(path, String(number))
      .first<{ id: number; slug: string }>();
    return topic ? `/t/${topic.id}/${topic.slug}` : null;
  }
  const permalink = tenderCategoryPermalink(path);
  if (permalink) {
    const category = await db.prepare("SELECT slug FROM categories WHERE slug = ?").bind(slugify(permalink, 40)).first<{ slug: string }>();
    return category ? `/c/${category.slug}` : null;
  }
  return null;
}
