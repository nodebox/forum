import { html, raw } from "hono/html";
import type { Category, User } from "../db.ts";
import { hueFor, initials } from "../util.ts";
import { icon } from "./icons.ts";

export type Html = ReturnType<typeof html>;

const SOURCE_URL = "https://github.com/nodebox/forum";

export interface LayoutProps {
  title?: string;
  description?: string;
  user: User | null;
  notice?: string | null;
  /** A standing message on every page, such as read-only mode. */
  alert?: string | null;
  showBanner?: boolean;
  /** Path of the current page, used for "sign in" return links and the active sidebar item. */
  path: string;
  siteName: string;
  /** Categories for the sidebar. */
  categories: Category[];
  /** Open questions, counted in the sidebar. */
  unanswered: number;
  /** The search box's current query, on the search page. */
  query?: string;
  /** Extra class on <main>, e.g. "narrow". */
  mainClass?: string;
  /** "light" or "dark" when the visitor picked one with the header button; otherwise the device decides. */
  theme?: "light" | "dark" | null;
  /** RSS feeds offered to browsers and feed readers, this page's own first. */
  feeds?: { title: string; href: string }[];
  /** Git commit this deploy was built from, shown in the footer. */
  commit?: string | null;
}

/** The NodeBox Live mark (logo.svg from Frederik), drawn in the current text colour. */
const logo = raw(`<svg class="logo-mark" viewBox="0 0 300 300" aria-hidden="true"><path fill="currentColor" d="M72.5,147.1L41.2,133V57.3l68.7-30.2l68.3,30.1v75.7L146.7,147c-5.1,2.3-8.3,7.7-7.3,13.2c1.2,6.1,6.3,9.9,11.8,9.9 c1.6,0,3.3-0.3,4.9-1.1l38.9-17.5c4.3-1.9,7-6.2,7-10.9V49.3c0-4.7-2.8-9-7.1-10.9L114.6,3c-3.1-1.3-6.6-1.4-9.6,0L24.3,38.4 c-4.3,1.9-7.1,6.2-7.1,10.9v91.3c0,4.7,2.8,9,7,10.9L63.1,169c6.7,3,14.7-0.6,16.5-8.1C81.2,155.4,77.8,149.5,72.5,147.1z M275.7,147.5L236.8,130c-6.7-3-14.7,0.6-16.5,8.1c-1.4,5.7,1.9,11.5,7.2,13.9l31.4,14.1v75.8L190.5,273l-68.7-30.1V89.1 c0-4.7-2.7-8.9-6.9-10.8L77.3,60.9c-4.7-2.2-10.5-1.4-14,2.4c-5.8,6.4-3.4,15.8,3.7,19.1l31,14.3v154c0,4.7,2.8,9,7.1,10.9 l80.7,35.4c1.5,0.7,3.2,1,4.8,1c1.7,0,3.4-0.4,4.9-1.1l80.3-36.5c4.3-1.9,7-6.2,7-10.9v-91.3C282.7,153.6,279.9,149.4,275.7,147.5z"/></svg>`);

/** Category colours, picked by category id. Muted, so the coloured square stays a marker. */
const CATEGORY_COLOURS = ["#0072bc", "#b8703d", "#3f7d5a", "#7a5c99", "#00a3d4", "#9a4f5f", "#5c6b80"];
export const categoryColour = (id: number) => CATEGORY_COLOURS[id % CATEGORY_COLOURS.length]!;

/** The coloured square of an active category; archived categories get an empty grey one. */
export function categoryMark(c: { id: number; archived?: number }): Html {
  return c.archived
    ? html`<span class="cat-sq cat-sq-archived" aria-hidden="true"></span>`
    : html`<span class="cat-sq" style="--cat:${categoryColour(c.id)}" aria-hidden="true"></span>`;
}

export function categoryBadge(c: { id: number; slug: string; name: string; archived?: number }): Html {
  return html`<a class="cat" href="/c/${c.slug}">${categoryMark(c)}${c.name}</a>`;
}

export function avatar(user: { id: number; name: string }, size: "sm" | "md" = "md"): Html {
  return html`<span class="avatar avatar-${size}" style="--hue:${hueFor(user.id)}" aria-hidden="true">${initials(user.name)}</span>`;
}

function sidebar(props: LayoutProps): Html {
  const here = props.path.split("?")[0];
  const item = (href: string, label: string, ico: Html, opts: { external?: boolean; count?: number } = {}) =>
    html`<li><a href="${href}" class="side-link${here === href ? " active" : ""}" ${here === href ? raw('aria-current="page"') : ""} ${opts.external ? raw('rel="noopener"') : ""}>${ico}<span class="side-label">${label}</span>${opts.count ? html`<span class="side-count">${opts.count}</span>` : ""}</a></li>`;
  const categoryLink = (c: Category) =>
    html`<li><a href="/c/${c.slug}" class="side-link${here === `/c/${c.slug}` ? " active" : ""}" ${here === `/c/${c.slug}` ? raw('aria-current="page"') : ""}>
      ${categoryMark(c)}<span class="side-label">${c.name}</span>
    </a></li>`;
  const archived = props.categories.filter((c) => c.archived);
  return html`<nav class="sidebar" id="sidebar" aria-label="Forum">
    <ul class="side-list">
      ${item("/", "Latest", icon("messages-square"))}
      ${item("/unanswered", "Unanswered", icon("circle-help"), { count: props.unanswered })}
      ${props.user ? item("/topics/mine", "Your topics", icon("bell")) : ""}
      ${props.user?.is_admin ? item("/admin", "Moderation", icon("shield")) : ""}
    </ul>
    <h2 class="side-head">Categories</h2>
    <ul class="side-list">${props.categories.filter((c) => !c.archived).map(categoryLink)}</ul>
    ${archived.length
      ? html`<h2 class="side-head">Archive</h2>
          <ul class="side-list side-archive">${archived.map(categoryLink)}</ul>`
      : ""}
    <h2 class="side-head">Help</h2>
    <ul class="side-list">
      ${item("/guidelines", "Guidelines", icon("file-text"))}
      ${item("https://www.nodebox.net/node/", "Documentation", icon("book-open"), { external: true })}
      ${item("/aup", "Acceptable use", icon("scale"))}
      ${item("/feeds", "RSS feeds", icon("rss"))}
      ${item("https://www.nodebox.net/", "nodebox.net", icon("external-link"), { external: true })}
    </ul>
  </nav>`;
}

