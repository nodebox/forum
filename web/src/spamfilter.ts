// Spam filter for new posts. It reads only what new accounts write, refuses
// what it is sure about, and never stands in the way otherwise: no key, an
// error, a slow answer or a doubtful verdict all mean the post is published.
import type { Bindings } from "./env.ts";
import type { User } from "./db.ts";
import { deletePostFiles } from "./files.ts";
import { banUser, setPostStatus } from "./moderation.ts";

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
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
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
    const out = JSON.parse(data.content.flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])).join("")) as {
      verdict: string;
      confidence: number;
      reason: string;
    };
    return out.verdict === "spam" && Number(out.confidence) >= REFUSE_AT ? String(out.reason).slice(0, 280) : null;
  } catch (err) {
    console.error(`spam filter unavailable, publishing: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** Posts the filter refused: hidden as spam by nobody, and not from the Tender import. */
const REFUSED = "status = 'spam' AND moderated_by IS NULL AND tender_number IS NULL";

/**
 * Hide a post the filter refused, and ban the account after too many. The post
 * stays restorable from /admin until the purge removes it.
 */
export async function refusePost(env: Bindings, postId: number, userId: number, reason: string): Promise<void> {
  await setPostStatus(env.DB, postId, "spam", null, `Spam filter: ${reason}`);
  const refused = await env.DB.prepare(`SELECT count(*) AS n FROM posts WHERE user_id = ? AND ${REFUSED}`).bind(userId).first<{ n: number }>();
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
