import { html, raw } from "hono/html";
import { REACTIONS, type Attachment, type Category, type PostRow, type ReactionSummary, type TopicRow, type User } from "../db.ts";
import { fileKind, fileUrl } from "../files.ts";
import { formatBytes, timeAgo } from "../util.ts";
import { avatar, type Html } from "./layout.ts";
import { postModMenu, topicModBar } from "./admin.ts";

const time = (iso: string) => html`<time datetime="${iso}" title="${new Date(iso).toUTCString()}">${timeAgo(iso)}</time>`;

export const topicUrl = (t: { id: number; slug: string }) => `/t/${t.id}/${t.slug}`;

function topicBadges(t: TopicRow): Html {
  return html`${t.pinned ? html`<span class="badge badge-pinned">Pinned</span>` : ""}${t.solved ? html`<span class="badge badge-solved">Solved</span>` : ""}${t.locked ? html`<span class="badge">Locked</span>` : ""}`;
}

function topicList(topics: TopicRow[], opts: { showCategory: boolean }): Html {
  if (topics.length === 0) return html`<p class="empty">No topics yet. Be the first to start one.</p>`;
  return html`<ol class="topic-list">
    ${topics.map(
      (t) => html`<li class="topic-item">
        <div class="topic-main">
          <a class="topic-title" href="${topicUrl(t)}">${t.title}</a>
          <div class="topic-meta">
            ${topicBadges(t)}
            ${opts.showCategory ? html`<a class="chip" href="/c/${t.category_slug}">${t.category_name}</a>` : ""}
            <span>${t.author_name}</span>
          </div>
        </div>
        <div class="topic-stats">
          <span class="replies" title="${t.post_count - 1} replies"><span class="count">${t.post_count - 1}</span><span class="visually-hidden"> replies</span></span>
          <span class="activity">${time(t.last_post_at)}</span>
        </div>
      </li>`,
    )}
  </ol>`;
}

function pager(base: string, page: number, hasMore: boolean): Html {
  if (page <= 1 && !hasMore) return html``;
  const href = (p: number) => (p <= 1 ? base : `${base}?page=${p}`);
  return html`<nav class="pager" aria-label="Pages">
    ${page > 1 ? html`<a class="button button-quiet" href="${href(page - 1)}">← Newer</a>` : html`<span></span>`}
    <span class="muted">Page ${page}</span>
    ${hasMore ? html`<a class="button button-quiet" href="${href(page + 1)}">Older →</a>` : html`<span></span>`}
  </nav>`;
}

export function homePage(categories: Category[], latest: TopicRow[], page: number, hasMore: boolean, signedIn: boolean): Html {
  return html`
    ${page === 1
      ? html`<section class="hero">
          <h1>Ask, share, and learn NodeBox together.</h1>
          <p class="lede">Questions about NodeBox 3, projects you made, bugs you found. Drop a project ZIP or a screenshot right into your post.</p>
          ${signedIn ? html`<a class="button button-accent" href="/new">Start a topic</a>` : html`<a class="button button-accent" href="/signin?next=/new">Start a topic</a>`}
        </section>
        <section aria-labelledby="cats-h">
          <h2 id="cats-h" class="section-title">Categories</h2>
          <ul class="category-grid">
            ${categories.map(
              (c) => html`<li><a class="category-card" href="/c/${c.slug}">
                <span class="category-name">${c.name}</span>
                ${c.description ? html`<span class="category-desc">${c.description}</span>` : ""}
                <span class="category-count">${c.topic_count} ${c.topic_count === 1 ? "topic" : "topics"}</span>
              </a></li>`,
            )}
          </ul>
        </section>`
      : ""}
    <section aria-labelledby="latest-h">
      <h2 id="latest-h" class="section-title">Latest</h2>
      ${topicList(latest, { showCategory: true })}
      ${pager("/", page, hasMore)}
    </section>`;
}

export function categoryPage(category: Category, topics: TopicRow[], page: number, hasMore: boolean): Html {
  return html`
    <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Forum</a></nav>
    <div class="page-head">
      <div>
        <h1>${category.name}</h1>
        ${category.description ? html`<p class="lede">${category.description}</p>` : ""}
      </div>
      <a class="button button-accent" href="/new?category=${category.slug}">New topic</a>
    </div>
    ${topicList(topics, { showCategory: false })}
    ${pager(`/c/${category.slug}`, page, hasMore)}`;
}

export interface RenderedPost {
  post: PostRow;
  html: string;
  /** Attachments not shown inline in the body. */
  files: Attachment[];
  /** Images not referenced in the body (shown as a gallery). */
  images: { a: Attachment; thumb: string; full: string }[];
  reactions: ReactionSummary[];
}

function reactionBar(post: PostRow, reactions: ReactionSummary[], user: User | null): Html {
  const byEmoji = new Map(reactions.map((r) => [r.emoji, r]));
  return html`<form class="reactions" method="post" action="/posts/${post.id}/react" data-reactions>
    ${REACTIONS.map((emoji) => {
      const r = byEmoji.get(emoji);
      const label = r ? `${r.names} reacted ${emoji}` : `React ${emoji}`;
      return html`<button type="submit" name="emoji" value="${emoji}"
        class="reaction${r ? " has" : ""}${r?.mine ? " mine" : ""}"
        aria-pressed="${r?.mine ? "true" : "false"}" title="${label}" ${user ? "" : raw('data-needs-signin')}>
        <span class="emoji">${emoji}</span><span class="reaction-count">${r ? r.count : ""}</span>
      </button>`;
    })}
  </form>`;
}

