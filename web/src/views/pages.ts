import { html, raw } from "hono/html";
import { REACTIONS, type Attachment, type Category, type PostRow, type ReactionSummary, type TopicRow, type User } from "../db.ts";
import { fileKind, fileUrl } from "../files.ts";
import { formatBytes, timeAgo } from "../util.ts";
import { excerpt, mediaPlayer } from "../markdown.ts";
import { avatar, categoryBadge, type Html } from "./layout.ts";
import { icon } from "./icons.ts";
import { postModMenu, topicModBar } from "./admin.ts";
import type { YourThread } from "../notifications.ts";

const time = (iso: string) => html`<time datetime="${iso}" title="${new Date(iso).toUTCString()}">${timeAgo(iso)}</time>`;

export const topicUrl = (t: { id: number; slug: string }) => `/t/${t.id}/${t.slug}`;

/** Pinned and locked, written out: a word is easier to read than an icon alone. */
function statusLabels(t: { pinned: number; locked: number }): Html {
  return html`${t.pinned ? html`<span class="label">${icon("pin", { size: 16 })}Pinned</span>` : ""}${t.locked
    ? html`<span class="label">${icon("lock", { size: 16 })}Locked</span>`
    : ""}`;
}

interface ListRow {
  id: number;
  title: string;
  slug: string;
  post_count: number;
  last_post_at: string;
  pinned: number;
  locked: number;
  category_id: number;
  category_name: string;
  category_slug: string;
  category_archived?: number;
  author_name?: string;
  last_post_user_name?: string | null;
  first_body?: string | null;
  tender_id?: number | null;
}

/**
 * The topic list, on the content grid: title, one line of the opening post and who/where
 * on columns 1-7; replies and last activity on 8-9.
 */
function topicTable<T extends ListRow>(
  topics: T[],
  opts: { showCategory: boolean; href?: (t: T) => string; meta?: (t: T) => Html; unread?: (t: T) => boolean; excerpt?: (t: T) => string | null },
): Html {
  return html`<ol class="topics">
    ${topics.map((t) => {
      const replies = t.post_count - 1;
      const line = opts.excerpt ? opts.excerpt(t) : t.first_body ? excerpt(t.first_body, 200) : null;
      return html`<li class="topic-item${opts.unread?.(t) ? " unread" : ""}">
        <div class="topic-item-main">
          <h2 class="topic-item-title"><a href="${opts.href ? opts.href(t) : topicUrl(t)}">${t.title}</a></h2>
          ${line ? html`<p class="topic-item-excerpt">${line}</p>` : ""}
          <p class="topic-item-meta">
            ${statusLabels(t)}
            ${opts.showCategory ? categoryBadge({ id: t.category_id, slug: t.category_slug, name: t.category_name, archived: t.category_archived }) : ""}
            ${t.author_name ? html`<span>${t.author_name}</span>` : ""}
            ${t.tender_id ? html`<span>From the old forum</span>` : ""}
            ${opts.meta?.(t) ?? ""}
          </p>
        </div>
        <div class="topic-item-stats">
          ${replies > 0
            ? html`<p class="stat-replies"><strong>${replies}</strong> ${replies === 1 ? "reply" : "replies"}</p>`
            : html`<p class="stat-replies none">No replies yet</p>`}
          <p class="stat-last">${time(t.last_post_at)}${replies > 0 && t.last_post_user_name ? html`<span> by ${firstName(t.last_post_user_name)}</span>` : ""}</p>
        </div>
      </li>`;
    })}
  </ol>`;
}

const firstName = (name: string) => name.split(/\s+/)[0] ?? name;

function topicList(topics: ListRow[], opts: { showCategory: boolean; empty?: string }): Html {
  if (topics.length === 0) return html`<p class="empty">${opts.empty ?? "No topics yet. Be the first to start one."}</p>`;
  return topicTable(topics, { showCategory: opts.showCategory });
}

