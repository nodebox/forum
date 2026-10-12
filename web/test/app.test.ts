// Runs the Worker app in Node against local D1/R2 from wrangler's platform proxy.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPlatformProxy } from "wrangler";
import { app } from "../src/app.ts";
import { sendDigests } from "../src/notifications.ts";

const persist = fs.mkdtempSync(path.join(os.tmpdir(), "forum-test-"));
let proxy: Awaited<ReturnType<typeof getPlatformProxy>>;
let env: any;

before(async () => {
  proxy = await getPlatformProxy({ persist: { path: persist } });
  env = { ...(proxy.env as object), MAILER: "log", PUBLIC_URL: "http://localhost" };
  const dir = path.join(import.meta.dirname, "../migrations");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const schema = fs.readFileSync(path.join(dir, file), "utf8");
    for (const stmt of schema.split(/;\s*\n/).map((s) => s.replace(/--.*$/gm, "").trim()).filter(Boolean)) await env.DB.prepare(stmt).run();
  }
  await env.DB.prepare("INSERT INTO categories (id, slug, name) VALUES (1, 'questions', 'Questions')").run();
});
after(async () => {
  await proxy.dispose();
  fs.rmSync(persist, { recursive: true, force: true });
});

const ORIGIN = "http://localhost";
async function req(p: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method === "POST") headers.set("origin", ORIGIN);
  return app.request(ORIGIN + p, { ...init, headers, redirect: "manual" }, env);
}
const form = (o: Record<string, string>) => new URLSearchParams(o);

async function signIn(email: string): Promise<string> {
  const page = await (await req("/signin/email", { method: "POST", body: form({ email, next: "/" }) })).text();
  const token = /token=([A-Za-z0-9_-]+)/.exec(page)![1]!;
  // The GET only shows a button; the token still works afterwards.
  assert.equal((await req(`/signin/verify?token=${token}`)).status, 200);
  const res = await req("/signin/verify", { method: "POST", body: form({ token }) });
  assert.equal(res.status, 302);
  // A token works once.
  assert.equal((await req("/signin/verify", { method: "POST", body: form({ token }) })).status, 400);
  return /nbf_session=[^;]+/.exec(res.headers.get("set-cookie")!)![0];
}

