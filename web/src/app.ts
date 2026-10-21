import { Hono, type Context } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { getCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import { legacyFallback, parseHosts, resolveLegacyPath } from "./legacy.ts";
import type { AppEnv } from "./env.ts";
import {
  REACTIONS,
  attachmentsForPosts,
  categoryTopics,
  createReply,
  createTopic,
  getCategory,
  getTopic,
  latestTopics,
  searchTopics,
  unansweredCount,
  listCategories,
  postIndex,
  rateLimit,
  reactionsForPosts,
  toggleReaction,
  topicPosts,
  type Attachment,
  type Category,
  type User,
} from "./db.ts";
import { markSeen, setWatching, topicUserState, yourThreads } from "./notifications.ts";
import {
  consumeLoginToken,
  createLoginToken,
  currentUser,
  endSession,
  finishGoogle,
  googleAuthUrl,
  googleEnabled,
  peekLoginToken,
  startSession,
  userForGoogle,
  userForVerifiedEmail,
  type SignInResult,
} from "./auth.ts";
import { UploadError, fileUrl, imageUrls, isImage, parseRange, playable, settleAttachments, storeUpload } from "./files.ts";
import { refusalReason, refusePost } from "./spamfilter.ts";
import { AvatarError, avatarKey, removeAvatar, setAvatar } from "./avatars.ts";
import { referencedAttachmentIds, renderMarkdown, excerpt } from "./markdown.ts";
import { sendMail } from "./mailer.ts";
import { feedPosts, feedSearch, feedTopics, lastModified, renderFeed, type Feed } from "./feeds.ts";
import { isEmail, normalizeEmail, safeNext } from "./util.ts";
import { banUser, log, moderationQueue, recentLog, searchUsers, setAdmin, setPostStatus, setTopicFlag, unbanUser } from "./moderation.ts";
import { logPage, queuePage, usersPage } from "./views/admin.ts";
import { layout, type Html } from "./views/layout.ts";
import {
  categoryPage,
  checkEmailPage,
  confirmSignInPage,
  aupPage,
  feedsPage,
  guidelinesPage,
  homePage,
  searchPage,
  unansweredPage,
  messagePage,
  newTopicPage,
  profileForm,
  yourTopicsPage,
  signInPage,
  topicPage,
  topicUrl,
  type RenderedPost,
  refusedPage,
} from "./views/pages.ts";

const TOPICS_PER_PAGE = 30;
const POSTS_PER_PAGE = 40;
const BANNER_COOKIE = "nbf_banner";
/** Set by the sun/moon button (client/app.ts); without it the device's setting decides. */
const THEME_COOKIE = "nbf_theme";
const themeFromCookie = (v: string | undefined) => (v === "light" || v === "dark" ? v : null);

export const app = new Hono<AppEnv>();

// The old forum's own domain (support.nodebox.net), once it points at this Worker: every
// request moves to the same page here, old discussion URLs to their topics.
app.use(async (c, next) => {
  const url = new URL(c.req.url);
  if (!parseHosts(c.env.LEGACY_HOSTS).includes(url.hostname)) return next();
  // Tender's search took the same ?q= as ours; anything else without a counterpart gets the nearest page.
  const target =
    url.pathname.replace(/\/$/, "") === "/search" ? "/search" + url.search : ((await resolveLegacyPath(c.env.DB, url.pathname)) ?? legacyFallback(url.pathname));
  // Concatenated, not resolved with new URL(): a path like //evil.example would leave the site.
  return c.redirect(c.env.PUBLIC_URL.replace(/\/$/, "") + target, 301);
});
// Referrer-Policy same-origin, not Hono's default no-referrer: under no-referrer browsers send
// "Origin: null" on our own form posts, and Safari, which may not send Sec-Fetch-Site either,
// then fails the check below with "Forbidden". Other sites still get no referrer.
app.use(secureHeaders({ crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: false, referrerPolicy: "same-origin" }));
// Rejects cross-site form posts by checking the Origin header (or Sec-Fetch-Site); with SameSite=Lax
// session cookies this is the CSRF protection.
// Mail providers POST one-click unsubscribes (RFC 8058) from their own origin; the token is the check there.
const checkOrigin = csrf();
app.use((c, next) => (c.req.path === "/unsubscribe" ? next() : checkOrigin(c, next)));
app.use(async (c, next) => {
  c.set("user", await currentUser(c));
  c.set("notice", null);
  await next();
});
// Before the move from Tender: reading, signing in and your own settings work; anything that
// touches posts is for admins only, so the final import doesn't have to merge new content.
const READ_ONLY_NOTICE = "The forum is read-only while we move it over from support.nodebox.net. Keep posting there until then.";
/** FORUM_NOTICE in wrangler.jsonc, when set, is the banner on every page; while read-only it replaces the default wording. */
const forumNotice = (c: Context<AppEnv>) => c.env.FORUM_NOTICE || (c.env.READ_ONLY === "true" ? READ_ONLY_NOTICE : null);
app.use(async (c, next) => {
  if (c.env.READ_ONLY !== "true" || c.req.method === "GET" || c.req.method === "HEAD" || c.get("user")?.is_admin) return next();
  if (/^\/(signin|signout|unsubscribe|settings)(\/|$)/.test(c.req.path)) return next();
  return page(c, messagePage("Read-only for now", forumNotice(c) ?? READ_ONLY_NOTICE, { href: "/", label: "Go to the forum" }), { title: "Read-only", status: 403, mainClass: "narrow" });
});

// The sidebar lists categories on every page; they rarely change, so each isolate keeps them for a minute.
let categoryCache: { at: number; list: Category[] } | null = null;
async function sidebarCategories(db: D1Database): Promise<Category[]> {
  if (categoryCache && Date.now() - categoryCache.at < 60_000) return categoryCache.list;
  categoryCache = { at: Date.now(), list: await listCategories(db) };
  return categoryCache.list;
}

async function page(
  c: Context<AppEnv>,
  content: Html,
  opts: {
    title?: string;
    description?: string;
    status?: 200 | 400 | 403 | 404 | 413 | 415 | 422 | 429;
    mainClass?: string;
    query?: string;
    /** This page's own feed, offered to feed readers ahead of the forum-wide ones. */
    feed?: { title: string; href: string };
  } = {},
) {
  const url = new URL(c.req.url);
  const [categories, unanswered] = await Promise.all([sidebarCategories(c.env.DB), unansweredCount(c.env.DB)]);
  return c.html(
    layout(
      {
        title: opts.title,
        description: opts.description,
        user: c.get("user"),
        notice: c.get("notice") ?? noticeFromQuery(url),
        alert: forumNotice(c),
        readOnly: c.env.READ_ONLY === "true",
        showBanner: !c.get("user") && getCookie(c, BANNER_COOKIE) !== "1" && !url.pathname.startsWith("/signin"),
        path: url.pathname + url.search,
        siteName: c.env.SITE_NAME,
        categories,
        unanswered,
        query: opts.query,
        mainClass: opts.mainClass,
        theme: themeFromCookie(getCookie(c, THEME_COOKIE)),
        commit: deployedCommit(c.env.GIT_COMMIT),
        feeds: [...(opts.feed ? [opts.feed] : []), ...siteFeeds(c.env.SITE_NAME).filter((f) => f.href !== opts.feed?.href)],
      },
      content,
    ),
    opts.status ?? 200,
  );
}

/** Offered on every page through <link rel="alternate">. */
const siteFeeds = (siteName: string) => [
  { title: `${siteName}: new topics`, href: "/feeds/topics" },
  { title: `${siteName}: all posts`, href: "/feeds/posts" },
];

const NOTICES: Record<string, string> = {
  "signed-in": "You're signed in.",
  "signed-out": "You're signed out.",
  welcome: "Welcome back! Your posts from the old forum are linked to your account.",
  saved: "Saved.",
  picture: "Your new picture is in place.",
  "picture-removed": "Your picture is gone; your initials are back.",
};
/** The full commit hash Workers Builds deployed, or null in development. */
export function deployedCommit(value: string | undefined): string | null {
  return value && /^[0-9a-f]{40}$/.test(value) ? value : null;
}

function noticeFromQuery(url: URL): string | null {
  return NOTICES[url.searchParams.get("notice") ?? ""] ?? null;
}

function pageNumber(c: Context<AppEnv>): number {
  const n = Number(c.req.query("page") ?? 1);
  return Number.isInteger(n) && n > 0 && n < 10000 ? n : 1;
}

function requireUser(c: Context<AppEnv>) {
  const user = c.get("user");
  if (!user) return { user: null, redirect: c.redirect(`/signin?next=${encodeURIComponent(new URL(c.req.url).pathname)}`) };
  return { user, redirect: null };
}

function clientIp(c: Context<AppEnv>): string {
  return c.req.header("cf-connecting-ip") ?? "local";
}

// --- Reading ------------------------------------------------------------------

app.get("/", async (c) => {
  const p = pageNumber(c);
  const [categories, topics] = await Promise.all([
    listCategories(c.env.DB),
    latestTopics(c.env.DB, TOPICS_PER_PAGE + 1, (p - 1) * TOPICS_PER_PAGE),
  ]);
  const hasMore = topics.length > TOPICS_PER_PAGE;
  return page(c, homePage(categories, topics.slice(0, TOPICS_PER_PAGE), p, hasMore, Boolean(c.get("user"))), {
    feed: { title: `${c.env.SITE_NAME}: new topics`, href: "/feeds/topics" },
  });
});

app.get("/unanswered", async (c) => {
  const p = pageNumber(c);
  const topics = await latestTopics(c.env.DB, TOPICS_PER_PAGE + 1, (p - 1) * TOPICS_PER_PAGE, { unanswered: true });
  const hasMore = topics.length > TOPICS_PER_PAGE;
  return page(c, unansweredPage(topics.slice(0, TOPICS_PER_PAGE), p, hasMore, Boolean(c.get("user"))), {
    title: "Unanswered",
    feed: { title: `${c.env.SITE_NAME}: unanswered`, href: "/feeds/unanswered" },
  });
});

app.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim().slice(0, 200);
  const p = pageNumber(c);
  const hits = q ? await searchTopics(c.env.DB, q, TOPICS_PER_PAGE + 1, (p - 1) * TOPICS_PER_PAGE) : [];
  const hasMore = hits.length > TOPICS_PER_PAGE;
  return page(c, searchPage(q, hits.slice(0, TOPICS_PER_PAGE), p, hasMore, Boolean(c.get("user"))), {
    title: q ? `Search: ${q}` : "Search",
    query: q,
    feed: q ? { title: `Posts matching “${q}”`, href: `/feeds/search?q=${encodeURIComponent(q)}` } : undefined,
  });
});