function pager(base: string, page: number, hasMore: boolean): Html {
  if (page <= 1 && !hasMore) return html``;
  const sep = base.includes("?") ? "&" : "?";
  const href = (p: number) => (p <= 1 ? base : `${base}${sep}page=${p}`);
  return html`<nav class="pager" aria-label="Pages">
    ${page > 1 ? html`<a class="button button-quiet" href="${href(page - 1)}">${icon("chevron-left", { size: 16 })}Newer</a>` : html`<span></span>`}
    <span class="muted">Page ${page}</span>
    ${hasMore ? html`<a class="button button-quiet" href="${href(page + 1)}">Older${icon("chevron-right", { size: 16 })}</a>` : html`<span></span>`}
  </nav>`;
}

function mainHead(opts: { title: string; lede?: string | Html; action?: Html; kicker?: Html }): Html {
  return html`<header class="main-head">
    <div class="main-head-text">
      ${opts.kicker ?? ""}
      <h1>${opts.title}</h1>
      ${opts.lede ? html`<p class="lede">${opts.lede}</p>` : ""}
    </div>
    ${opts.action ? html`<div class="main-head-action">${opts.action}</div>` : ""}
  </header>`;
}

const newTopicButton = (signedIn: boolean, category?: string) => {
  const target = category ? `/new?category=${category}` : "/new";
  return html`<a class="button button-primary" href="${signedIn ? target : `/signin?next=${encodeURIComponent(target)}`}">${icon("plus", { size: 16 })}New topic</a>`;
};

/** A quiet link to the feed that follows this page. */
const feedButton = (href: string, title: string) =>
  html`<a class="button button-quiet" href="${href}" type="application/rss+xml" title="${title}">${icon("rss", { size: 16 })}RSS</a>`;

function listTabs(active: "latest" | "unanswered"): Html {
  const tab = (href: string, key: string, label: string) =>
    html`<a href="${href}" class="tab${active === key ? " active" : ""}" ${active === key ? raw('aria-current="page"') : ""}>${label}</a>`;
  return html`<nav class="tabs" aria-label="Show">${tab("/", "latest", "All topics")}${tab("/unanswered", "unanswered", "Unanswered")}</nav>`;
}

export function homePage(_categories: Category[], latest: ListRow[], page: number, hasMore: boolean, signedIn: boolean): Html {
  return html`
    ${mainHead({
      title: page === 1 ? "Latest" : `Latest, page ${page}`,
      lede: page === 1 ? "Questions, projects and bugs from the NodeBox community. Search first: many questions have been answered before." : undefined,
      action: html`${feedButton("/feeds/topics", "Follow new topics in every category by RSS")}${newTopicButton(signedIn)}`,
    })}
    ${listTabs("latest")}
    ${topicList(latest, { showCategory: true })}
    ${pager("/", page, hasMore)}`;
}

export function unansweredPage(topics: ListRow[], page: number, hasMore: boolean, signedIn: boolean): Html {
  return html`
    ${mainHead({
      title: "Unanswered",
      lede: "Topics nobody has replied to yet. If you know something that helps, this is where it counts most.",
      action: html`${feedButton("/feeds/unanswered", "Follow unanswered topics by RSS")}${newTopicButton(signedIn)}`,
    })}
    ${listTabs("unanswered")}
    ${topicList(topics, { showCategory: true, empty: "Every topic has a reply. Nice." })}
    ${pager("/unanswered", page, hasMore)}`;
}

export function searchPage(q: string, hits: (ListRow & { snippet: string | null })[], page: number, hasMore: boolean, signedIn: boolean): Html {
  return html`
    ${mainHead({
      title: q ? `Results for “${q}”` : "Search",
      lede: q ? undefined : "Search topic titles and posts.",
      action: html`${q ? feedButton(`/feeds/search?q=${encodeURIComponent(q)}`, `Follow new posts that mention “${q}” by RSS`) : ""}${newTopicButton(signedIn)}`,
    })}
    ${q
      ? hits.length === 0
        ? html`<p class="empty">Nothing matches “${q}”. Try fewer or different words, or ask it as a new topic.</p>`
        : topicTable(hits, { showCategory: true, excerpt: (t) => (t.snippet ? excerpt(t.snippet, 220) : t.first_body ? excerpt(t.first_body, 200) : null) })
      : ""}
    ${pager(`/search?q=${encodeURIComponent(q)}`, page, hasMore)}`;
}

