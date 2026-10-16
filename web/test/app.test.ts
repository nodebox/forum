// Runs the Worker app in Node against local D1/R2 from wrangler's platform proxy.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPlatformProxy } from "wrangler";
import { app } from "../src/app.ts";
import { sendDigests } from "../src/notifications.ts";
import { sweepPending } from "../src/files.ts";
import { purgeRefused } from "../src/spamfilter.ts";

const persist = fs.mkdtempSync(path.join(os.tmpdir(), "forum-test-"));
let proxy: Awaited<ReturnType<typeof getPlatformProxy>>;
let env: any;

/** Splits a migration into statements; a trigger's body (BEGIN … END;) stays in one piece. */
function sqlStatements(sql: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const line of sql.replace(/--.*$/gm, "").split("\n")) {
    current += line + "\n";
    const inTrigger = /^\s*CREATE\s+TRIGGER/i.test(current) && !/\bEND\s*;\s*$/i.test(current);
    if (/;\s*$/.test(line) && !inTrigger) {
      out.push(current.trim().replace(/;$/, ""));
      current = "";
    }
  }
  if (current.trim()) out.push(current.trim());
  return out.filter(Boolean);
}

before(async () => {
  proxy = await getPlatformProxy({ persist: { path: persist } });
  env = { ...(proxy.env as object), MAILER: "log", PUBLIC_URL: "http://localhost", READ_ONLY: "false" };
  // A developer's .env may hold a real key; the tests only ever talk to the stand-in below.
  delete env.ANTHROPIC_API_KEY;
  const dir = path.join(import.meta.dirname, "../migrations");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const schema = fs.readFileSync(path.join(dir, file), "utf8");
    for (const stmt of sqlStatements(schema)) await env.DB.prepare(stmt).run();
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
  const key = async () => (await env.DB.prepare("SELECT r2_key FROM attachments WHERE id = ?").bind(up.id).first()).r2_key as string;
  // Until the post exists the file waits in pending/; posting moves it into the post's folder.
  const pendingKey = await key();
  assert.equal(pendingKey, `pending/${up.id}/project.zip`);
  res = await req(`/t/${topicId}/reply`, { method: "POST", cookie: alice, body: form({ body: "Here's the project", attachments: up.id }) });
  const projectPost = Number(/#post-(\d+)/.exec(res.headers.get("location")!)![1]);
  assert.equal(await key(), `posts/${projectPost}/${up.id}/project.zip`);
  assert.equal(await env.FILES.head(pendingKey), null);
  assert.ok(await env.FILES.head(await key()));
  html = await (await req(topicPath)).text();
  assert.match(html, /project\.zip/);
  const dl = await req(`/files/${up.id}/project.zip`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get("content-disposition")!, /^attachment/);

  // A file on the first post of a new topic moves the same way.
  const fd2 = new FormData();
  fd2.append("file", new File([new Uint8Array([1, 2, 3])], "sketch.ndbx"));
  const up2 = await (await req("/uploads", { method: "POST", cookie: alice, body: fd2 })).json() as any;
  res = await req("/new", { method: "POST", cookie: alice, body: form({ title: "A sketch", category: "questions", body: "See attached", attachments: up2.id }) });
  assert.equal(res.status, 302);
  const sketch = await env.DB.prepare("SELECT post_id, r2_key FROM attachments WHERE id = ?").bind(up2.id).first();
  assert.equal(sketch.r2_key, `posts/${sketch.post_id}/${up2.id}/sketch.ndbx`);

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
  assert.match(await (await req(topics[0]!, { cookie: ann })).text(), /class="button button-quiet watch on" aria-pressed="true"[^>]*>[\s\S]*?Watching\s*<\/button>/);
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

test("the sweep removes abandoned uploads and finishes interrupted moves", async () => {
  const carol = await signIn("carol@example.com");
  const upload = async (name: string) => {
    const fd = new FormData();
    fd.append("file", new File([new Uint8Array([1, 2, 3])], name));
    return (await (await req("/uploads", { method: "POST", cookie: carol, body: fd })).json()) as any;
  };
  const row = (id: string) => env.DB.prepare("SELECT post_id, r2_key FROM attachments WHERE id = ?").bind(id).first();
  const abandoned = await upload("abandoned.zip");
  const interrupted = await upload("interrupted.zip");
  // A post claimed this file, but the move into its folder never happened.
  const post = await env.DB.prepare("SELECT id FROM posts LIMIT 1").first();
  await env.DB.prepare("UPDATE attachments SET post_id = ? WHERE id = ?").bind(post.id, interrupted.id).run();

  assert.deepEqual(await sweepPending(env), { removed: 0, moved: 0 }, "uploads from the last day are left alone");
  assert.ok(await row(abandoned.id));

  const tomorrow = Date.now() + 25 * 3600 * 1000;
  assert.deepEqual(await sweepPending(env, tomorrow), { removed: 1, moved: 1 });
  assert.equal(await row(abandoned.id), null);
  assert.equal(await env.FILES.head(`pending/${abandoned.id}/abandoned.zip`), null);
  assert.equal((await row(interrupted.id)).r2_key, `posts/${post.id}/${interrupted.id}/interrupted.zip`);
  assert.equal((await req(`/files/${interrupted.id}/interrupted.zip`)).status, 200);
  assert.equal((await env.FILES.list({ prefix: "pending/" })).objects.length, 0);
});

// A stand-in for the Anthropic API: the verdict follows a keyword in the post.
function fakeSpamApi() {
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("https://api.anthropic.com/")) return real(input, init);
    const text = JSON.parse(init.body).messages[0].content as string;
    calls.push(text);
    if (text.includes("outage")) return new Response("overloaded", { status: 529 });
    const verdict = text.includes("casino")
      ? { verdict: "spam", confidence: 0.97, reason: "casino advert" }
      : text.includes("borderline")
        ? { verdict: "spam", confidence: 0.8, reason: "maybe promotional" }
        : { verdict: "ham", confidence: 0.97, reason: "genuine" };
    return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(verdict) }] });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test("the spam filter refuses spam from new accounts", async () => {
  const api = fakeSpamApi();
  env.ANTHROPIC_API_KEY = "test-key";
  try {
    const eve = await signIn("eve@example.com");
    const topic = await env.DB.prepare("SELECT id, slug, post_count FROM topics WHERE status = 'visible' LIMIT 1").first();
    const reply = (cookie: string, body: string) => req(`/t/${topic.id}/reply`, { method: "POST", cookie, body: form({ body }) });

    const res = await reply(eve, "Best casino bonus here");
    assert.equal(res.status, 422);
    assert.match(await res.text(), /was not posted/);
    const stored = await env.DB.prepare("SELECT status, moderated_by, moderation_reason FROM posts WHERE body = 'Best casino bonus here'").first();
    assert.deepEqual({ ...stored }, { status: "spam", moderated_by: null, moderation_reason: "Spam filter: casino advert" });
    assert.doesNotMatch(await (await req(`/t/${topic.id}/${topic.slug}`)).text(), /casino bonus/);
    assert.equal((await env.DB.prepare("SELECT post_count FROM topics WHERE id = ?").bind(topic.id).first()).post_count, topic.post_count);

    // A refused new topic is stored hidden as well, and the category count stays.
    const before = (await env.DB.prepare("SELECT topic_count FROM categories WHERE id = 1").first()).topic_count;
    const newTopic = await req("/new", { method: "POST", cookie: eve, body: form({ title: "Win big", category: "questions", body: "Online casino, click here" }) });
    assert.equal(newTopic.status, 422);
    assert.equal((await env.DB.prepare("SELECT status FROM topics WHERE title = 'Win big'").first()).status, "spam");
    assert.equal((await env.DB.prepare("SELECT topic_count FROM categories WHERE id = 1").first()).topic_count, before);
    // Refused posts are stored hidden from the start and logged; the author doesn't watch the topic.
    const winBig = await env.DB.prepare("SELECT t.id, t.post_count, p.moderation_reason FROM topics t JOIN posts p ON p.topic_id = t.id WHERE t.title = 'Win big'").first();
    assert.equal(winBig.post_count, 0);
    assert.equal(winBig.moderation_reason, "Spam filter: casino advert");
    assert.equal(await env.DB.prepare("SELECT 1 FROM topic_users WHERE topic_id = ?").bind(winBig.id).first(), null);
    assert.ok(await env.DB.prepare("SELECT 1 FROM moderation_log WHERE topic_id = ? AND action = 'spam' AND admin_id IS NULL").bind(winBig.id).first());

    // Posting keeps working when the filter is unsure, fails, or is switched off.
    const frank = await signIn("frank@example.com");
    assert.equal((await reply(frank, "A borderline mention of my shop")).status, 302, "spam below 0.9 is published");
    const mails: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => void mails.push(args.join(" "));
    try {
      assert.equal((await reply(frank, "Posted during an outage")).status, 302, "an API error publishes");
      assert.equal((await reply(frank, "Another outage post")).status, 302);
    } finally {
      console.log = realLog;
    }
    // ...and tells the admins, once, not for every post.
    const alerts = mails.filter((m) => m.includes("the spam filter is unavailable"));
    const admins = (await env.DB.prepare("SELECT count(*) AS n FROM users WHERE is_admin = 1 AND email IS NOT NULL AND banned_at IS NULL").first()).n;
    assert.ok(admins > 0);
    assert.equal(alerts.length, admins, "one alert per admin per window");
    assert.ok(alerts.some((m) => /mail to alice@example\.com/.test(m)));
    assert.match(alerts[0]!, /HTTP 529/);
    delete env.ANTHROPIC_API_KEY;
    const callsBefore = api.calls.length;
    assert.equal((await reply(frank, "No key, casino or not")).status, 302);
    assert.equal(api.calls.length, callsBefore, "without a key nothing is sent");
    env.ANTHROPIC_API_KEY = "test-key";

    // Frank now has three visible posts, so his posts are no longer checked.
    assert.equal((await reply(frank, "I do like a casino")).status, 302);
    assert.equal(api.calls.length, callsBefore, "an established account is not checked");

    // Three refused posts ban the account. Eve has two; the third does it.
    assert.equal((await env.DB.prepare("SELECT banned_at FROM users WHERE email = 'eve@example.com'").first()).banned_at, null);
    assert.equal((await reply(eve, "casino casino casino")).status, 422);
    assert.ok((await env.DB.prepare("SELECT banned_at FROM users WHERE email = 'eve@example.com'").first()).banned_at);
    assert.equal((await reply(eve, "one more casino")).status, 302, "her session is gone, so she is sent to sign in");
    assert.equal(await env.DB.prepare("SELECT id FROM posts WHERE body = 'one more casino'").first(), null);

    // Refused posts delete themselves after 30 days, with their files. Restored and imported ones stay.
    const gina = await signIn("gina@example.com");
    const fd = new FormData();
    fd.append("file", new File([new Uint8Array([1, 2, 3])], "flyer.zip"));
    const up = (await (await req("/uploads", { method: "POST", cookie: gina, body: fd })).json()) as any;
    await req(`/t/${topic.id}/reply`, { method: "POST", cookie: gina, body: form({ body: "casino flyer attached", attachments: up.id }) });
    const flyerKey = (await env.DB.prepare("SELECT r2_key FROM attachments WHERE id = ?").bind(up.id).first()).r2_key;
    assert.ok(await env.FILES.head(flyerKey));
    await env.DB.prepare("UPDATE posts SET status = 'visible', moderated_by = (SELECT id FROM users WHERE is_admin = 1 LIMIT 1) WHERE body = 'casino casino casino'").run();
    await env.DB.prepare("UPDATE posts SET tender_number = 9 WHERE body = 'Best casino bonus here'").run();
    const count = async (where: string) => (await env.DB.prepare(`SELECT count(*) AS n FROM ${where}`).first()).n;

    const topicsBefore = await count("topics");
    assert.deepEqual(await purgeRefused(env), { posts: 0, topics: 0 }, "nothing is old enough yet");
    assert.deepEqual(await purgeRefused(env, Date.now() + 31 * 24 * 3600 * 1000), { posts: 2, topics: 1 });
    assert.equal(await count("posts WHERE body IN ('Online casino, click here', 'casino flyer attached')"), 0);
    assert.equal(await count("topics WHERE title = 'Win big'"), 0);
    assert.equal(await count("topics"), topicsBefore - 1, "only the topic left without a post is deleted");
    assert.equal(await count("attachments WHERE id = '" + up.id + "'"), 0);
    assert.equal(await env.FILES.head(flyerKey), null);
    assert.equal(await count("posts WHERE body IN ('casino casino casino', 'Best casino bonus here')"), 2);
  } finally {
    delete env.ANTHROPIC_API_KEY;
    api.restore();
  }
});