app.get("/c/:slug", async (c) => {
  const category = await getCategory(c.env.DB, c.req.param("slug"));
  if (!category) return c.notFound();
  const p = pageNumber(c);
  const topics = await categoryTopics(c.env.DB, category.id, TOPICS_PER_PAGE + 1, (p - 1) * TOPICS_PER_PAGE);
  const hasMore = topics.length > TOPICS_PER_PAGE;
  return page(c, categoryPage(category, topics.slice(0, TOPICS_PER_PAGE), p, hasMore, Boolean(c.get("user"))), {
    title: category.name,
    description: category.description,
    feed: { title: `${category.name}: new topics`, href: `/feeds/c/${category.slug}` },
  });
});

async function showTopic(c: Context<AppEnv>) {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.notFound();
  const user = c.get("user");
  const isAdmin = Boolean(user?.is_admin);
  const topic = await getTopic(c.env.DB, id, isAdmin);
  if (!topic) return c.notFound();
  if (c.req.param("slug") !== topic.slug && !c.req.query("page")) return c.redirect(topicUrl(topic), 301);
  const p = pageNumber(c);
  const posts = await topicPosts(c.env.DB, topic.id, POSTS_PER_PAGE + 1, (p - 1) * POSTS_PER_PAGE, isAdmin);
  const hasMore = posts.length > POSTS_PER_PAGE;
  const shown = posts.slice(0, POSTS_PER_PAGE);
  if (shown.length === 0 && p > 1) return c.notFound();
  const ids = shown.map((x) => x.id);
  const [attachments, reactions, state] = await Promise.all([
    attachmentsForPosts(c.env.DB, ids),
    reactionsForPosts(c.env.DB, ids, user?.id ?? null),
    user ? topicUserState(c.env.DB, user.id, topic.id) : null,
  ]);
  if (user) await markSeen(c.env.DB, user.id, topic.id);
  const byId = new Map(attachments.map((a) => [a.id, a]));
  const image = (a: Attachment) => {
    const u = imageUrls(c.env, a);
    return { src: u.src, full: u.full };
  };
  const rendered: RenderedPost[] = shown.map((post) => {
    const mine = attachments.filter((a) => a.post_id === post.id);
    const inline = referencedAttachmentIds(post.body);
    const notInline = mine.filter((a) => !inline.has(a.id));
    return {
      post,
      html: renderMarkdown(post.body, { attachments: byId, image }),
      files: notInline.filter((a) => !isImage(a.content_type) && !playable(a)),
      images: notInline.filter((a) => isImage(a.content_type)).map((a) => ({ a, ...imageUrls(c.env, a) })),
      media: notInline.flatMap((a) => {
        const m = playable(a);
        return m ? [{ a, kind: m.kind, url: fileUrl(a) }] : [];
      }),
      reactions: reactions.filter((r) => r.post_id === post.id),
    };
  });
  return page(c, topicPage(topic, rendered, user, { page: p, hasMore, firstIndex: (p - 1) * POSTS_PER_PAGE, watching: Boolean(state?.watching) }), {
    title: topic.title,
    description: shown[0] ? excerpt(shown[0].body) : undefined,
    feed: { title: `Replies to “${topic.title}”`, href: `/feeds/t/${topic.id}` },
  });
}
// "N new" links from Your topics land on the first post the reader hasn't seen.
app.get("/t/:id/unread", async (c) => {
  const user = c.get("user");
  const topic = await getTopic(c.env.DB, Number(c.req.param("id")));
  if (!topic) return c.notFound();
  if (!user) return c.redirect(topicUrl(topic));
  const state = await topicUserState(c.env.DB, user.id, topic.id);
  const first = await c.env.DB.prepare(
    "SELECT id FROM posts WHERE topic_id = ? AND status = 'visible' AND created_at > ? ORDER BY created_at, id LIMIT 1",
  )
    .bind(topic.id, state?.last_seen_at ?? "")
    .first<{ id: number }>();
  return c.redirect(first ? await postLink(c, topic, first.id) : topicUrl(topic));
});
app.get("/t/:id/:slug", showTopic);
app.get("/t/:id", showTopic);

