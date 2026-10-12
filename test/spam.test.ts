import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { openDb, upsert, now } from "../src/db.ts";
import * as spam from "../src/spam.ts";

function seed(db: ReturnType<typeof openDb>) {
  const discussion = (id: number, title: string, state = "open") =>
    upsert(db, "discussions", ["id"], {
      id, title, state, author_name: "someone", html_href: `https://support.nodebox.net/discussions/q/${id}`,
      raw: "{}", fetched_at: now(), detail_fetched_at: state === "spam" ? null : now(),
    });
  const comment = (discussion_id: number, number: number, body: string, staff = false) =>
    upsert(db, "comments", ["discussion_id", "number"], {
      discussion_id, number, body, author_name: staff ? "Frederik" : "someone",
      user_is_supporter: staff, internal: false, system_message: false, raw: "{}",
    });
  // Answered by staff, no outside links: settled by the heuristic.
  discussion(1, "Export to SVG fails");
  comment(1, 1, "When I export to SVG I get an empty file. See https://github.com/nodebox/nodebox/issues/1");
  comment(1, 2, "Fixed in 3.0.52.", true);
  // Phishing: the model decides.
  discussion(2, "“Pakketmelding: verlies uw levering niet!” ✅");
  comment(2, 1, "Uw pakket staat klaar. Bevestig hier: https://post-nl-levering.example/track");
  // Genuine question with a spam reply.
  discussion(3, "How do I load a CSV?");
  comment(3, 1, "I want to plot a CSV file in NodeBox 3.");
  comment(3, 2, "Best casino bonus at https://casino.example");
  // Borderline: the model is unsure.
  discussion(4, "Check out my tool");
  comment(4, 1, "I made a plotting tool, see https://my-tool.example");
  // Already marked spam in Tender, details never fetched.
  discussion(5, "We Couldn’t Process Your Payment – Please Update", "spam");
}

/** A fake Messages API that answers based on the discussion text. */
function fakeClaude() {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const params = JSON.parse(body);
      requests.push(params);
      const text: string = params.messages[0].content;
      let verdict: spam.Verdict = { verdict: "ham", confidence: 0.95, reason: "genuine question", spam_replies: [] };
      if (text.includes("Pakketmelding")) verdict = { verdict: "spam", confidence: 0.99, reason: "parcel phishing", spam_replies: [] };
      if (text.includes("casino")) verdict.spam_replies = [{ number: 2, reason: "casino link" }];
      if (text.includes("my-tool")) verdict = { verdict: "unsure", confidence: 0.5, reason: "self-promotion?", spam_replies: [] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_1", type: "message", role: "assistant", model: params.model, stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify(verdict) }],
        usage: { input_tokens: 100, output_tokens: 20 },
      }));
    });
  });
  return { server, requests };
}

test("heuristics", () => {
  assert.deepEqual(spam.externalLinks("see https://github.com/x and www.casino.example/y"), ["casino.example"]);
  assert.deepEqual(spam.externalLinks("docs at https://www.nodebox.net/node/"), []);
});

test("csv round trip", () => {
  const rows = spam.parseCsv('﻿a,b\n"x, ""y""",\r\n"multi\nline",2\n');
  assert.deepEqual(rows, [["a", "b"], ['x, "y"', ""], ["multi\nline", "2"]]);
});

test("classify, review, apply", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spam-"));
  const db = openDb(path.join(dir, "forum.sqlite"));
  seed(db);
  const { server, requests } = fakeClaude();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const client = new Anthropic({ apiKey: "test", baseURL: `http://127.0.0.1:${port}`, maxRetries: 0 });
  const cfg: spam.SpamConfig = { model: "claude-opus-5-5", effort: "low", concurrency: 2, limit: undefined, redo: false };
  try {
    await spam.classify(db, cfg, client);
    // Discussions 1 (heuristic) and 5 (Tender) never reach the model.
    assert.equal(requests.length, 3);
    assert.equal(requests[0].output_config.format.type, "json_schema");
    assert.deepEqual(requests[0].fallbacks, "default");

    const excluded = () => db.prepare("SELECT discussion_id, comment_number FROM spam_excluded ORDER BY 1, 2").all().map((r: any) => [r.discussion_id, r.comment_number]);
    assert.deepEqual(excluded(), [[2, 0], [3, 2], [5, 0]]);

    // Nothing left to do on a second run.
    await spam.classify(db, cfg, client);
    assert.equal(requests.length, 3);

    const csv = path.join(dir, "review.csv");
    spam.writeReview(db, csv);
    const [header, ...rows] = spam.parseCsv(fs.readFileSync(csv, "utf8"));
    const id = header.indexOf("discussion_id");
    assert.deepEqual(rows.map((r) => `${r[id]}/${r[header.indexOf("comment")]}`), ["4/0", "3/2", "2/0"]);

    // The reviewer marks the unsure one as spam and overrules the casino reply.
    rows[0][0] = "spam";
    rows[1][0] = "HAM";
    fs.writeFileSync(csv, [header, ...rows].map((r) => r.map((c) => JSON.stringify(c)).join(",")).join("\n"));
    spam.applyReview(db, csv);
    assert.deepEqual(excluded(), [[2, 0], [4, 0], [5, 0]]);
  } finally {
    server.close();
    db.close();
  }
});