test("search, unanswered and archived categories", async () => {
  await env.DB.prepare("INSERT INTO categories (id, slug, name, archived) VALUES (2, 'nodebox-1', 'NodeBox 1', 1)").run();
  const zoe = await signIn("zoe@example.com");
  await req("/settings", { method: "POST", cookie: zoe, body: form({ name: "Zoe", next: "/" }) });
  const posted = await req("/new", { method: "POST", cookie: zoe, body: form({ title: "Gradient fills on a spiral", category: "questions", body: "How do I give each segment of a spiral its own hue?" }) });
  assert.equal(posted.status, 302);

  // Found by a word in the post and by a prefix of a word in the title, but not by a word that isn't there.
  assert.match(await (await req("/search?q=segment")).text(), /Gradient fills on a spiral/);
  assert.match(await (await req("/search?q=spir")).text(), /Gradient fills on a spiral/);
  assert.match(await (await req("/search?q=" + encodeURIComponent('"quoted" OR (weird*'))).text(), /Nothing matches/);

  // Nobody replied yet, so it is unanswered; archived categories never count.
  await env.DB.prepare("INSERT INTO topics (id, category_id, user_id, title, slug, created_at, last_post_at, post_count) VALUES (9100, 2, 900, 'Ancient question', 'ancient', '2009', '2009', 1)").run();
  const open = await (await req("/unanswered")).text();
  assert.match(open, /Gradient fills on a spiral/);
  assert.doesNotMatch(open, /Ancient question/);

  // An archived category reads fine but takes no new topics.
  const archive = await (await req("/c/nodebox-1")).text();
  assert.match(archive, /NodeBox 1 is archived/);
  assert.doesNotMatch(archive, /New topic/);
  assert.doesNotMatch(await (await req("/new", { cookie: zoe })).text(), /value="nodebox-1"/);
  const refused = await req("/new", { method: "POST", cookie: zoe, body: form({ title: "Still using NB1", category: "nodebox-1", body: "Hello" }) });
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /archived and takes no new topics/);
});