export function categoryPage(category: Category, topics: ListRow[], page: number, hasMore: boolean, signedIn: boolean): Html {
  const count = html`<span>${category.topic_count} ${category.topic_count === 1 ? "topic" : "topics"}</span>`;
  return html`
    ${mainHead({
      title: category.name,
      lede: category.description || undefined,
      kicker: html`<p class="kicker">${category.archived ? html`<span class="label label-archived">${icon("archive", { size: 16 })}Archive</span>` : ""}${count}</p>`,
      action: html`${feedButton(`/feeds/c/${category.slug}`, `Follow new topics in ${category.name} by RSS`)}${category.archived ? "" : newTopicButton(signedIn, category.slug)}`,
    })}
    ${category.archived ? archiveNote(category.name) : ""}
    ${topicList(topics, { showCategory: false })}
    ${pager(`/c/${category.slug}`, page, hasMore)}`;
}

/** Why an archived category is quiet, and where to go instead. */
function archiveNote(name: string): Html {
  return html`<p class="archive-note">${icon("archive", { size: 18 })}<span><strong>${name} is archived.</strong>
    Its topics stay here to read and search, but it takes no new topics. Questions about current NodeBox go in <a href="/">the active categories</a>.</span></p>`;
}

export interface RenderedPost {
  post: PostRow;
  html: string;
  /** Attachments not shown inline in the body. */
  files: Attachment[];
  /** Images not referenced in the body (shown as a gallery). */
  images: { a: Attachment; src: string; thumb: string; full: string }[];
  /** Video and sound not referenced in the body (shown as players). */
  media: { a: Attachment; kind: "video" | "audio"; url: string }[];
  reactions: ReactionSummary[];
}

const HEART = "❤️";

function reactionBar(post: PostRow, reactions: ReactionSummary[], user: User | null): Html {
  const byEmoji = new Map(reactions.map((r) => [r.emoji, r]));
  const needsSignin = user ? "" : raw("data-needs-signin");
  const heart = byEmoji.get(HEART);
  // The heart is the one-click "this helped" (as on Discourse). Emoji people used follow; the rest open from React.
  return html`<form class="reactions" method="post" action="/posts/${post.id}/react" data-reactions>
    <button type="submit" name="emoji" value="${HEART}"
      class="reaction heart${heart ? " has" : ""}${heart?.mine ? " mine" : ""}"
      aria-pressed="${heart?.mine ? "true" : "false"}" title="${heart ? `${heart.names} liked this` : "Like this post"}" ${needsSignin}>
      ${icon("heart", { size: 18, class: "heart-icon" })}<span class="reaction-count">${heart ? heart.count : ""}</span><span class="heart-label">Like</span>
    </button>
    ${REACTIONS.filter((e) => e !== HEART).map((emoji) => {
      const r = byEmoji.get(emoji);
      const label = r ? `${r.names} reacted ${emoji}` : `React ${emoji}`;
      return html`<button type="submit" name="emoji" value="${emoji}"
        class="reaction${r ? " has" : ""}${r?.mine ? " mine" : ""}"
        aria-pressed="${r?.mine ? "true" : "false"}" title="${label}" ${needsSignin}>
        <span class="emoji">${emoji}</span><span class="reaction-count">${r ? r.count : ""}</span>
      </button>`;
    })}
    <button type="button" class="action react-toggle" title="Add a reaction">${icon("smile-plus", { size: 18 })}<span>React</span></button>
  </form>`;
}

/**
 * Pictures attached to a post but not placed in its text. One picture shows at
 * reading size; several show as a grid of thumbnails. Each opens in the
 * lightbox (client/app.ts), or in a new tab without script.
 */