function fileCard(a: Attachment): Html {
  const kind = fileKind(a);
  const label = kind === "nodebox" ? "NodeBox project" : kind === "zip" ? "ZIP archive" : a.content_type;
  return html`<li><a class="file-card file-${kind}" href="${fileUrl(a)}" download>
    <span class="file-icon" aria-hidden="true">${kind === "nodebox" ? "◆" : kind === "zip" ? "▤" : "▢"}</span>
    <span class="file-text"><span class="file-name">${a.filename}</span><span class="file-meta">${label} · ${formatBytes(a.size)}</span></span>
    <span class="file-dl" aria-hidden="true">↓</span>
  </a></li>`;
}

export function topicPage(
  topic: TopicRow,
  posts: RenderedPost[],
  user: User | null,
  opts: { page: number; hasMore: boolean; firstIndex: number },
): Html {
  const canSolve = user && (user.id === topic.user_id || user.is_admin);
  const isAdmin = Boolean(user?.is_admin);
  const here = opts.page > 1 ? `${topicUrl(topic)}?page=${opts.page}` : topicUrl(topic);
  return html`
    <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Forum</a> <span aria-hidden="true">/</span> <a href="/c/${topic.category_slug}">${topic.category_name}</a></nav>
    <div class="topic-head">
      <h1>${topic.title}</h1>
      <p class="topic-sub">${topicBadges(topic)}${topic.tender_id ? html`<span class="badge badge-legacy" title="This topic was moved here from the old forum">From the old forum</span>` : ""}</p>
    </div>
    ${isAdmin ? topicModBar(topic) : ""}
    <ol class="posts" start="${opts.firstIndex + 1}">
      ${posts.map(
        (p) => html`<li class="post${p.post.status !== "visible" ? " post-hidden" : ""}" id="post-${p.post.id}">
          <div class="post-side">${avatar({ id: p.post.user_id, name: p.post.author_name })}</div>
          <article class="post-body">
            <header class="post-head">
              <span class="post-author">${p.post.author_name}</span>
              ${p.post.author_is_admin ? html`<span class="badge badge-team">NodeBox team</span>` : ""}
              <a class="post-time" href="#post-${p.post.id}">${time(p.post.created_at)}</a>
            </header>
            <div class="prose">${raw(p.html)}</div>
            ${p.images.length
              ? html`<ul class="gallery">${p.images.map((img) => html`<li><a href="${img.full}" target="_blank" rel="noopener"><img src="${img.thumb}" alt="${img.a.filename}" loading="lazy"></a></li>`)}</ul>`
              : ""}
            ${p.files.length ? html`<ul class="files">${p.files.map(fileCard)}</ul>` : ""}
            <footer class="post-foot">
              ${p.post.status === "visible" ? reactionBar(p.post, p.reactions, user) : html`<span></span>`}
              ${isAdmin ? postModMenu(p.post, here) : ""}
            </footer>
          </article>
        </li>`,
      )}
    </ol>
    ${pager(topicUrl(topic), opts.page, opts.hasMore)}
    ${canSolve
      ? html`<form method="post" action="/t/${topic.id}/solved" class="solve-form">
          <button class="button button-quiet" type="submit" name="solved" value="${topic.solved ? "0" : "1"}">${topic.solved ? "Mark as not solved" : "✓ Mark as solved"}</button>
        </form>`
      : ""}
    ${opts.hasMore
      ? ""
      : topic.locked
        ? html`<p class="empty">This topic is locked.</p>`
        : user
          ? html`<section class="reply" aria-labelledby="reply-h">
              <h2 id="reply-h" class="section-title">Your reply</h2>
              ${composer({ action: `/t/${topic.id}/reply`, submitLabel: "Post reply" })}
            </section>`
          : html`<p class="signin-prompt"><a class="button button-accent" href="/signin?next=${encodeURIComponent(topicUrl(topic))}">Sign in to reply</a></p>`}`;
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
          <span>📎 Attach files</span>
        </label>
        <span class="hint">Markdown works: **bold**, \`code\`, [links](https://…). Up to 50 MB per file.</span>
      </div>
      <div class="drop-overlay" aria-hidden="true"><span>Drop files to attach</span></div>
    </div>
    <div class="composer-actions">
      <button class="button button-accent" type="submit">${opts.submitLabel}</button>
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
  return html`<h1>New topic</h1>
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
      <button class="button ${opts.google ? "button-quiet" : "button-accent"}" type="submit">Email me a sign-in link</button>
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
      <button class="button button-accent" type="submit">Sign in</button>
    </form>
  </div>`;
}

export function profileForm(opts: { heading: string; intro: Html | string; name: string; next: string; submit: string; error?: string }): Html {
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
      <button class="button button-accent" type="submit">${opts.submit}</button>
    </form>
  </div>`;
}

export function messagePage(heading: string, message: string | Html, action?: { href: string; label: string }): Html {
  return html`<div class="auth-card">
    <h1>${heading}</h1>
    <p class="lede">${message}</p>
    ${action ? html`<a class="button button-accent" href="${action.href}">${action.label}</a>` : ""}
  </div>`;
}

export function guidelinesPage(): Html {
  return html`<article class="prose narrow-prose">
    <h1>Guidelines</h1>
    <p>This forum is for everyone who uses NodeBox, from first-time users to people who have built nodes for years. A few things keep it useful:</p>
    <ul>
      <li><strong>Share the project.</strong> When something doesn't work, attach the <code>.ndbx</code> file or a ZIP of the project folder with its data files. It is the fastest way to an answer.</li>
      <li><strong>Add a screenshot.</strong> Paste it straight into the message box.</li>
      <li><strong>One question per topic</strong>, with a title that says what it is about.</li>
      <li><strong>Mark it solved</strong> when you have your answer, so the next person finds it.</li>
      <li><strong>Be kind.</strong> Everyone was new once.</li>
    </ul>
  </article>`;
}