test("read-only: everyone can read and sign in, only admins can write", async () => {
  const ro = { ...env, READ_ONLY: "true" };
  const roReq = (p: string, init: RequestInit & { cookie?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set("cookie", init.cookie);
    if (init.method === "POST") headers.set("origin", ORIGIN);
    return app.request(ORIGIN + p, { ...init, headers, redirect: "manual" }, ro);
  };
  const cy = await signIn("cy@example.com");
  const di = await signIn("di@example.com");
  await env.DB.prepare("UPDATE users SET is_admin = 1 WHERE email = 'di@example.com'").run();

  assert.match(await (await roReq("/")).text(), /read-only/);
  assert.equal((await roReq("/signin/email", { method: "POST", body: form({ email: "eve@example.com", next: "/" }) })).status, 200);
  const refused = await roReq("/new", { method: "POST", cookie: cy, body: form({ title: "Hello", category: "questions", body: "Hi" }) });
  assert.equal(refused.status, 403);
  assert.match(await refused.text(), /read-only/);
  assert.equal((await roReq("/new", { method: "POST", cookie: di, body: form({ title: "Admin test", category: "questions", body: "Hi" }) })).status, 302);
});

test("RSS feeds", async () => {
  await env.DB.prepare("INSERT INTO categories (id, slug, name, description) VALUES (20, 'feeds-cat', 'Feeds & Things', 'Feed test')").run();
  const rita = await signIn("rita@example.com");
  let res = await req("/new", { method: "POST", cookie: rita, body: form({ title: "Feeds <are> great", category: "feeds-cat", body: "Look at [this](/guidelines) **now**" }) });
  const topicPath = res.headers.get("location")!;
  const topicId = Number(/\/t\/(\d+)/.exec(topicPath)![1]);
  const sam = await signIn("sam@example.com");
  res = await req(`/t/${topicId}/reply`, { method: "POST", cookie: sam, body: form({ body: "A reply about zeppelins" }) });
  const replyId = Number(/#post-(\d+)/.exec(res.headers.get("location")!)![1]);
  res = await req(`/t/${topicId}/reply`, { method: "POST", cookie: sam, body: form({ body: "Hidden zeppelins" }) });
  const hiddenId = Number(/#post-(\d+)/.exec(res.headers.get("location")!)![1]);
  await env.DB.prepare("UPDATE posts SET status = 'spam' WHERE id = ?").bind(hiddenId).run();

  const feed = async (p: string) => {
    const r = await req(p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get("content-type")!, /^application\/rss\+xml/);
    return r.text();
  };

  // New topics: the opening post in full, with absolute links, escaped once.
  let xml = await feed("/feeds/topics");
  assert.match(xml, /<title>Feeds &lt;are&gt; great<\/title>/);
  assert.match(xml, /<category domain="http:\/\/localhost\/c\/feeds-cat">Feeds &amp; Things<\/category>/);
  assert.match(xml, /href=&quot;http:\/\/localhost\/guidelines&quot;/);
  assert.match(xml, /&lt;strong&gt;now&lt;\/strong&gt;/);
  assert.match(xml, new RegExp(`<link>http://localhost/t/${topicId}/feeds-are-great</link>`));
  assert.doesNotMatch(xml, /zeppelins/, "replies are not in the topics feed");

  // All posts: replies too, but never hidden ones.
  xml = await feed("/feeds/posts");
  assert.match(xml, /<title>Re: Feeds &lt;are&gt; great<\/title>/);
  assert.match(xml, new RegExp(`<link>http://localhost/p/${replyId}</link>`));
  assert.doesNotMatch(xml, /Hidden zeppelins/);

  // Per category, per topic, unanswered, search.
  assert.match(await feed("/feeds/c/feeds-cat"), /Feeds &lt;are&gt; great/);
  assert.match(await feed("/feeds/c/feeds-cat/posts"), /A reply about zeppelins/);
  assert.doesNotMatch(await feed("/feeds/c/questions"), /Feeds &lt;are&gt;/);
  xml = await feed(`/feeds/t/${topicId}`);
  assert.match(xml, /A reply about zeppelins/);
  assert.doesNotMatch(xml, /Hidden zeppelins/);
  assert.doesNotMatch(await feed("/feeds/unanswered"), /Feeds &lt;are&gt;/, "a topic with a reply is answered");
  xml = await feed("/feeds/search?q=zeppelins");
  assert.match(xml, /A reply about zeppelins/);
  assert.doesNotMatch(xml, /Hidden zeppelins/);
  assert.doesNotMatch(xml, /Look at/, "a match in a reply doesn't bring the opening post");
  assert.match(await feed("/feeds/search?q=great"), /Look at/, "a title match brings the opening post");
  assert.equal((await req("/feeds/c/nope")).status, 404);
  assert.equal((await req("/feeds/t/999999")).status, 404);
  assert.equal((await req("/feeds/t/abc")).status, 404);
  assert.equal((await req("/p/abc")).status, 404);
  assert.equal((await req("/feeds/search")).status, 404);
  // A hidden topic has no feed.
  await env.DB.prepare("UPDATE topics SET status = 'removed' WHERE id = ?").bind(topicId).run();
  assert.equal((await req(`/feeds/t/${topicId}`)).status, 404);
  assert.doesNotMatch(await feed("/feeds/posts"), /zeppelins/);
  await env.DB.prepare("UPDATE topics SET status = 'visible' WHERE id = ?").bind(topicId).run();

  // Readers that send If-Modified-Since get a 304 until something new is posted.
  const first = await req("/feeds/posts");
  const modified = first.headers.get("last-modified")!;
  assert.ok(modified);
  assert.equal((await req("/feeds/posts", { headers: { "if-modified-since": modified } })).status, 304);
  assert.equal((await req("/feeds/posts", { headers: { "if-modified-since": "Thu, 01 Jan 2004 00:00:00 GMT" } })).status, 200);

  // Item links lead to the post.
  res = await req(`/p/${replyId}`);
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), `${topicPath}#post-${replyId}`);
  assert.equal((await req(`/p/${hiddenId}`)).status, 404);

  // Pages point feed readers at their feed, and the overview lists every category.
  const page = await (await req(topicPath)).text();
  assert.match(page, new RegExp(`<link rel="alternate" type="application/rss\\+xml" title="Replies to “Feeds &lt;are&gt; great”" href="/feeds/t/${topicId}">`));
  assert.match(page, /href="\/feeds\/topics"/);
  assert.match(await (await req("/c/feeds-cat")).text(), /<link rel="alternate" type="application\/rss\+xml" title="Feeds &amp; Things: new topics" href="\/feeds\/c\/feeds-cat">/);
  assert.match(await (await req("/feeds")).text(), /\/feeds\/c\/feeds-cat\/posts/);
});