// A short, stable link to one post, used by feeds; it finds the page the post is on.
app.get("/p/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.notFound();
  const post = await c.env.DB.prepare(
    "SELECT p.id, t.id AS topic_id, t.slug FROM posts p JOIN topics t ON t.id = p.topic_id WHERE p.id = ? AND p.status = 'visible' AND t.status = 'visible'",
  )
    .bind(id)
    .first<{ id: number; topic_id: number; slug: string }>();
  if (!post) return c.notFound();
  return c.redirect(await postLink(c, { id: post.topic_id, slug: post.slug }, post.id), 301);
});

app.get("/guidelines", (c) => page(c, guidelinesPage(), { title: "Guidelines" }));
app.get("/aup", (c) => page(c, aupPage(), { title: "Acceptable use" }));

// --- Feeds --------------------------------------------------------------------

const FEED_TOPICS = 30;
const FEED_POSTS = 50;
const FEED_MAX_AGE = 300;

/**
 * Feed readers poll, so a feed is kept in Cloudflare's cache for a few minutes and
 * answers If-Modified-Since with a 304. Feeds are the same for everyone.
 */
async function feedResponse(c: Context<AppEnv>, build: () => Promise<Feed | null>): Promise<Response> {
  const cache = typeof caches === "undefined" ? undefined : (caches as unknown as { default?: Cache }).default;
  const key = new Request(c.req.url);
  const hit = await cache?.match(key);
  // Responses from the cache have immutable headers; the middleware still adds its own.
  let res = hit ? new Response(hit.body, hit) : undefined;
  if (!res) {
    const feed = await build();
    if (!feed) return c.notFound();
    const headers = new Headers({
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": `public, max-age=${FEED_MAX_AGE}`,
      "X-Content-Type-Options": "nosniff",
    });
    const modified = lastModified(feed.rows);
    if (modified) headers.set("Last-Modified", modified);
    res = new Response(await renderFeed(c.env, c.env.DB, feed), { headers });
    if (cache) {
      const put = cache.put(key, res.clone());
      try {
        c.executionCtx.waitUntil(put);
      } catch {
        await put;
      }
    }
  }
  const since = Date.parse(c.req.header("if-modified-since") ?? "");
  const modified = Date.parse(res.headers.get("last-modified") ?? "");
  if (!Number.isNaN(since) && !Number.isNaN(modified) && modified <= since) {
    return new Response(null, { status: 304, headers: { "Cache-Control": res.headers.get("cache-control")!, "Last-Modified": res.headers.get("last-modified")! } });
  }
  return res;
}