function gallery(images: RenderedPost["images"]): Html | string {
  if (images.length === 0) return "";
  const one = images.length === 1;
  return html`<ul class="gallery${one ? " gallery-one" : ""}">${images.map(({ a, src, thumb, full }) => {
    const dims = one && a.width && a.height ? raw(` width="${a.width}" height="${a.height}"`) : "";
    return html`<li><a href="${full}" target="_blank" rel="noopener" data-lightbox data-caption="${a.filename}">
      <img src="${one ? src : thumb}" alt="${a.filename}" loading="lazy" decoding="async"${dims}></a></li>`;
  })}</ul>`;
}

/** The picture viewer, opened by client/app.ts on any [data-lightbox] link. Esc, the arrow keys and swipes work. */
function lightbox(): Html {
  return html`<dialog class="lightbox" data-lightbox-dialog aria-label="Picture">
    <figure class="lightbox-stage" data-lightbox-stage>
      <img alt="" data-lightbox-img>
      <figcaption>
        <span class="lightbox-caption" data-lightbox-caption></span>
        <span class="lightbox-count" data-lightbox-count></span>
        <a class="lightbox-open" href="#" target="_blank" rel="noopener" data-lightbox-open>${icon("external-link", { size: 18 })}<span>Original</span></a>
      </figcaption>
    </figure>
    <button type="button" class="lightbox-button lightbox-prev" data-lightbox-prev aria-label="Previous picture">${icon("chevron-left", { size: 28 })}</button>
    <button type="button" class="lightbox-button lightbox-next" data-lightbox-next aria-label="Next picture">${icon("chevron-right", { size: 28 })}</button>
    <button type="button" class="lightbox-button lightbox-close" data-lightbox-close aria-label="Close">${icon("x", { size: 24 })}</button>
  </dialog>`;
}

/** A video or sound attachment: the player, then its name and a download link. */
function mediaItem(m: RenderedPost["media"][number]): Html {
  return html`<figure class="media media-${m.kind}">
    ${raw(mediaPlayer(m.kind, m.url, m.a.filename))}
    <figcaption><span class="file-name">${m.a.filename}</span><span class="file-meta">${formatBytes(m.a.size)}</span>
      <a class="action" href="${m.url}" download>${icon("download", { size: 18 })}<span>Download</span></a></figcaption>
  </figure>`;
}

function fileCard(a: Attachment): Html {
  const kind = fileKind(a);
  const label = kind === "nodebox" ? "NodeBox project" : kind === "zip" ? "ZIP archive" : a.content_type;
  return html`<li><a class="file-card file-${kind}" href="${fileUrl(a)}" download>
    <span class="file-icon">${icon(kind === "nodebox" ? "box" : kind === "zip" ? "file-archive" : "file", { size: 20 })}</span>
    <span class="file-text"><span class="file-name">${a.filename}</span><span class="file-meta">${label} · ${formatBytes(a.size)}</span></span>
    <span class="file-dl">${icon("download", { size: 18 })}</span>
  </a></li>`;
}

