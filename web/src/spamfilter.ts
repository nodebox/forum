// Spam filter for new posts and for edits. It reads what new accounts write before the post
// is stored, refuses what it is sure about, and never stands in the way
// otherwise: no key, an error, a slow answer or a doubtful verdict all mean the
// post is published. When the filter can't be reached the admins hear about it.
import type { Bindings } from "./env.ts";
import { deletePostFiles } from "./files.ts";
import { banUser, log } from "./moderation.ts";
import { sendMail } from "./mailer.ts";
import { rateLimit, type User } from "./db.ts";

const MODEL = "claude-haiku-5-5";
/** The filter refuses a post only at this confidence or higher. */
const REFUSE_AT = 0.9;
/** An account with this many visible posts is no longer checked. */
const TRUSTED_AFTER_POSTS = 3;
/** This many refused posts ban the account, so the filter can't be probed for long. */
const MAX_REFUSALS = 3;
const TIMEOUT_MS = 5000;
/** A refused post is kept this long, in case the filter was wrong, and then deleted. */
const KEEP_REFUSED_MS = 30 * 24 * 3600 * 1000;
/** Admins get at most one "filter unavailable" email in this window. */
const ALERT_EVERY_SECONDS = 6 * 3600;

const SYSTEM = `You check a new post on the NodeBox forum before it is published. NodeBox is a free,
open-source family of tools for generative design and data visualisation. People ask questions
about installing and using it, about Python, graphics, fonts, exporting and data visualisation,
and share their own work. Posts are in English, Dutch and other languages.

Decide whether the post is spam. Spam: advertising and SEO link drops; phishing; scams; casino,
crypto, pharmacy, loans, essay writing, escort and similar promotions; gibberish or copied text
whose purpose is to plant a link; replies that add nothing but a link.

Not spam: genuine questions, even if off-topic, badly written, rude, in another language or very
short; bug reports and feature requests; people sharing their own NodeBox work or genuinely
related tools.

confidence is your probability (0 to 1) that the verdict is right. reason is one short sentence
a moderator can check quickly.`;

const SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["spam", "ham", "unsure"] },
    confidence: { type: "number" },
    reason: { type: "string" },
  },
  required: ["verdict", "confidence", "reason"],
  additionalProperties: false,
} as const;

export interface PostToCheck {
  topicTitle: string;
  body: string;
  /** False for a reply to an existing topic. */
  opensTopic: boolean;
}

/**
 * The reason to refuse this post, or null to publish it. Null is also the
 * answer whenever the filter can't say: posting has to keep working.
 */
export async function refusalReason(env: Bindings, user: User, post: PostToCheck): Promise<string | null> {
  if (!env.ANTHROPIC_API_KEY || user.is_admin) return null;
  const visible = await env.DB.prepare("SELECT count(*) AS n FROM posts WHERE user_id = ? AND status = 'visible'").bind(user.id).first<{ n: number }>();
  if ((visible?.n ?? 0) >= TRUSTED_AFTER_POSTS) return null;
  try {
    const out = await ask(env.ANTHROPIC_API_KEY, post);
    return out.verdict === "spam" && out.confidence >= REFUSE_AT ? out.reason.slice(0, 280) : null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`spam filter unavailable, publishing: ${message}`);
    await alertAdmins(env, message);
    return null;
  }
}

interface Verdict {
  verdict: string;
  confidence: number;
  reason: string;
}

/** Ask Claude about one post. Throws when the API can't be reached or answers with an error. */
async function ask(apiKey: string, post: PostToCheck): Promise<Verdict> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      messages: [
        {
          role: "user",
          content: `${post.opensTopic ? "New topic" : "Reply in the topic"}: ${post.topicTitle}\n\n${post.body.slice(0, 6000)}`,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  const out = JSON.parse(data.content.flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])).join("")) as Verdict;
  return { verdict: String(out.verdict), confidence: Number(out.confidence), reason: String(out.reason) };
}

export type FilterCheck =
  | { status: "off" }
  | { status: "working"; verdict: string; confidence: number; reason: string; ms: number }
  | { status: "failing"; error: string; ms: number };

/** A spam post that any working filter refuses. */
const SAMPLE: PostToCheck = {
  topicTitle: "Best online casino bonus 2026",
  body: "Get 500 free spins today!!! Register at our casino and claim your bonus, no deposit needed. Click here: https://casino-bonus.example",
  opensTopic: true,
};

/**
 * Send a sample spam post through the filter with the Worker's own key, for
 * the admin page. Nothing is stored and nobody is emailed.
 */
