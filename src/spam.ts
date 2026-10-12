import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { type DB, now, tx, upsert } from "./db.ts";

export interface SpamConfig {
  model: string;
  effort: "low" | "medium" | "high";
  concurrency: number;
  limit: number | undefined;
  redo: boolean;
}

const log = (...args: unknown[]) => console.log(...args);

/** Approximate $ per million tokens (input, output), for the cost report only. */
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};

// Per-comment and per-discussion caps on what is sent to the model.
const MAX_COMMENT_CHARS = 2000;
const MAX_COMMENTS = 50;

export interface Comment {
  number: number;
  author_name: string | null;
  body: string | null;
  user_is_supporter: number | null;
  created_at: string | null;
}

export interface Discussion {
  id: number;
  title: string | null;
  state: string | null;
  author_name: string | null;
  category: string | null;
  created_at: string | null;
  html_href: string | null;
  comments: Comment[];
}

export interface Verdict {
  verdict: "spam" | "ham" | "unsure";
  confidence: number;
  reason: string;
  spam_replies: { number: number; reason: string }[];
}

// ---------------------------------------------------------------------------
// Heuristics: decide without the model where that is safe.

// Domains that show up in genuine NodeBox posts. A link to anything else
// from a non-staff author sends the discussion to the model.
const SAFE_DOMAINS = [
  "nodebox.net", "emrg.be", "github.com", "githubusercontent.com", "gist.github.com",
  "stackoverflow.com", "python.org", "wikipedia.org", "youtube.com", "youtu.be", "vimeo.com",
  "flickr.com", "imgur.com", "dropbox.com", "processing.org", "tenderapp.com", "w3.org",
];
const URL_RE = /\b(?:https?:\/\/|www\.)([a-z0-9.-]+\.[a-z]{2,})/gi;

export function externalLinks(text: string): string[] {
  const hosts: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const host = m[1].toLowerCase().replace(/^www\./, "");
    if (!SAFE_DOMAINS.some((d) => host === d || host.endsWith("." + d))) hosts.push(host);
  }
  return hosts;
}

/**
 * A discussion that NodeBox staff answered, where nobody else posted a link
 * to an unknown site, is genuine. Returns null when the model should decide.
 */