export function topicPage(
  topic: TopicRow,
  posts: RenderedPost[],
  user: User | null,
  opts: { page: number; hasMore: boolean; firstIndex: number; watching: boolean },
): Html {
  const canSolve = user && (user.id === topic.user_id || user.is_admin);
  const isAdmin = Boolean(user?.is_admin);
  const here = opts.page > 1 ? `${topicUrl(topic)}?page=${opts.page}` : topicUrl(topic);
  const replies = topic.post_count - 1;
  const canReply = !opts.hasMore && !topic.locked;
  const signInToReply = `/signin?next=${encodeURIComponent(topicUrl(topic))}`;
  return html`<div class="topic">
    <header class="topic-head">
      <p class="kicker">${categoryBadge({ id: topic.category_id, slug: topic.category_slug, name: topic.category_name, archived: topic.category_archived })}${topic.category_archived ? html`<span class="label label-archived">${icon("archive", { size: 16 })}Archive</span>` : ""}${topic.tender_id
        ? html`<span class="tag" title="This topic was moved here from the old forum">From the old forum</span>`
        : ""}</p>
      <h1>${topic.title}</h1>
      <div class="topic-bar">
        <p class="topic-facts">
          ${opts.page > 1 ? html`<span>Started by ${topic.author_name} ${time(topic.created_at)}</span>` : ""}
          <span>${replies === 0 ? "No replies yet" : replies === 1 ? "1 reply" : `${replies} replies`}</span>
          ${replies > 0 ? html`<span>Last reply ${time(topic.last_post_at)}</span>` : ""}
          ${statusLabels(topic)}
        </p>
        <div class="topic-actions">
          ${canReply ? html`<a class="button button-primary" href="${user ? "#reply" : signInToReply}">${icon("reply", { size: 16 })}Reply</a>` : ""}
          ${user ? watchForm(topic, opts.watching) : ""}
          ${feedButton(`/feeds/t/${topic.id}`, "Follow replies to this topic by RSS")}
        </div>
      </div>
      ${isAdmin ? topicModBar(topic) : ""}
    </header>

    <ol class="posts" start="${opts.firstIndex + 1}">
      ${posts.map(
        (p) => html`<li class="post${p.post.status !== "visible" ? " post-hidden" : ""}" id="post-${p.post.id}">
          <div class="post-avatar">${avatar({ id: p.post.user_id, name: p.post.author_name })}</div>
          <article class="post-main">
            <header class="post-head">
              <span class="avatar-inline">${avatar({ id: p.post.user_id, name: p.post.author_name }, "sm")}</span>
              <span class="post-author">${p.post.author_name}</span>
              ${p.post.author_is_admin ? html`<span class="tag tag-team">NodeBox team</span>` : ""}
              <a class="post-time" href="#post-${p.post.id}">${time(p.post.created_at)}</a>
            </header>
            <div class="prose" data-post-body data-author="${p.post.author_name}">${raw(p.html)}</div>
            ${gallery(p.images)}
            ${p.media.map(mediaItem)}
            ${p.files.length ? html`<ul class="files">${p.files.map(fileCard)}</ul>` : ""}
            <footer class="post-actions">
              ${p.post.status === "visible"
                ? html`${reactionBar(p.post, p.reactions, user)}
                    ${user && canReply ? html`<button type="button" class="action" data-quote>${icon("quote", { size: 18 })}<span>Quote</span></button>` : ""}
                    <a class="action" href="#post-${p.post.id}" data-copy-link title="Copy a link to this post">${icon("link", { size: 18 })}<span>Copy link</span></a>`
                : ""}
              ${isAdmin ? postModMenu(p.post, here) : ""}
            </footer>
          </article>
        </li>`,
      )}
    </ol>

    ${lightbox()}

    <div class="topic-foot">
      ${pager(topicUrl(topic), opts.page, opts.hasMore)}
      ${opts.hasMore
        ? ""
        : topic.locked
          ? html`<p class="empty">${icon("lock", { size: 16 })} This topic is locked.</p>`
          : user
            ? html`<section class="reply" id="reply" aria-labelledby="reply-h">
                <div class="post-avatar">${avatar(user)}</div>
                <div class="post-main">
                  <h2 id="reply-h" class="section-title">Your reply</h2>
                  ${composer({ action: `/t/${topic.id}/reply`, submitLabel: "Post reply" })}
                </div>
              </section>`
            : html`<section class="reply-prompt">
                <h2>Know something that helps?</h2>
                <p>Sign in with your email address to reply. No password needed.</p>
                <a class="button button-primary" href="${signInToReply}">${icon("log-in", { size: 16 })}Sign in to reply</a>
              </section>`}
    </div>
  </div>`;
}

function watchForm(topic: TopicRow, watching: boolean): Html {
  return html`<form method="post" action="/t/${topic.id}/watch" class="watch-form">
    <input type="hidden" name="watch" value="${watching ? "0" : "1"}">
    <button type="submit" class="button button-quiet watch${watching ? " on" : ""}" aria-pressed="${watching ? "true" : "false"}"
      title="${watching ? "You get an email digest when people reply. Click to stop." : "Get an email digest when people reply."}">
      ${icon(watching ? "eye" : "eye-off", { size: 16 })}${watching ? "Watching" : "Watch"}
    </button>
  </form>`;
}

export function yourTopicsPage(topics: YourThread[], digest: boolean): Html {
  return html`
    ${mainHead({
      title: "Your topics",
      lede: digest
        ? html`Topics you started, replied to or watch. New replies in watched topics reach you as one email a day at most.`
        : html`Topics you started, replied to or watch. Email digests are off; turn them on in <a href="/settings">Settings</a>.`,
    })}
    ${topics.length === 0
      ? html`<p class="empty">Nothing here yet. Start a topic or reply to one and it shows up here.</p>`
      : topicTable(topics, {
          showCategory: true,
          href: (t) => (t.new_posts > 0 ? `/t/${t.id}/unread` : topicUrl(t)),
          unread: (t) => t.new_posts > 0,
          meta: (t) => html`${t.new_posts > 0 ? html`<span class="tag tag-new">${t.new_posts} new</span>` : ""}
              <span>${t.started ? "You started this" : "You replied"}</span>
              ${t.watching ? html`<span class="label">${icon("eye", { size: 16 })}Watching</span>` : ""}`,
        })}`;
}

export function composer(opts: { action: string; submitLabel: string; body?: string; titleField?: Html; error?: string }): Html {
  return html`<form class="composer" method="post" action="${opts.action}" data-composer>
    ${opts.error ? html`<p class="form-error" role="alert">${opts.error}</p>` : ""}
    ${opts.titleField ?? ""}
    <div class="editor" data-dropzone>
      <div class="editor-tabs" role="tablist">
        <button type="button" role="tab" aria-selected="true" data-tab="write">Write</button>
        <button type="button" role="tab" aria-selected="false" data-tab="preview">Preview</button>
      </div>
      <label class="visually-hidden" for="body">Message</label>
      <textarea id="body" name="body" rows="8" required maxlength="50000"
        placeholder="Write your message. Drag in a project ZIP or paste a screenshot.">${opts.body ?? ""}</textarea>
      <div class="preview prose" data-preview hidden></div>
      <ul class="uploads" data-uploads></ul>
      <div class="editor-foot">
        <label class="attach">
          <input type="file" multiple data-file-input>
          <span>${icon("paperclip", { size: 16 })}Attach files</span>
        </label>
        <span class="hint">Markdown works: **bold**, \`code\`, [links](https://…). Up to 50 MB per file.</span>
      </div>
      <div class="drop-overlay" aria-hidden="true"><span>Drop files to attach</span></div>
    </div>
    <div class="composer-actions">
      <button class="button button-primary" type="submit">${opts.submitLabel}</button>
    </div>
  </form>`;
}