const siteName = (c: Context<AppEnv>) => c.env.SITE_NAME;

app.get("/feeds", async (c) => page(c, feedsPage(await listCategories(c.env.DB)), { title: "RSS feeds" }));

app.get("/feeds/topics", (c) =>
  feedResponse(c, async () => ({
    title: `${siteName(c)}: new topics`,
    description: "New topics in every category of the NodeBox forum.",
    page: "/",
    self: "/feeds/topics",
    rows: await feedTopics(c.env.DB, FEED_TOPICS),
  })),
);

app.get("/feeds/posts", (c) =>
  feedResponse(c, async () => ({
    title: `${siteName(c)}: all posts`,
    description: "Every new post on the NodeBox forum, replies included.",
    page: "/",
    self: "/feeds/posts",
    rows: await feedPosts(c.env.DB, FEED_POSTS),
  })),
);

app.get("/feeds/unanswered", (c) =>
  feedResponse(c, async () => ({
    title: `${siteName(c)}: unanswered`,
    description: "New topics nobody has replied to yet.",
    page: "/unanswered",
    self: "/feeds/unanswered",
    rows: await feedTopics(c.env.DB, FEED_TOPICS, { unanswered: true }),
  })),
);

app.get("/feeds/c/:slug", (c) =>
  feedResponse(c, async () => {
    const category = await getCategory(c.env.DB, c.req.param("slug"));
    if (!category) return null;
    return {
      title: `${siteName(c)}: ${category.name}`,
      description: category.description || `New topics in ${category.name}.`,
      page: `/c/${category.slug}`,
      self: `/feeds/c/${category.slug}`,
      rows: await feedTopics(c.env.DB, FEED_TOPICS, { categoryId: category.id }),
    };
  }),
);

app.get("/feeds/c/:slug/posts", (c) =>
  feedResponse(c, async () => {
    const category = await getCategory(c.env.DB, c.req.param("slug"));
    if (!category) return null;
    return {
      title: `${siteName(c)}: ${category.name}, all posts`,
      description: `Every new post in ${category.name}, replies included.`,
      page: `/c/${category.slug}`,
      self: `/feeds/c/${category.slug}/posts`,
      rows: await feedPosts(c.env.DB, FEED_POSTS, { categoryId: category.id }),
    };
  }),
);

app.get("/feeds/t/:id", (c) =>
  feedResponse(c, async () => {
    const id = Number(c.req.param("id"));
    const topic = Number.isInteger(id) ? await getTopic(c.env.DB, id) : null;
    if (!topic) return null;
    return {
      title: `${siteName(c)}: ${topic.title}`,
      description: `New replies to “${topic.title}” in ${topic.category_name}.`,
      page: topicUrl(topic),
      self: `/feeds/t/${topic.id}`,
      rows: await feedPosts(c.env.DB, FEED_POSTS, { topicId: topic.id }),
    };
  }),
);

app.get("/feeds/search", (c) =>
  feedResponse(c, async () => {
    const q = (c.req.query("q") ?? "").trim().slice(0, 200);
    if (!q) return null;
    return {
      title: `${siteName(c)}: “${q}”`,
      description: `New posts that mention “${q}”.`,
      page: `/search?q=${encodeURIComponent(q)}`,
      self: `/feeds/search?q=${encodeURIComponent(q)}`,
      rows: await feedSearch(c.env.DB, q, FEED_POSTS),
    };
  }),
);

// --- Writing ------------------------------------------------------------------

function attachmentIds(form: Record<string, string | File | (string | File)[]>): string[] {
  const raw = form["attachments"];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.filter((x): x is string => typeof x === "string" && /^[A-Za-z0-9_-]{8,40}$/.test(x));
}

app.get("/new", async (c) => {
  const { redirect } = requireUser(c);
  if (redirect) return redirect;
  const categories = (await listCategories(c.env.DB)).filter((x) => !x.archived);
  return page(c, newTopicPage(categories, c.req.query("category"), {}), { title: "New topic", mainClass: "narrow" });
});