export function heuristic(d: Discussion): { verdict: "spam" | "ham"; reason: string } | null {
  if (d.state === "spam") return { verdict: "spam", reason: "marked spam in Tender" };
  const staffReplied = d.comments.some((c) => c.user_is_supporter && c.number > 1);
  const linksFromOthers = d.comments.filter((c) => !c.user_is_supporter).flatMap((c) => externalLinks(c.body ?? ""));
  if (staffReplied && linksFromOthers.length === 0) {
    return { verdict: "ham", reason: "answered by NodeBox staff, no outside links" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Model

const SYSTEM = `You review posts from the NodeBox support forum before they move to a new forum.
NodeBox is a free, open-source family of tools for generative design and data visualisation
(NodeBox 1 for Mac with Python scripting, NodeBox 2 and 3 node-based apps, NodeBox Live, and
libraries). Since 2008 people have asked questions there about installing and using NodeBox,
Python, graphics, fonts, exporting, data visualisation and their own projects. Posts are in
English, Dutch and other languages.

Decide whether each discussion is spam. Spam includes: advertising and SEO link drops; phishing
(fake parcel or delivery notices, payment or account warnings, prize or refund messages);
scams; casino, crypto, pharmacy, loans, essay writing, escort and similar promotions; gibberish
or copied text whose purpose is to plant a link; and replies that add nothing but a link or a
signature with links.

Not spam: genuine questions, even if off-topic, badly written, rude, in another language, or
never answered; bug reports and feature requests; people sharing their own NodeBox work or
genuinely related tools and libraries; job or collaboration posts that are about NodeBox.

Answer for the whole discussion based on its opening post (#1). If the opening post is genuine
but some replies are spam, set verdict "ham" and list those replies in spam_replies. If the
opening post is spam, set verdict "spam" and leave spam_replies empty. Use "unsure" only when a
careful human moderator would also hesitate. confidence is your probability (0 to 1) that the
verdict is right. reason is one short sentence a moderator can check quickly.`;

const SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["spam", "ham", "unsure"] },
    confidence: { type: "number" },
    reason: { type: "string" },
    spam_replies: {
      type: "array",
      items: {
        type: "object",
        properties: { number: { type: "integer" }, reason: { type: "string" } },
        required: ["number", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdict", "confidence", "reason", "spam_replies"],
  additionalProperties: false,
} as const;

function clip(text: string, max: number) {
  return text.length > max ? text.slice(0, max) + ` [... ${text.length - max} more characters cut]` : text;
}

export function renderDiscussion(d: Discussion): string {
  const lines = [
    `Title: ${d.title ?? ""}`,
    `Category: ${d.category ?? "unknown"}`,
    `Started by: ${d.author_name ?? "unknown"} on ${d.created_at ?? "unknown date"}`,
    "",
  ];
  const shown = d.comments.slice(0, MAX_COMMENTS);
  for (const c of shown) {
    const who = `${c.author_name ?? "unknown"}${c.user_is_supporter ? " (NodeBox staff)" : ""}`;
    lines.push(`--- #${c.number} by ${who} on ${c.created_at ?? "?"}`, clip(c.body ?? "", MAX_COMMENT_CHARS), "");
  }
  if (d.comments.length > shown.length) {
    lines.push(`[${d.comments.length - shown.length} later replies not shown]`);
  }
  return lines.join("\n");
}

export interface Usage {
  input: number;
  output: number;
  calls: number;
}

export async function classifyWithModel(
  client: Anthropic,
  cfg: SpamConfig,
  d: Discussion,
  usage: Usage,
): Promise<Verdict> {
  const response = await client.beta.messages.create({
    model: cfg.model,
    max_tokens: 4096,
    system: SYSTEM,
    output_config: { effort: cfg.effort, format: { type: "json_schema", schema: SCHEMA } },
    // On a safety decline, re-run on a fallback model the API picks (Haiku has no fallbacks).
    ...(cfg.model.startsWith("claude-haiku")
      ? {}
      : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
    messages: [{ role: "user", content: renderDiscussion(d) }],
  });
  usage.calls++;
  usage.input += response.usage.input_tokens;
  usage.output += response.usage.output_tokens;
  if (response.stop_reason === "refusal") {
    return { verdict: "unsure", confidence: 0, reason: "the model declined to classify this", spam_replies: [] };
  }
  if (response.stop_reason === "max_tokens") throw new Error(`discussion ${d.id}: response cut off at max_tokens`);
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const out = JSON.parse(text) as Verdict;
  out.confidence = Math.min(1, Math.max(0, Number(out.confidence) || 0));
  return out;
}

// ---------------------------------------------------------------------------
// Database

export function loadDiscussion(db: DB, id: number): Discussion {
  const d = db
    .prepare(
      `SELECT d.id, d.title, d.state, d.author_name, d.created_at, d.html_href, c.name AS category
       FROM discussions d LEFT JOIN categories c ON c.id = d.category_id WHERE d.id = ?`,
    )
    .get(id) as Omit<Discussion, "comments">;
  const comments = db
    .prepare(
      `SELECT number, author_name, body, user_is_supporter, created_at FROM comments
       WHERE discussion_id = ? AND COALESCE(internal, 0) = 0 AND COALESCE(system_message, 0) = 0
       ORDER BY number`,
    )
    .all(id) as unknown as Comment[];
  return { ...d, comments };
}

/** Discussions with their comments fetched and no verdict yet (or all, with redo). */
export function pendingIds(db: DB, cfg: Pick<SpamConfig, "redo" | "limit">): number[] {
  let sql = `SELECT id FROM discussions d WHERE (detail_fetched_at IS NOT NULL OR state = 'spam') AND state != 'deleted'`;
  if (!cfg.redo) {
    sql += ` AND NOT EXISTS (SELECT 1 FROM spam_verdicts v WHERE v.discussion_id = d.id AND v.comment_number = 0)`;
  }
  sql += " ORDER BY id";
  if (cfg.limit) sql += ` LIMIT ${Number(cfg.limit)}`;
  return (db.prepare(sql).all() as { id: number }[]).map((r) => r.id);
}

export function saveVerdict(db: DB, id: number, source: string, v: Verdict, model: string | null) {
  tx(db, () => {
    db.prepare("DELETE FROM spam_verdicts WHERE discussion_id = ?").run(id);
    const at = now();
    upsert(db, "spam_verdicts", ["discussion_id", "comment_number"], {
      discussion_id: id,
      comment_number: 0,
      verdict: v.verdict,
      confidence: v.confidence,
      source,
      reason: v.reason,
      model,
      classified_at: at,
    });
    for (const r of v.verdict === "spam" ? [] : v.spam_replies) {
      if (!Number.isInteger(r.number) || r.number < 1) continue;
      upsert(db, "spam_verdicts", ["discussion_id", "comment_number"], {
        discussion_id: id,
        comment_number: r.number,
        verdict: "spam",
        confidence: v.confidence,
        source,
        reason: r.reason,
        model,
        classified_at: at,
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Steps

export async function classify(db: DB, cfg: SpamConfig, client: Anthropic) {
  const ids = pendingIds(db, cfg);
  log(`Classifying ${ids.length} discussions (model: ${cfg.model}, effort: ${cfg.effort}, ${cfg.concurrency} at a time)`);
  const usage: Usage = { input: 0, output: 0, calls: 0 };
  const counts: Record<string, number> = {};
  const failures: string[] = [];
  let done = 0;
  let next = 0;

  async function worker() {
    while (next < ids.length) {
      const id = ids[next++];
      const d = loadDiscussion(db, id);
      let label: string;
      try {
        const h = heuristic(d);
        if (h) {
          const source = d.state === "spam" ? "tender" : "heuristic";
          saveVerdict(db, id, source, { ...h, confidence: 1, spam_replies: [] }, null);
          label = `${source}:${h.verdict}`;
        } else {
          const v = await classifyWithModel(client, cfg, d, usage);
          saveVerdict(db, id, "model", v, cfg.model);
          label = `model:${v.verdict}`;
          if (v.verdict !== "ham" || v.spam_replies.length) {
            const extra = v.spam_replies.length ? ` (+${v.spam_replies.length} spam replies)` : "";
            log(`  ${id} ${v.verdict} ${v.confidence.toFixed(2)}${extra}: ${d.title}`);
          }
        }
      } catch (err) {
        // Auth and bad-request errors will fail every discussion the same way.
        if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.BadRequestError) throw err;
        failures.push(`${id}: ${err instanceof Error ? err.message : err}`);
        label = "failed";
      }
      counts[label] = (counts[label] ?? 0) + 1;
      if (++done % 50 === 0) log(`  ${done}/${ids.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, cfg.concurrency) }, worker));

  log(`\nDone: ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ") || "nothing to do"}`);
  if (usage.calls) {
    const price = PRICES[cfg.model];
    const cost = price ? ` (about $${((usage.input * price[0] + usage.output * price[1]) / 1e6).toFixed(2)})` : "";
    log(`Model: ${usage.calls} calls, ${usage.input} input + ${usage.output} output tokens${cost}`);
  }
  if (failures.length) {
    log(`${failures.length} failed (run again to retry):\n  ${failures.slice(0, 20).join("\n  ")}`);
  }
}

/** Rough token count and cost for the discussions the model would see. */
export function estimate(db: DB, cfg: SpamConfig) {
  const ids = pendingIds(db, cfg);
  let toModel = 0;
  let chars = 0;
  for (const id of ids) {
    const d = loadDiscussion(db, id);
    if (heuristic(d)) continue;
    toModel++;
    chars += renderDiscussion(d).length + SYSTEM.length;
  }
  // ~3.5 characters per token; low-effort thinking plus the JSON answer is a few hundred tokens.
  const input = Math.round(chars / 3.5);
  const output = toModel * 400;
  log(`${ids.length} discussions pending, ${ids.length - toModel} settled by heuristics, ${toModel} for the model.`);
  log(`About ${input} input and ${output} output tokens.`);
  for (const [model, [pi, po]] of Object.entries(PRICES)) {
    log(`  ${model.padEnd(18)} ~$${((input * pi + output * po) / 1e6).toFixed(2)}`);
  }
}

// ---------------------------------------------------------------------------
// Review CSV

const REVIEW_COLUMNS = [
  "decision", "verdict", "confidence", "source", "discussion_id", "comment",
  "title", "author", "excerpt", "reason", "url",
] as const;

function csvCell(x: unknown): string {
  const s = x === null || x === undefined ? "" : String(x);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ""));
}

/**
 * Everything a person should look at: all model spam and unsure verdicts, and
 * genuine-looking discussions the model wasn't sure of. Least certain first.
 */
export function writeReview(db: DB, file: string) {
  const rows = db
    .prepare(
      `SELECT m.decision, v.verdict, v.confidence, v.source, v.discussion_id, v.comment_number,
              d.title, COALESCE(c.author_name, d.author_name) AS author, c.body, v.reason, d.html_href
       FROM spam_verdicts v
       JOIN discussions d ON d.id = v.discussion_id
       LEFT JOIN comments c ON c.discussion_id = v.discussion_id AND c.number = MAX(v.comment_number, 1)
       LEFT JOIN spam_decisions m ON m.discussion_id = v.discussion_id AND m.comment_number = v.comment_number
       WHERE v.source = 'model' AND (v.verdict <> 'ham' OR v.confidence < 0.7)
       ORDER BY v.verdict = 'unsure' DESC, v.confidence, v.discussion_id, v.comment_number`,
    )
    .all() as any[];
  const lines = [REVIEW_COLUMNS.join(",")];
  for (const r of rows) {
    const excerpt = (r.body ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    lines.push(
      [r.decision, r.verdict, r.confidence?.toFixed(2), r.source, r.discussion_id, r.comment_number,
       r.title, r.author, excerpt, r.reason, r.html_href].map(csvCell).join(","),
    );
  }
  // BOM so Excel and Numbers read it as UTF-8.
  fs.writeFileSync(file, "﻿" + lines.join("\n") + "\n");
  log(`Wrote ${rows.length} rows to ${file}.`);
  log(`Fill in "decision" with spam or ham where you disagree or want to confirm, then: npm run spam -- apply ${file}`);
}

export function applyReview(db: DB, file: string) {
  const [header, ...rows] = parseCsv(fs.readFileSync(file, "utf8"));
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`${file} has no "${name}" column`);
    return i;
  };
  const [di, ci, ki] = [col("decision"), col("discussion_id"), col("comment")];
  let applied = 0;
  let cleared = 0;
  tx(db, () => {
    for (const r of rows) {
      const decision = (r[di] ?? "").trim().toLowerCase();
      const key = [Number(r[ci]), Number(r[ki] || 0)];
      if (!Number.isInteger(key[0])) continue;
      if (decision === "spam" || decision === "ham") {
        upsert(db, "spam_decisions", ["discussion_id", "comment_number"], {
          discussion_id: key[0], comment_number: key[1], decision, decided_at: now(),
        });
        applied++;
      } else if (decision === "") {
        cleared += Number(db.prepare("DELETE FROM spam_decisions WHERE discussion_id = ? AND comment_number = ?").run(...key).changes);
      } else {
        throw new Error(`discussion ${key[0]}: decision must be spam, ham or empty, not "${decision}"`);
      }
    }
  });
  log(`Applied ${applied} decisions${cleared ? `, cleared ${cleared}` : ""}.`);
  stats(db);
}

export function stats(db: DB) {
  const rows = db
    .prepare(
      `SELECT source, verdict, COUNT(*) AS n FROM spam_verdicts WHERE comment_number = 0
       GROUP BY source, verdict ORDER BY source, verdict`,
    )
    .all() as { source: string; verdict: string; n: number }[];
  log("Discussions by verdict:");
  for (const r of rows) log(`  ${r.source.padEnd(10)} ${r.verdict.padEnd(7)} ${r.n}`);
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  log(`Spam replies flagged inside genuine discussions: ${one("SELECT COUNT(*) AS n FROM spam_verdicts WHERE comment_number > 0")}`);
  log(`Reviewed by hand: ${one("SELECT COUNT(*) AS n FROM spam_decisions")}`);
  log(
    `Excluded from import: ${one("SELECT COUNT(*) AS n FROM spam_excluded WHERE comment_number = 0")} discussions, ` +
      `${one("SELECT COUNT(*) AS n FROM spam_excluded WHERE comment_number > 0")} replies`,
  );
  log(`Not classified yet: ${pendingIds(db, { redo: false, limit: undefined }).length}`);
}
