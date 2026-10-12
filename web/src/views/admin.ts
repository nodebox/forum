import { html } from "hono/html";
import type { PostRow, TopicRow } from "../db.ts";
import { excerpt } from "../markdown.ts";
import { REMOVAL_REASONS, type AdminUserRow, type LogRow, type QueueItem } from "../moderation.ts";
import { timeAgo } from "../util.ts";
import type { Html } from "./layout.ts";

const STATUS_LABEL = { spam: "Marked as spam", removed: "Removed", visible: "" } as const;

/** The admin menu on a post (topic page). */
export function postModMenu(post: PostRow, returnTo: string): Html {
  if (post.status !== "visible") {
    return html`<div class="mod-hidden">
      <span class="badge badge-danger">${STATUS_LABEL[post.status]}</span>
      ${post.moderation_reason ? html`<span class="muted small">${post.moderation_reason}</span>` : ""}
      <form method="post" action="/admin/posts/${post.id}">
        <input type="hidden" name="return" value="${returnTo}">
        <button class="button button-small" name="action" value="restore">Restore</button>
      </form>
    </div>`;
  }
  return html`<details class="mod-menu">
    <summary class="button button-small button-quiet">Moderate</summary>
    <div class="mod-panel">
      <form method="post" action="/admin/posts/${post.id}" class="stack-sm">
        <input type="hidden" name="return" value="${returnTo}">
        <button class="button button-small button-danger" name="action" value="spam">Mark as spam</button>
        <label class="check"><input type="checkbox" name="ban" value="1"> Also ban ${post.author_name} and hide all their posts</label>
      </form>
      <form method="post" action="/admin/posts/${post.id}" class="stack-sm">
        <input type="hidden" name="return" value="${returnTo}">
        <label for="reason-${post.id}" class="small">Remove for breaking the <a href="/aup" target="_blank">acceptable use policy</a>:</label>
        <select id="reason-${post.id}" name="reason">${REMOVAL_REASONS.map((r) => html`<option>${r}</option>`)}</select>
        <button class="button button-small button-danger" name="action" value="remove">Remove post</button>
      </form>
    </div>
  </details>`;
}

export function topicModBar(topic: TopicRow): Html {
  return html`<div class="mod-bar">
    <span class="muted small">Admin:</span>
    <form method="post" action="/admin/topics/${topic.id}">
      <button class="button button-small button-quiet" name="action" value="${topic.pinned ? "unpin" : "pin"}">${topic.pinned ? "Unpin" : "Pin"}</button>
      <button class="button button-small button-quiet" name="action" value="${topic.locked ? "unlock" : "lock"}">${topic.locked ? "Unlock" : "Lock"}</button>
    </form>
    ${topic.status !== "visible" ? html`<span class="badge badge-danger">Hidden topic: ${STATUS_LABEL[topic.status]}</span>` : ""}
  </div>`;
}

function tabs(active: string): Html {
  const tab = (href: string, key: string, label: string) =>
    html`<a href="${href}" class="tab${active === key ? " active" : ""}" ${active === key ? 'aria-current="page"' : ""}>${label}</a>`;
  return html`<nav class="tabs" aria-label="Admin">
    ${tab("/admin", "spam", "Spam")}${tab("/admin?view=removed", "removed", "Removed")}${tab("/admin/users", "users", "People")}${tab("/admin/log", "log", "Log")}
  </nav>`;
}

function queueMeta(i: QueueItem, view: "spam" | "removed"): string {
  const who = i.moderator_name ? `${view === "spam" ? "marked" : "removed"} by ${i.moderator_name}` : "flagged by the spam filter";
  const when = i.moderated_at && i.moderator_name ? ` ${timeAgo(i.moderated_at)}` : "";
  const why = i.moderation_reason ? `: ${i.moderation_reason}` : "";
  return `by ${i.author_name}${i.author_banned ? " (banned)" : ""} · posted ${timeAgo(i.created_at)} · ${who}${when}${why}`;
}