app.post("/new", async (c) => {
  const { user, redirect } = requireUser(c);
  if (redirect) return redirect;
  const form = await c.req.parseBody({ all: true });
  const title = String(form["title"] ?? "").trim().slice(0, 160);
  const body = String(form["body"] ?? "").trim();
  const category = await getCategory(c.env.DB, String(form["category"] ?? ""));
  const categories = (await listCategories(c.env.DB)).filter((x) => !x.archived);
  const fail = (error: string) =>
    page(c, newTopicPage(categories, category?.slug, { title, body, error }), { title: "New topic", status: 400, mainClass: "narrow" });
  if (!category) return fail("Pick a category.");
  if (category.archived) return fail(`${category.name} is archived and takes no new topics. Pick another category.`);
  if (title.length < 3) return fail("The title needs a few more words.");
  if (body.length === 0) return fail("Write a message (or at least attach something and say what it is).");
  if (!(await rateLimit(c.env.DB, `post:${user.id}`, 20, 3600))) return fail("You're posting very fast. Please wait a while and try again.");
  const refusal = await refusalReason(c.env, user, { topicTitle: title, body, opensTopic: true });
  const { topicId, postId } = await createTopic(c.env.DB, { categoryId: category.id, userId: user.id, title, body, attachmentIds: attachmentIds(form), refused: refusal });
  await settleAttachments(c.env, postId);
  if (refusal) {
    await refusePost(c.env, { postId, topicId, userId: user.id, reason: refusal });
    return page(c, refusedPage(), { title: "Not posted", status: 422, mainClass: "narrow" });
  }
  const topic = await getTopic(c.env.DB, topicId);
  return c.redirect(topicUrl(topic!));
});

app.post("/t/:id/reply", async (c) => {
  const { user, redirect } = requireUser(c);
  if (redirect) return redirect;
  const topic = await getTopic(c.env.DB, Number(c.req.param("id")));
  if (!topic) return c.notFound();
  if (topic.locked && !user.is_admin) return page(c, messagePage("Locked", "This topic is locked."), { status: 403 });
  const form = await c.req.parseBody({ all: true });
  const body = String(form["body"] ?? "").trim();
  if (!body) return c.redirect(topicUrl(topic));
  if (!(await rateLimit(c.env.DB, `post:${user.id}`, 20, 3600))) {
    return page(c, messagePage("Slow down a little", "You're posting very fast. Please wait a while and try again."), { status: 429 });
  }
  const refusal = await refusalReason(c.env, user, { topicTitle: topic.title, body, opensTopic: false });
  const postId = await createReply(c.env.DB, { topicId: topic.id, userId: user.id, body, attachmentIds: attachmentIds(form), refused: refusal });
  await settleAttachments(c.env, postId);
  if (refusal) {
    await refusePost(c.env, { postId, topicId: topic.id, userId: user.id, reason: refusal });
    return page(c, refusedPage(), { title: "Not posted", status: 422, mainClass: "narrow" });
  }
  return c.redirect(await postLink(c, topic, postId));
});

async function postLink(c: Context<AppEnv>, topic: { id: number; slug: string }, postId: number): Promise<string> {
  const index = await postIndex(c.env.DB, topic.id, postId);
  const p = Math.floor(index / POSTS_PER_PAGE) + 1;
  return `${topicUrl(topic)}${p > 1 ? `?page=${p}` : ""}#post-${postId}`;
}

app.post("/t/:id/watch", async (c) => {
  const { user, redirect } = requireUser(c);
  if (redirect) return redirect;
  const topic = await getTopic(c.env.DB, Number(c.req.param("id")));
  if (!topic) return c.notFound();
  const form = await c.req.parseBody();
  await setWatching(c.env.DB, user.id, topic.id, form["watch"] === "1");
  return c.redirect(topicUrl(topic));
});

app.get("/topics/mine", async (c) => {
  const { user, redirect } = requireUser(c);
  if (redirect) return redirect;
  const topics = await yourThreads(c.env.DB, user.id);
  return page(c, yourTopicsPage(topics, Boolean(user.email_digest)), { title: "Your topics" });
});

app.post("/posts/:id/react", async (c) => {
  const wantsJson = c.req.header("accept")?.includes("application/json");
  const user = c.get("user");
  if (!user) return wantsJson ? c.json({ error: "Sign in to react." }, 401) : c.redirect("/signin");
  const postId = Number(c.req.param("id"));
  const form = await c.req.parseBody();
  const emoji = String(form["emoji"] ?? "");
  if (!(REACTIONS as readonly string[]).includes(emoji)) return c.json({ error: "Unknown reaction." }, 400);
  const post = await c.env.DB.prepare(
    "SELECT p.id, p.topic_id, t.slug FROM posts p JOIN topics t ON t.id = p.topic_id WHERE p.id = ? AND p.status = 'visible' AND t.status = 'visible'",
  )
    .bind(postId)
    .first<{ id: number; topic_id: number; slug: string }>();
  if (!post) return c.notFound();
  if (!(await rateLimit(c.env.DB, `react:${user.id}`, 120, 600))) return c.json({ error: "Too many reactions, slow down." }, 429);
  await toggleReaction(c.env.DB, postId, user.id, emoji);
  if (!wantsJson) return c.redirect(await postLink(c, { id: post.topic_id, slug: post.slug }, postId));
  const summary = await reactionsForPosts(c.env.DB, [postId], user.id);
  return c.json({
    reactions: summary.map((r) => ({ emoji: r.emoji, count: r.count, names: r.names, mine: Boolean(r.mine) })),
  });
});

app.post("/preview", async (c) => {
  if (!c.get("user")) return c.json({ error: "Sign in first." }, 401);
  const { body } = await c.req.json<{ body?: string }>();
  const source = String(body ?? "").slice(0, 50000);
  const ids = [...referencedAttachmentIds(source)].slice(0, 50);
  const attachments = ids.length
    ? (
        await c.env.DB.prepare(`SELECT * FROM attachments WHERE id IN (${ids.map(() => "?").join(",")})`)
          .bind(...ids)
          .all<Attachment>()
      ).results
    : [];
  const html = renderMarkdown(source, {
    attachments: new Map(attachments.map((a) => [a.id, a])),
    image: (a) => imageUrls(c.env, a),
  });
  return c.json({ html });
});