export function newTopicPage(categories: Category[], selected: string | undefined, values: { title?: string; body?: string; error?: string }): Html {
  const titleField = html`<div class="field">
      <label for="title">Title</label>
      <input id="title" name="title" required maxlength="160" value="${values.title ?? ""}" placeholder="What is your question or project about?" autocomplete="off">
    </div>
    <div class="field">
      <label for="category">Category</label>
      <select id="category" name="category" required>
        ${categories.map((c) => html`<option value="${c.slug}" ${c.slug === selected ? "selected" : ""}>${c.name}</option>`)}
      </select>
    </div>`;
  return html`${mainHead({ title: "New topic" })}
    ${composer({ action: "/new", submitLabel: "Post topic", body: values.body, titleField, error: values.error })}`;
}

export function signInPage(opts: { next: string; google: boolean; error?: string; email?: string }): Html {
  return html`<div class="auth-card">
    <h1>Sign in or join</h1>
    <p class="lede">No password needed.</p>
    ${opts.error ? html`<p class="form-error" role="alert">${opts.error}</p>` : ""}
    ${opts.google
      ? html`<a class="button button-google" href="/auth/google?next=${encodeURIComponent(opts.next)}">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#4285F4" d="M22.6 12.3c0-.8-.1-1.6-.2-2.3H12v4.3h5.9a5 5 0 0 1-2.2 3.3v2.8h3.6c2.1-1.9 3.3-4.8 3.3-8.1z"/><path fill="#34A853" d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.8c-1 .7-2.2 1.1-3.7 1.1-2.9 0-5.3-1.9-6.2-4.5H2.1v2.9A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.8 14.1a6.6 6.6 0 0 1 0-4.2V7H2.1a11 11 0 0 0 0 10l3.7-2.9z"/><path fill="#EA4335" d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.2-3.2A11 11 0 0 0 2.1 7l3.7 2.9C6.7 7.3 9.1 5.4 12 5.4z"/></svg>
          Continue with Google</a>
        <p class="or"><span>or</span></p>`
      : ""}
    <form method="post" action="/signin/email" class="stack">
      <input type="hidden" name="next" value="${opts.next}">
      <div class="field">
        <label for="email">Email address</label>
        <input id="email" name="email" type="email" required autocomplete="email" value="${opts.email ?? ""}" placeholder="you@example.com">
      </div>
      <button class="button ${opts.google ? "button-quiet" : "button-primary"}" type="submit">Email me a sign-in link</button>
    </form>
    <div class="callout">
      <strong>Coming from the old forum?</strong>
      Your account and posts moved here. Sign in with the email address you used there and they're yours again.
    </div>
  </div>`;
}