export function queuePage(view: "spam" | "removed", items: QueueItem[]): Html {
  return html`<h1>Moderation</h1>
    ${tabs(view)}
    <p class="muted">${view === "spam"
      ? "Posts marked as spam, by an admin or by the spam filter during the import. They are hidden from everyone but admins. Restore anything that was caught by mistake."
      : "Posts removed for breaking the acceptable use policy. Only admins see them."}</p>
    ${items.length === 0
      ? html`<p class="empty">Nothing here.</p>`
      : html`<ul class="queue">
          ${items.map(
            (i) => html`<li class="queue-item">
              <div class="queue-main">
                <a class="queue-topic" href="/t/${i.topic_id}/${i.topic_slug}#post-${i.post_id}">${i.topic_title}</a>
                <p class="queue-excerpt">${excerpt(i.body, 280)}</p>
                <p class="muted small">${queueMeta(i, view)}</p>
              </div>
              <form method="post" action="/admin/posts/${i.post_id}" class="queue-actions">
                <input type="hidden" name="return" value="/admin${view === "removed" ? "?view=removed" : ""}">
                <button class="button button-small" name="action" value="restore">Restore</button>
              </form>
            </li>`,
          )}
        </ul>`}`;
}

export function usersPage(q: string, users: AdminUserRow[], selfId: number): Html {
  return html`<h1>Moderation</h1>
    ${tabs("users")}
    <form method="get" action="/admin/users" class="search-row">
      <label class="visually-hidden" for="q">Find people</label>
      <input id="q" name="q" type="search" value="${q}" placeholder="Name or email">
      <button class="button button-quiet" type="submit">Find</button>
    </form>
    ${q ? "" : html`<p class="muted">Showing admins and banned accounts. Search to find anyone else.</p>`}
    ${users.length === 0
      ? html`<p class="empty">Nobody found.</p>`
      : html`<table class="table">
          <thead><tr><th>Name</th><th>Email</th><th>Posts</th><th>Status</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
          <tbody>
            ${users.map(
              (u) => html`<tr>
                <td>${u.name}${u.tender_id ? html` <span class="muted small">(old forum)</span>` : ""}</td>
                <td class="small">${u.email ?? "—"}</td>
                <td>${u.post_count}</td>
                <td>${u.is_admin ? html`<span class="badge badge-team">Admin</span>` : ""}${u.banned_at ? html`<span class="badge badge-danger">Banned</span>` : ""}</td>
                <td class="row-actions">
                  ${u.id === selfId
                    ? html`<span class="muted small">You</span>`
                    : html`<form method="post" action="/admin/users/${u.id}">
                        <input type="hidden" name="return" value="/admin/users${q ? `?q=${encodeURIComponent(q)}` : ""}">
                        ${u.banned_at
                          ? html`<button class="button button-small button-quiet" name="action" value="unban">Unban</button>`
                          : html`${u.is_admin
                              ? html`<button class="button button-small button-quiet" name="action" value="revoke_admin">Remove admin</button>`
                              : html`<button class="button button-small button-quiet" name="action" value="grant_admin">Make admin</button>
                                  <button class="button button-small button-danger" name="action" value="ban">Ban</button>`}`}
                      </form>`}
                </td>
              </tr>`,
            )}
          </tbody>
        </table>`}`;
}

const ACTION_LABEL: Record<string, string> = {
  spam: "marked a post as spam",
  remove: "removed a post",
  restore: "restored a post",
  ban: "banned",
  unban: "unbanned",
  grant_admin: "made admin:",
  revoke_admin: "removed admin from",
  pin: "pinned a topic",
  unpin: "unpinned a topic",
  lock: "locked a topic",
  unlock: "unlocked a topic",
};

export function logPage(rows: LogRow[]): Html {
  return html`<h1>Moderation</h1>
    ${tabs("log")}
    ${rows.length === 0
      ? html`<p class="empty">No moderation yet.</p>`
      : html`<ul class="log">
          ${rows.map(
            (r) => html`<li>
              <span class="muted small">${timeAgo(r.created_at)}</span>
              <strong>${r.admin_name ?? "Command line"}</strong> ${ACTION_LABEL[r.action] ?? r.action}
              ${r.user_name ? html` ${r.user_name}` : ""}
              ${r.topic_id ? html` <a href="/t/${r.topic_id}${r.post_id ? `#post-${r.post_id}` : ""}">(view)</a>` : ""}
              ${r.reason ? html` <span class="muted">· ${r.reason}</span>` : ""}
            </li>`,
          )}
        </ul>`}`;
}
