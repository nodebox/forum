import { html, raw } from "hono/html";
import type { User } from "../db.ts";
import { hueFor, initials } from "../util.ts";

export type Html = ReturnType<typeof html>;

export interface LayoutProps {
  title?: string;
  description?: string;
  user: User | null;
  notice?: string | null;
  showBanner?: boolean;
  /** Path of the current page, used for "sign in" return links. */
  path: string;
  siteName: string;
  /** Extra class on <main>, e.g. "narrow". */
  mainClass?: string;
}

const logo = raw(`<svg class="logo-mark" viewBox="0 0 32 32" aria-hidden="true">
  <path d="M9 10 C 16 10, 16 22, 23 22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
  <rect x="3" y="5" width="10" height="10" rx="3" fill="var(--blue)"/>
  <rect x="19" y="17" width="10" height="10" rx="3" fill="var(--orange)"/>
</svg>`);

export function avatar(user: { id: number; name: string }, size: "sm" | "md" = "md"): Html {
  return html`<span class="avatar avatar-${size}" style="--hue:${hueFor(user.id)}" aria-hidden="true">${initials(user.name)}</span>`;
}

export function layout(props: LayoutProps, content: Html): Html {
  const title = props.title ? `${props.title} · ${props.siteName}` : props.siteName;
  const signInHref = `/signin?next=${encodeURIComponent(props.path)}`;
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  ${props.description ? html`<meta name="description" content="${props.description}">` : ""}
  <meta name="color-scheme" content="light dark">
  <link rel="preload" href="/fonts/atkinson-hyperlegible-next-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/styles.css">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <script type="module" src="/app.js"></script>
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  ${props.showBanner
    ? html`<div class="banner" data-banner>
        <p><strong>Welcome to the new NodeBox forum.</strong>
        Had an account on the old one? <a href="${signInHref}">Sign in with the same email</a> and your posts are waiting for you.</p>
        <button type="button" class="banner-close" data-dismiss-banner aria-label="Dismiss">×</button>
      </div>`
    : ""}
  <header class="site-header">
    <div class="wrap header-row">
      <a class="brand" href="/">${logo}<span>NodeBox <span class="brand-sub">Forum</span></span></a>
      <nav class="header-nav" aria-label="Main">
        ${props.user
          ? html`<a class="button button-accent" href="/new">New topic</a>
              <details class="user-menu">
                <summary aria-label="Account">${avatar(props.user, "sm")}<span class="user-menu-name">${props.user.name}</span></summary>
                <div class="user-menu-panel">
                  <p class="muted small">Signed in as<br>${props.user.email}</p>
                  <a href="/settings">Settings</a>
                  ${props.user.is_admin ? html`<a href="/admin">Moderation</a>` : ""}
                  <form method="post" action="/signout"><button type="submit" class="linklike">Sign out</button></form>
                </div>
              </details>`
          : html`<a class="button button-quiet" href="${signInHref}">Sign in</a>
              <a class="button button-accent" href="${signInHref}">Join</a>`}
      </nav>
    </div>
  </header>
  <main id="main" class="wrap ${props.mainClass ?? ""}">
    ${props.notice ? html`<p class="notice" role="status">${props.notice}</p>` : ""}
    ${content}
  </main>
  <footer class="site-footer">
    <div class="wrap">
      <p><a href="https://www.nodebox.net/">nodebox.net</a> · <a href="https://www.nodebox.net/node/">Documentation</a> · <a href="/guidelines">Guidelines</a></p>
    </div>
  </footer>
</body>
</html>`;
}