export function checkEmailPage(email: string, devLink: string | null): Html {
  return html`<div class="auth-card">
    <h1>Check your email</h1>
    <p class="lede">We sent a sign-in link to <strong>${email}</strong>. It works for 15 minutes.</p>
    <p class="muted">Nothing there? Check your spam folder, or <a href="/signin">try again</a>.</p>
    ${devLink ? html`<p class="callout"><strong>Development:</strong> <a href="${devLink}">open the sign-in link</a></p>` : ""}
  </div>`;
}

export function confirmSignInPage(email: string, token: string): Html {
  return html`<div class="auth-card">
    <h1>Sign in</h1>
    <p class="lede">Continue as <strong>${email}</strong>?</p>
    <form method="post" action="/signin/verify">
      <input type="hidden" name="token" value="${token}">
      <button class="button button-primary" type="submit">Sign in</button>
    </form>
  </div>`;
}

export function profileForm(opts: {
  heading: string;
  intro: Html | string;
  name: string;
  next: string;
  submit: string;
  error?: string;
  /** Show the email digest setting (Settings page only). */
  digest?: boolean;
}): Html {
  return html`<div class="auth-card">
    <h1>${opts.heading}</h1>
    <p class="lede">${opts.intro}</p>
    ${opts.error ? html`<p class="form-error" role="alert">${opts.error}</p>` : ""}
    <form method="post" action="/settings" class="stack">
      <input type="hidden" name="next" value="${opts.next}">
      <div class="field">
        <label for="name">Display name</label>
        <input id="name" name="name" required maxlength="60" value="${opts.name}" autocomplete="nickname">
        <p class="hint">Shown next to your posts. Your email stays private.</p>
      </div>
      ${opts.digest === undefined
        ? ""
        : html`<input type="hidden" name="has_digest" value="1">
            <label class="check">
              <input type="checkbox" name="email_digest" value="1" ${opts.digest ? "checked" : ""}>
              <span><strong>Email me about new replies</strong><br><span class="hint">In topics you started or watch. One email a day at most, listing every topic with news.</span></span>
            </label>`}
      <button class="button button-primary" type="submit">${opts.submit}</button>
    </form>
  </div>`;
}

export function messagePage(heading: string, message: string | Html, action?: { href: string; label: string }): Html {
  return html`<div class="auth-card">
    <h1>${heading}</h1>
    <p class="lede">${message}</p>
    ${action ? html`<a class="button button-primary" href="${action.href}">${action.label}</a>` : ""}
  </div>`;
}

/** Shown when the spam filter refuses a post. It gives no reason, so it teaches nothing about what to change. */
export function refusedPage(): Html {
  return messagePage(
    "Your post was not posted",
    html`Our spam filter thinks it is spam, so nobody else can see it. If that is a mistake, write to
      <a href="mailto:info@nodebox.net">info@nodebox.net</a> and a person will look at it.`,
    { href: "/", label: "Back to the forum" },
  );
}