test("sign in, post, react, moderate", async () => {
  // An imported user claims their account by email.
  await env.DB.prepare("INSERT INTO users (id, email, name, created_at, tender_id) VALUES (7, 'old@example.com', 'Old Timer', '2010-01-01', 77)").run();
  const old = await signIn("Old@Example.com");
  const me = await (await req("/settings", { cookie: old })).text();
  assert.match(me, /Old Timer/);

  const alice = await signIn("alice@example.com");
  let res = await req("/new", { method: "POST", cookie: alice, body: form({ title: "Hello <b>there</b>", category: "questions", body: "Hi <script>alert(1)</script> **bold**" }) });
  assert.equal(res.status, 302);
  const topicPath = res.headers.get("location")!;
  let html = await (await req(topicPath)).text();
  assert.match(html, /Hello &lt;b&gt;there&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /<strong>bold<\/strong>/);

  const topicId = Number(/\/t\/(\d+)/.exec(topicPath)![1]);
  res = await req(`/t/${topicId}/reply`, { method: "POST", cookie: old, body: form({ body: "Buy pills" }) });
  assert.equal(res.status, 302);
  const spamId = Number(/#post-(\d+)/.exec(res.headers.get("location")!)![1]);

  // Upload, then attach on reply.
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array([80, 75, 3, 4])], "project.zip", { type: "application/zip" }));
  const up = await (await req("/uploads", { method: "POST", cookie: alice, body: fd })).json() as any;
  assert.equal(up.isImage, false);
  await req(`/t/${topicId}/reply`, { method: "POST", cookie: alice, body: form({ body: "Here's the project", attachments: up.id }) });
  html = await (await req(topicPath)).text();
  assert.match(html, /project\.zip/);
  const dl = await req(`/files/${up.id}/project.zip`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get("content-disposition")!, /^attachment/);

  // Reactions toggle.
  const firstPost = Number(/id="post-(\d+)"/.exec(html)![1]);
  let r = await (await req(`/posts/${firstPost}/react`, { method: "POST", cookie: old, headers: { accept: "application/json" }, body: form({ emoji: "🎉" }) })).json() as any;
  assert.deepEqual(r.reactions.map((x: any) => [x.emoji, x.count, x.mine]), [["🎉", 1, true]]);
  r = await (await req(`/posts/${firstPost}/react`, { method: "POST", cookie: old, headers: { accept: "application/json" }, body: form({ emoji: "🎉" }) })).json() as any;
  assert.equal(r.reactions.length, 0);
  assert.equal((await req(`/posts/${firstPost}/react`, { method: "POST", cookie: old, headers: { accept: "application/json" }, body: form({ emoji: "💩" }) })).status, 400);

  // Non-admins can't moderate.
  assert.equal((await req("/admin", { cookie: alice })).status, 403);
  assert.equal((await req(`/admin/posts/${spamId}`, { method: "POST", cookie: alice, body: form({ action: "spam" }) })).status, 403);

  // Bootstrap an admin (what `npm run admin -- grant` does), then moderate.
  await env.DB.prepare("UPDATE users SET is_admin = 1 WHERE email = 'alice@example.com'").run();
  res = await req(`/admin/posts/${spamId}`, { method: "POST", cookie: alice, body: form({ action: "spam", ban: "1", return: topicPath }) });
  assert.equal(res.status, 302);
  html = await (await req(topicPath)).text();
  assert.doesNotMatch(html, /Buy pills/, "spam hidden from visitors");
  assert.match(await (await req(topicPath, { cookie: alice })).text(), /Buy pills/, "admins still see it");
  assert.match(await (await req("/admin", { cookie: alice })).text(), /Buy pills/);
  // The banned user's session is gone.
  assert.doesNotMatch(await (await req("/", { cookie: old })).text(), /Old Timer/);

  // Restore, and admins can promote others.
  await req(`/admin/posts/${spamId}`, { method: "POST", cookie: alice, body: form({ action: "restore" }) });
  assert.match(await (await req(topicPath)).text(), /Buy pills/);
  const bob = await signIn("bob@example.com");
  const bobId = (await env.DB.prepare("SELECT id FROM users WHERE email = 'bob@example.com'").first()).id;
  await req(`/admin/users/${bobId}`, { method: "POST", cookie: alice, body: form({ action: "grant_admin" }) });
  assert.equal((await req("/admin", { cookie: bob })).status, 200);

  // Removing the opening post hides the whole topic.
  await req(`/admin/posts/${firstPost}`, { method: "POST", cookie: alice, body: form({ action: "remove", reason: "Off-topic or duplicate" }) });
  assert.equal((await req(topicPath)).status, 404);
  assert.doesNotMatch(await (await req("/")).text(), /Hello &lt;b&gt;/);
  assert.match(await (await req("/admin/log", { cookie: bob })).text(), /removed a post/);
});

test("cross-site posts are rejected", async () => {
  const res = await app.request(ORIGIN + "/signout", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" } }, env);
  assert.equal(res.status, 403);
});

test("legacy URLs redirect", async () => {
  await env.DB.prepare("INSERT INTO users (id, name, created_at) VALUES (900, 'x', '2010')").run();
  await env.DB.prepare("INSERT INTO topics (id, category_id, user_id, title, slug, created_at, last_post_at) VALUES (4711, 1, 900, 'Old', 'old', '2010', '2010')").run();
  await env.DB.prepare("INSERT INTO legacy_redirects (path, topic_id) VALUES ('/discussions/problems/4711-old', 4711)").run();
  const res = await req("/discussions/problems/4711-old/");
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), "/t/4711/old");
});