// --- Files --------------------------------------------------------------------

app.post("/uploads", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Sign in to attach files." }, 401);
  if (!(await rateLimit(c.env.DB, `upload:${user.id}`, 60, 3600))) return c.json({ error: "Too many uploads. Please wait a while." }, 429);
  const form = await c.req.parseBody();
  const file = form["file"];
  if (!(file instanceof File)) return c.json({ error: "No file received." }, 400);
  try {
    const a = await storeUpload(c.env, c.env.DB, user.id, file);
    const image = isImage(a.content_type);
    const url = fileUrl(a);
    // Pictures, video and sound go into the text where the cursor is, so they show in the post.
    const shown = image || playable(a);
    return c.json({
      id: a.id,
      filename: a.filename,
      size: a.size,
      contentType: a.content_type,
      isImage: image,
      url,
      thumb: image ? imageUrls(c.env, a).thumb : null,
      markdown: shown ? `![${a.filename.replace(/[[\]]/g, "")}](${url})` : null,
    });
  } catch (err) {
    if (err instanceof UploadError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

app.get("/files/:id/:name?", async (c) => {
  const a = await c.env.DB.prepare("SELECT * FROM attachments WHERE id = ?").bind(c.req.param("id")).first<Attachment>();
  if (!a) return c.notFound();
  // Video players (Safari above all) ask for byte ranges and won't play without them.
  // The stored size can be missing for imported files, so ask R2 for the real one.
  const asked = c.req.header("range");
  const size = asked ? (await c.env.FILES.head(a.r2_key))?.size : undefined;
  if (asked && size === undefined) return c.notFound();
  const range = size === undefined ? null : parseRange(asked, size);
  if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  const obj = await c.env.FILES.get(a.r2_key, range ? { range } : undefined);
  if (!obj) return c.notFound();
  const media = playable(a);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Content-Type", media?.type ?? a.content_type);
  headers.set("Accept-Ranges", "bytes");
  headers.set("ETag", obj.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("X-Content-Type-Options", "nosniff");
  // Uploaded files are never allowed to run script on our origin.
  headers.set("Content-Security-Policy", "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
  // Imported files carry the disposition they were uploaded with, so set it every time.
  headers.set("Content-Disposition", `${isImage(a.content_type) || media ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
  if (range) {
    const length = Math.min(range.length, obj.size - range.offset);
    headers.set("Content-Range", `bytes ${range.offset}-${range.offset + length - 1}/${obj.size}`);
    headers.set("Content-Length", String(length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(obj.size));
  return new Response(obj.body, { headers });
});

// --- Sign-in ------------------------------------------------------------------

app.get("/signin", (c) => {
  if (c.get("user")) return c.redirect(safeNext(c.req.query("next")));
  const error = c.req.query("error");
  return page(c, signInPage({ next: safeNext(c.req.query("next")), google: googleEnabled(c.env), error }), {
    title: "Sign in",
    mainClass: "narrow",
  });
});

app.post("/signin/email", async (c) => {
  const form = await c.req.parseBody();
  const next = safeNext(String(form["next"] ?? "/"));
  const email = normalizeEmail(String(form["email"] ?? ""));
  const again = (error: string, status: 400 | 429 = 400) =>
    page(c, signInPage({ next, google: googleEnabled(c.env), error, email }), { title: "Sign in", status, mainClass: "narrow" });
  if (!isEmail(email)) return again("That doesn't look like an email address.");
  const okEmail = await rateLimit(c.env.DB, `signin:${email}`, 3, 900);
  const okIp = await rateLimit(c.env.DB, `signin-ip:${clientIp(c)}`, 20, 3600);
  if (!okEmail || !okIp) return again("We've sent a few links already. Check your inbox, or try again in a little while.", 429);
  const token = await createLoginToken(c.env.DB, email, next);
  const link = `${c.env.PUBLIC_URL.replace(/\/$/, "")}/signin/verify?token=${encodeURIComponent(token)}`;
  await sendMail(c.env, {
    to: email,
    subject: `Sign in to the ${c.env.SITE_NAME}`,
    text: `Hi,\n\nUse this link to sign in to the ${c.env.SITE_NAME}. It works once, for the next 15 minutes:\n\n${link}\n\nIf you didn't ask for it, you can ignore this email.\n`,
    html: `<p>Hi,</p><p>Use this link to sign in to the ${c.env.SITE_NAME}. It works once, for the next 15 minutes:</p><p><a href="${link}">Sign in to the ${c.env.SITE_NAME}</a></p><p>If you didn't ask for it, you can ignore this email.</p>`,
  });
  return page(c, checkEmailPage(email, c.env.MAILER === "log" ? link : null), { title: "Check your email", mainClass: "narrow" });
});

// The link in the email shows a button instead of signing in right away, so
// mail scanners that pre-open links don't use up the token.
app.get("/signin/verify", async (c) => {
  const token = c.req.query("token") ?? "";
  const info = token ? await peekLoginToken(c.env.DB, token) : null;
  if (!info) return page(c, messagePage("That link has expired", "Sign-in links work once, for 15 minutes. Ask for a new one.", { href: "/signin", label: "Get a new link" }), { status: 400, mainClass: "narrow" });
  return page(c, confirmSignInPage(info.email, token), { title: "Sign in", mainClass: "narrow" });
});

app.post("/signin/verify", async (c) => {
  const form = await c.req.parseBody();
  const info = await consumeLoginToken(c.env.DB, String(form["token"] ?? ""));
  if (!info) return page(c, messagePage("That link has expired", "Sign-in links work once, for 15 minutes. Ask for a new one.", { href: "/signin", label: "Get a new link" }), { status: 400, mainClass: "narrow" });
  return finishSignIn(c, await userForVerifiedEmail(c.env.DB, info.email), info.next);
});

app.get("/auth/google", (c) => {
  if (!googleEnabled(c.env)) return c.redirect("/signin");
  return c.redirect(googleAuthUrl(c, safeNext(c.req.query("next"))));
});

app.get("/auth/google/callback", async (c) => {
  if (!googleEnabled(c.env)) return c.redirect("/signin");
  try {
    const { profile, next } = await finishGoogle(c);
    return finishSignIn(c, await userForGoogle(c.env.DB, profile), safeNext(next));
  } catch (err) {
    return c.redirect(`/signin?error=${encodeURIComponent(err instanceof Error ? err.message : "Sign-in failed.")}`);
  }
});

async function finishSignIn(c: Context<AppEnv>, result: SignInResult, next: string) {
  if (result.user.banned_at) return page(c, messagePage("Account suspended", "This account can't sign in."), { status: 403 });
  await startSession(c, result.user.id);
  if (result.isNew) return c.redirect(`/welcome?next=${encodeURIComponent(next)}`);
  const sep = next.includes("?") ? "&" : "?";
  return c.redirect(`${next}${sep}notice=${result.claimed ? "welcome" : "signed-in"}`);
}

app.get("/welcome", (c) => {
  const { user, redirect } = requireUser(c);
  if (redirect) return redirect;
  return page(
    c,
    profileForm({
      heading: "Welcome!",
      intro: "One last thing: what should we call you?",
      name: user.name,
      next: safeNext(c.req.query("next")),
      submit: "Continue",
    }),
    { title: "Welcome", mainClass: "narrow" },
  );
});

app.get("/settings", (c) => {
  const { user, redirect } = requireUser(c);
  if (redirect) return redirect;
  return settingsPage(c, user);
});

function settingsPage(c: Context<AppEnv>, user: User, pictureError?: { message: string; status: 400 | 413 | 415 | 429 }) {
  return page(
    c,
    profileForm({
      heading: "Settings",
      intro: `Signed in as ${user.email}.`,
      name: user.name,
      next: "/settings?notice=saved",
      submit: "Save",
      digest: Boolean(user.email_digest),
      picture: { user, error: pictureError?.message },
    }),
    { title: "Settings", mainClass: "narrow", status: pictureError?.status },
  );
}

// The profile picture. The script on the settings page sends a cropped square and wants JSON
// back; the plain form (no script) sends the file as it is and gets the page.
app.post("/settings/picture", async (c) => {
  const { user, redirect } = requireUser(c);
  if (redirect) return redirect;
  const wantsJson = (c.req.header("accept") ?? "").includes("application/json");
  const fail = (message: string, status: 400 | 413 | 415 | 429) => (wantsJson ? c.json({ error: message }, status) : settingsPage(c, user, { message, status }));
  if (!(await rateLimit(c.env.DB, `picture:${user.id}`, 20, 3600))) return fail("You've changed your picture a lot just now. Try again in a while.", 429);
  const file = (await c.req.parseBody())["picture"];
  if (!(file instanceof File)) return fail("Choose a picture first.", 400);
  try {
    await setAvatar(c.env, user.id, file);
  } catch (err) {
    if (err instanceof AvatarError) return fail(err.message, err.status);
    throw err;
  }
  return wantsJson ? c.json({ ok: true, next: "/settings?notice=picture" }) : c.redirect("/settings?notice=picture");
});

app.post("/settings/picture/remove", async (c) => {
  const { user, redirect } = requireUser(c);
  if (redirect) return redirect;
  await removeAvatar(c.env, user.id);
  return c.redirect("/settings?notice=picture-removed");
});

// Pictures get a new name each time they change, so they can be cached for good. A banned
// person's picture isn't shown (but kept, like their posts, in case of an unban).
app.get("/avatars/:user/:avatar", async (c) => {
  const userId = Number(c.req.param("user"));
  const avatar = c.req.param("avatar");
  const ok = await c.env.DB.prepare("SELECT 1 FROM users WHERE id = ? AND avatar = ? AND banned_at IS NULL").bind(userId, avatar).first();
  if (!ok) return c.notFound();
  const obj = await c.env.FILES.get(avatarKey(userId, avatar));
  if (!obj) return c.notFound();
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("ETag", obj.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
  headers.set("Content-Length", String(obj.size));
  return new Response(obj.body, { headers });
});

app.post("/settings", async (c) => {
  const { user, redirect } = requireUser(c);
  if (redirect) return redirect;
  const form = await c.req.parseBody();
  const name = String(form["name"] ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  const next = safeNext(String(form["next"] ?? "/"));
  if (name.length < 2) {
    return page(c, profileForm({ heading: "Settings", intro: "", name, next, submit: "Save", error: "Use at least two characters." }), { status: 400, mainClass: "narrow" });
  }
  const digest = form["has_digest"] ? (form["email_digest"] === "1" ? 1 : 0) : user.email_digest;
  await c.env.DB.prepare("UPDATE users SET name = ?, email_digest = ? WHERE id = ?").bind(name, digest, user.id).run();
  return c.redirect(next);
});

// One-click unsubscribe from digest emails (the link in every digest, and List-Unsubscribe).
async function unsubscribe(c: Context<AppEnv>) {
  const id = Number(c.req.query("u"));
  const token = c.req.query("t") ?? "";
  const ok =
    token.length > 0 &&
    (await c.env.DB.prepare("UPDATE users SET email_digest = 0 WHERE id = ? AND unsubscribe_token = ?").bind(id, token).run()).meta.changes > 0;
  if (c.req.method === "POST") return c.body(null, ok ? 200 : 404);
  return page(
    c,
    ok
      ? messagePage("You won't get these emails any more", "No more reply digests. You can turn them back on in Settings.", { href: "/settings", label: "Settings" })
      : messagePage("That link didn't work", "Sign in and change your email setting in Settings instead.", { href: "/settings", label: "Settings" }),
    { title: "Email digests", mainClass: "narrow", status: ok ? 200 : 404 },
  );
}
app.get("/unsubscribe", unsubscribe);
app.post("/unsubscribe", unsubscribe);

app.post("/signout", async (c) => {
  await endSession(c);
  return c.redirect("/?notice=signed-out");
});

// --- Moderation (admins only) -------------------------------------------------

const admin = new Hono<AppEnv>();
admin.use(async (c, next) => {
  const user = c.get("user");
  if (!user) return c.redirect(`/signin?next=${encodeURIComponent(new URL(c.req.url).pathname)}`);
  if (!user.is_admin) return page(c, messagePage("Admins only", "This part of the forum is for moderators."), { status: 403, mainClass: "narrow" });
  await next();
});

admin.get("/", async (c) => {
  const view = c.req.query("view") === "removed" ? "removed" : "spam";
  const p = pageNumber(c);
  return page(c, queuePage(view, await moderationQueue(c.env.DB, view, 100, (p - 1) * 100)), { title: "Moderation" });
});

admin.post("/posts/:id", async (c) => {
  const me = c.get("user")!;
  const form = await c.req.parseBody();
  const action = String(form["action"] ?? "");
  const status = action === "spam" ? "spam" : action === "remove" ? "removed" : action === "restore" ? "visible" : null;
  if (!status) return c.text("Unknown action", 400);
  const reason = status === "removed" ? String(form["reason"] ?? "").slice(0, 200) || null : status === "spam" ? "Spam" : null;
  const postId = Number(c.req.param("id"));
  const result = await setPostStatus(c.env.DB, postId, status, me, reason);
  if (!result) return c.notFound();
  if (status === "spam" && form["ban"] === "1") {
    const author = await c.env.DB.prepare("SELECT user_id FROM posts WHERE id = ?").bind(postId).first<{ user_id: number }>();
    if (author && author.user_id !== me.id) await banUser(c.env.DB, author.user_id, me, true);
  }
  const back = safeNext(String(form["return"] ?? "/admin"));
  return c.redirect(back.startsWith("/t/") ? `${back}#post-${postId}` : back);
});

admin.post("/topics/:id", async (c) => {
  const me = c.get("user")!;
  const topic = await getTopic(c.env.DB, Number(c.req.param("id")), true);
  if (!topic) return c.notFound();
  const action = String((await c.req.parseBody())["action"] ?? "");
  const flags: Record<string, ["pinned" | "locked", boolean]> = { pin: ["pinned", true], unpin: ["pinned", false], lock: ["locked", true], unlock: ["locked", false] };
  const flag = flags[action];
  if (!flag) return c.text("Unknown action", 400);
  await setTopicFlag(c.env.DB, topic.id, flag[0], flag[1], me);
  return c.redirect(topicUrl(topic));
});

admin.get("/users", async (c) => {
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  return page(c, usersPage(q, await searchUsers(c.env.DB, q), c.get("user")!.id), { title: "People" });
});

admin.post("/users/:id", async (c) => {
  const me = c.get("user")!;
  const userId = Number(c.req.param("id"));
  if (userId === me.id) return c.text("You can't change your own account here.", 400);
  const form = await c.req.parseBody();
  const action = String(form["action"] ?? "");
  if (action === "grant_admin") await setAdmin(c.env.DB, userId, true, me);
  else if (action === "revoke_admin") await setAdmin(c.env.DB, userId, false, me);
  else if (action === "ban") await banUser(c.env.DB, userId, me, false);
  else if (action === "unban") await unbanUser(c.env.DB, userId, me);
  else if (action === "remove_picture") {
    if (await removeAvatar(c.env, userId)) await log(c.env.DB, { adminId: me.id, action: "remove_picture", userId }).run();
  } else return c.text("Unknown action", 400);
  return c.redirect(safeNext(String(form["return"] ?? "/admin/users")));
});

admin.get("/log", async (c) => page(c, logPage(await recentLog(c.env.DB)), { title: "Moderation log" }));

app.route("/admin", admin);

// --- Fallbacks ----------------------------------------------------------------

app.notFound(async (c) => {
  // Old Tender links: /discussions/<category>/<number>-<slug> and category pages.
  const path = new URL(c.req.url).pathname;
  const legacy = path.startsWith("/discussions") ? ((await resolveLegacyPath(c.env.DB, path)) ?? legacyFallback(path)) : null;
  if (legacy) return c.redirect(legacy, 301);
  return page(c, messagePage("Not found", "That page doesn't exist, or it moved.", { href: "/", label: "Go to the forum" }), {
    title: "Not found",
    status: 404,
    mainClass: "narrow",
  });
});

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  return c.html(`<!doctype html><title>Error</title><p>Something went wrong on our side. Please try again.</p>`, 500);
});