export async function checkFilter(env: Bindings): Promise<FilterCheck> {
  if (!env.ANTHROPIC_API_KEY) return { status: "off" };
  const start = Date.now();
  try {
    const out = await ask(env.ANTHROPIC_API_KEY, SAMPLE);
    return { status: "working", ...out, ms: Date.now() - start };
  } catch (err) {
    return { status: "failing", error: err instanceof Error ? err.message : String(err), ms: Date.now() - start };
  }
}

/**
 * Tell the admins the filter is down, once per window: posts from new accounts
 * are going out unchecked until it is back. Failing to send never blocks a post.
 */
async function alertAdmins(env: Bindings, error: string): Promise<void> {
  try {
    if (!(await rateLimit(env.DB, "alert:spam-filter", 1, ALERT_EVERY_SECONDS))) return;
    const { results } = await env.DB.prepare("SELECT email FROM users WHERE is_admin = 1 AND email IS NOT NULL AND banned_at IS NULL").all<{ email: string }>();
    const base = env.PUBLIC_URL.replace(/\/+$/, "");
    const text = `The spam filter could not check a new post, so it was published unchecked:

${error}

Until the filter answers again, posts from new accounts go out without a check. Look at the latest posts, and hide spam from the topic page or ${base}/admin.

You get this email at most once every ${ALERT_EVERY_SECONDS / 3600} hours.`;
    const html = text
      .split("\n\n")
      .map((p) => `<p>${p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`)
      .join("\n");
    for (const { email } of results) {
      await sendMail(env, { to: email, subject: `${env.SITE_NAME}: the spam filter is unavailable`, text, html });
    }
  } catch (err) {
    console.error("could not alert the admins about the spam filter", err);
  }
}

/** Posts the filter refused: hidden as spam by nobody, and not from the Tender import. */
const REFUSED = "status = 'spam' AND moderated_by IS NULL AND tender_number IS NULL";

/**
 * Log a post the filter refused (it was stored hidden), and ban the account
 * after too many. The post stays restorable from /admin until the purge removes it.
 */
export async function refusePost(env: Bindings, p: { postId: number; topicId: number; userId: number; reason: string }): Promise<void> {
  await log(env.DB, { adminId: null, action: "spam", postId: p.postId, topicId: p.topicId, userId: p.userId, reason: `Spam filter: ${p.reason}` }).run();
  await banAfterRefusals(env, p.userId);
}

/**
 * Log an edit the filter refused. The edit isn't saved, so the post keeps its earlier text;
 * refused edits count towards the ban like refused posts, so editing can't be used to probe.
 */
export async function refuseEdit(env: Bindings, p: { postId: number; topicId: number; userId: number; reason: string }): Promise<void> {
  await log(env.DB, { adminId: null, action: "edit_refused", postId: p.postId, topicId: p.topicId, userId: p.userId, reason: `Spam filter: ${p.reason}` }).run();
  await banAfterRefusals(env, p.userId);
}

async function banAfterRefusals(env: Bindings, userId: number): Promise<void> {
  const refused = await env.DB.prepare(
    `SELECT (SELECT count(*) FROM posts WHERE user_id = ?1 AND ${REFUSED})
          + (SELECT count(*) FROM moderation_log WHERE user_id = ?1 AND action = 'edit_refused') AS n`,
  )
    .bind(userId)
    .first<{ n: number }>();
  if ((refused?.n ?? 0) >= MAX_REFUSALS) await banUser(env.DB, userId, null, false);
}

/**
 * Delete refused posts older than 30 days, with their files, and any topic
 * left without a post. Runs from the hourly cron, so nobody has to clear them.
 */
export async function purgeRefused(env: Bindings, nowMs = Date.now()): Promise<{ posts: number; topics: number }> {
  const cutoff = new Date(nowMs - KEEP_REFUSED_MS).toISOString();
  const { results } = await env.DB.prepare(`SELECT id, topic_id FROM posts WHERE ${REFUSED} AND moderated_at < ? LIMIT 200`).bind(cutoff).all<{ id: number; topic_id: number }>();
  let topics = 0;
  for (const p of results) {
    await deletePostFiles(env, p.id);
    await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(p.id).run();
    const gone = await env.DB.prepare("DELETE FROM topics WHERE id = ? AND NOT EXISTS (SELECT 1 FROM posts WHERE topic_id = ?) RETURNING id").bind(p.topic_id, p.topic_id).all();
    topics += gone.results.length;
  }
  return { posts: results.length, topics };
}