test("watching, grouped digests, hearts, your topics", async () => {
  const sent: any[] = [];
  const mailEnv = { ...env, MAILER: "cloudflare", EMAIL: { send: async (m: any) => void sent.push(m) } };
  const ann = await signIn("ann@example.com");
  const bob = await signIn("bob@example.com");
  const topics: string[] = [];
  for (const title of ["First question", "Second question"]) {
    const res = await req("/new", { method: "POST", cookie: ann, body: form({ title, category: "questions", body: "Help?" }) });
    topics.push(res.headers.get("location")!);
  }
  const [t1, t2] = topics.map((t) => Number(/\/t\/(\d+)/.exec(t)![1]));

  // Starting a topic watches it.
  assert.match(await (await req(topics[0]!, { cookie: ann })).text(), /class="button button-quiet button-block watch on" aria-pressed="true">[\s\S]*?Watching\s*<\/button>/);
  // Nothing new yet, so no digest.
  await sendDigests(mailEnv);
  assert.equal(sent.filter((m) => m.to === "ann@example.com").length, 0);

  // Bob replies in both; Ann gets one email naming both topics.
  await req(`/t/${t1}/reply`, { method: "POST", cookie: bob, body: form({ body: "Try this" }) });
  await req(`/t/${t2}/reply`, { method: "POST", cookie: bob, body: form({ body: "And this" }) });
  await sendDigests(mailEnv);
  const forAnn = sent.filter((m) => m.to === "ann@example.com");
  assert.equal(forAnn.length, 1);
  assert.match(forAnn[0].subject, /2 new replies in 2 topics/);
  assert.match(forAnn[0].text, /First question[\s\S]*Second question|Second question[\s\S]*First question/);
  assert.match(forAnn[0].headers["List-Unsubscribe"], /\/unsubscribe\?u=\d+&t=/);
  // Bob replied, so he watches too, but his own posts don't count as news.
  assert.equal(sent.filter((m) => m.to === "bob@example.com").length, 0);

  // At most one digest a day: another reply waits.
  await req(`/t/${t1}/reply`, { method: "POST", cookie: bob, body: form({ body: "One more" }) });
  sent.length = 0;
  await sendDigests(mailEnv);
  assert.equal(sent.length, 0);

  // Your topics shows the unread count; opening the topic clears it.
  let mine = await (await req("/topics/mine", { cookie: ann })).text();
  assert.match(mine, /First question/);
  assert.match(mine, /1 new/);
  const unread = await req(`/t/${t1}/unread`, { cookie: ann });
  assert.match(unread.headers.get("location")!, /#post-\d+$/);
  await req(topics[0]!, { cookie: ann });
  mine = await (await req("/topics/mine", { cookie: ann })).text();
  assert.doesNotMatch(mine.split("Second question")[0]!, /\d+ new/);

  // Unwatching sticks, even after replying again.
  await req(`/t/${t1}/watch`, { method: "POST", cookie: bob, body: form({ watch: "0" }) });
  await req(`/t/${t1}/reply`, { method: "POST", cookie: bob, body: form({ body: "Last one" }) });
  const state = await env.DB.prepare("SELECT tu.watching FROM topic_users tu JOIN users u ON u.id = tu.user_id WHERE u.email = 'bob@example.com' AND tu.topic_id = ?").bind(t1).first();
  assert.equal(state.watching, 0);

  // The unsubscribe link turns digests off without signing in.
  const link = new URL(forAnn[0].headers["List-Unsubscribe"].slice(1, -1));
  assert.equal((await app.request(ORIGIN + link.pathname + link.search, { method: "POST" }, env)).status, 200);
  const ann2 = await env.DB.prepare("SELECT email_digest FROM users WHERE email = 'ann@example.com'").first();
  assert.equal(ann2.email_digest, 0);
  assert.equal((await req("/unsubscribe?u=1&t=wrong")).status, 404);

  // Hearts: one click, shown on every post.
  const firstPost = /id="post-(\d+)"/.exec(await (await req(topics[1]!)).text())![1];
  const r = await (await req(`/posts/${firstPost}/react`, { method: "POST", cookie: bob, body: form({ emoji: "❤️" }), headers: { Accept: "application/json" } })).json() as any;
  assert.deepEqual(r.reactions.map((x: any) => [x.emoji, x.count, x.mine]), [["❤️", 1, true]]);
  const page = await (await req(topics[1]!, { cookie: bob })).text();
  assert.match(page, /class="reaction heart has mine"/);
});