export function layout(props: LayoutProps, content: Html): Html {
  const title = props.title ? `${props.title} · ${props.siteName}` : props.siteName;
  const signInHref = `/signin?next=${encodeURIComponent(props.path)}`;
  return html`<!doctype html>
<html lang="en"${props.theme ? raw(` data-theme="${props.theme}"`) : ""}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  ${props.description ? html`<meta name="description" content="${props.description}">` : ""}
  <meta name="color-scheme" content="light dark">
  <link rel="preload" href="/fonts/atkinson-hyperlegible-next-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/styles.css">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  ${(props.feeds ?? []).map((f) => html`<link rel="alternate" type="application/rss+xml" title="${f.title}" href="${f.href}">\n  `)}
  <script type="module" src="/app.js"></script>
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <header class="site-header">
    <div class="wrap grid header-row">
      <div class="header-brand">
        <button type="button" class="icon-button nav-toggle" data-nav-toggle aria-controls="sidebar" aria-expanded="false" aria-label="Menu">${icon("menu", { size: 20 })}</button>
        <a class="brand" href="/">${logo}<span class="brand-word">NodeBox</span><span class="brand-sub">Forum</span></a>
      </div>
      <form class="search" role="search" method="get" action="/search">
        <label class="visually-hidden" for="search-q">Search the forum</label>
        ${icon("search", { size: 18 })}
        <input id="search-q" name="q" type="search" value="${props.query ?? ""}" placeholder="Search questions and answers" autocomplete="off">
      </form>
      <nav class="header-nav" aria-label="Account">
        <button type="button" class="icon-button header-icon theme-toggle" data-theme-toggle aria-label="Switch between light and dark" title="Switch between light and dark">${icon("moon", { size: 20, class: "icon-moon" })}${icon("sun", { size: 20, class: "icon-sun" })}</button>
        ${props.user
          ? html`<a class="icon-button header-icon" href="/topics/mine" aria-label="Your topics" title="Your topics">${icon("bell", { size: 20 })}</a>
              <details class="user-menu">
                <summary aria-label="Account menu">${avatar(props.user, "sm")}</summary>
                <div class="user-menu-panel">
                  <p class="user-menu-who"><strong>${props.user.name}</strong><span>${props.user.email}</span></p>
                  <a href="/topics/mine">${icon("bell", { size: 16 })}Your topics</a>
                  <a href="/settings">${icon("settings", { size: 16 })}Settings</a>
                  ${props.user.is_admin ? html`<a href="/admin">${icon("shield", { size: 16 })}Moderation</a>` : ""}
                  <form method="post" action="/signout"><button type="submit" class="linklike">${icon("log-out", { size: 16 })}Sign out</button></form>
                </div>
              </details>`
          : html`<a class="button button-light" href="${signInHref}">${icon("log-in", { size: 16 })}<span>Sign in</span></a>`}
      </nav>
    </div>
  </header>
  <div class="wrap grid shell">
    ${sidebar(props)}
    <main id="main" class="main ${props.mainClass ?? ""}">
      ${props.alert ? html`<p class="welcome alert" role="status">${icon("lock", { size: 18 })}<span>${props.alert}</span></p>` : ""}
      ${props.showBanner && !props.alert
        ? html`<aside class="welcome" data-banner aria-label="About this forum">
            <p><strong>Welcome to the new NodeBox forum.</strong>
            Had an account on the old one? <a href="${signInHref}">Sign in with the same email</a> and your posts are waiting for you.</p>
            <button type="button" class="icon-button" data-dismiss-banner aria-label="Dismiss">${icon("x", { size: 18 })}</button>
          </aside>`
        : ""}
      ${props.notice ? html`<p class="notice" role="status">${icon("circle-check", { size: 18 })}<span>${props.notice}</span></p>` : ""}
      ${content}
    </main>
  </div>
  <footer class="site-footer">
    <div class="wrap grid">
      <p>The NodeBox forum. Built by <a href="https://algorithmicgaze.com/">the Algorithmic Gaze</a>, our research group.
        The forum is <a href="${SOURCE_URL}">open source</a>${props.commit
          ? html`; this is version <a class="commit" href="${SOURCE_URL}/commit/${props.commit}">${props.commit.slice(0, 7)}</a>`
          : ""}.</p>
    </div>
  </footer>
</body>
</html>`;
}