export function aupPage(): Html {
  return html`<article class="prose narrow-prose">
    <h1>Acceptable use</h1>
    <p>The NodeBox forum is a shared space for people who use NodeBox. By posting here you agree to these few rules. They are short on purpose.</p>
    <h2>1. Be respectful</h2>
    <p>No harassment, personal attacks, threats, or hateful content about anyone's identity. Disagree with ideas, not people.</p>
    <h2>2. No spam or advertising</h2>
    <p>No unsolicited promotion, link farming, phishing, or posts that exist only to sell something. Sharing your own NodeBox work is welcome.</p>
    <h2>3. Only share what you may share</h2>
    <p>Post and attach only things you made or have the right to share. No pirated software, cracked licences, or other people's work passed off as yours.</p>
    <h2>4. No malware</h2>
    <p>Attachments must be safe to open: NodeBox projects, data, images and archives of those. Never upload anything meant to harm someone's computer.</p>
    <h2>5. Respect privacy</h2>
    <p>Don't post other people's personal information, such as addresses, phone numbers or private messages, without their consent.</p>
    <h2>6. Stay on topic</h2>
    <p>Keep posts about NodeBox, generative design and data visualisation, and related tools.</p>
    <h2>What happens when a rule is broken</h2>
    <p>Moderators can hide posts that break these rules and suspend accounts that keep doing so or that exist only to spam. Hidden posts are kept, not deleted, so a mistake can be undone. If you think we got it wrong, or you see something that breaks these rules, email <a href="mailto:info@nodebox.net">info@nodebox.net</a>.</p>
  </article>`;
}

export function guidelinesPage(): Html {
  return html`<article class="prose narrow-prose">
    <h1>Guidelines</h1>
    <p>This forum is for everyone who uses NodeBox, from first-time users to people who have built nodes for years. A few things keep it useful:</p>
    <ul>
      <li><strong>Share the project.</strong> When something doesn't work, attach the <code>.ndbx</code> file or a ZIP of the project folder with its data files. It is the fastest way to an answer.</li>
      <li><strong>Add a screenshot.</strong> Paste it straight into the message box.</li>
      <li><strong>One question per topic</strong>, with a title that says what it is about.</li>
      <li><strong>Be kind.</strong> Everyone was new once.</li>
    </ul>
    <p>The rules everyone agrees to are in the <a href="/aup">acceptable use policy</a>.</p>
  </article>`;
}

export function feedsPage(categories: Category[]): Html {
  const feed = (href: string, label: string) => html`<a href="${href}" type="application/rss+xml">${label}</a>`;
  const categoryItem = (c: Category) =>
    html`<li><strong>${c.name}</strong>: ${feed(`/feeds/c/${c.slug}`, "new topics")} or ${feed(`/feeds/c/${c.slug}/posts`, "every post")}</li>`;
  const archived = categories.filter((c) => c.archived);
  return html`<article class="prose narrow-prose">
    <h1>RSS feeds</h1>
    <p>Follow the forum in a feed reader, no account needed. Each feed carries the newest posts in full, with their pictures and attachments. Copy a link below into your reader, or give it the address of any forum page and it finds that page's feed by itself.</p>
    <h2>The whole forum</h2>
    <ul>
      <li>${feed("/feeds/topics", "New topics")}, in every category.</li>
      <li>${feed("/feeds/posts", "Every post")}, replies included. Busy, but nothing slips by.</li>
      <li>${feed("/feeds/unanswered", "Unanswered topics")}, for anyone who likes to help.</li>
    </ul>
    <h2>One category</h2>
    <ul>${categories.filter((c) => !c.archived).map(categoryItem)}</ul>
    ${archived.length ? html`<p>In the archive:</p><ul>${archived.map(categoryItem)}</ul>` : ""}
    <h2>One topic</h2>
    <p>Every topic has an RSS button next to Reply. Its feed brings the new replies, like watching the topic but without the email.</p>
    <h2>A search</h2>
    <p>Search for something and use the RSS button on the results to hear about new posts that mention it, for example ${feed("/feeds/search?q=csv", "posts about CSV")}.</p>
  </article>`;
}
