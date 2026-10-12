import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TenderClient, idFromHref } from "../src/client.ts";
import { openDb } from "../src/db.ts";
import * as steps from "../src/steps.ts";
import type { Config } from "../src/config.ts";

const KEY = "test-key";

/** A tiny fake of the Tender API, shaped after the published docs. */
function fakeTender(base: () => string) {
  const api = () => base() + "/nodebox";
  const list = (name: string, all: any[], page: number) => ({
    offset: (page - 1) * 30,
    total: all.length,
    per_page: 30,
    [name]: all.slice((page - 1) * 30, page * 30),
  });
  const discussion = (id: number, state: string) => ({
    title: `Question ${id}`,
    number: id,
    state,
    public: true,
    comments_count: id === 101 ? 35 : 1,
    author_name: "Alice",
    created_at: "2015-01-01T00:00:00Z",
    updated_at: "2015-01-02T00:00:00Z",
    href: `${api()}/discussions/${id}`,
    comments_href: `${api()}/discussions/${id}/comments{?page}`,
    user_href: `${api()}/users/7`,
    category_href: `${api()}/categories/1`,
    html_href: `https://support.nodebox.net/discussions/questions/${id}`,
  });
  const comments = (id: number) =>
    Array.from({ length: id === 101 ? 35 : 1 }, (_, i) => ({
      number: i + 1,
      body: `body ${i + 1}`,
      formatted_body: `<p>body ${i + 1}</p>`,
      author_name: i % 2 ? "Bob" : "Alice",
      user_href: `${api()}/users/${i % 2 ? 8 : 7}`,
      internal: false,
      created_at: "2015-01-01T00:00:00Z",
      // Tender signs the URL afresh on every response, and one file can hang on comments of two discussions.
      assets: i === 0 && (id === 101 || id === 102)
        ? [{ filename: "my file.png", content_type: "image/png", size: 5, download_path: `${base()}/assets/abc123/my%20file.png?Signature=${++signatures}` }]
        : [],
    }));
  const discussions = [...Array.from({ length: 31 }, (_, i) => discussion(100 + i, "resolved")), discussion(200, "open")];
  let hits429 = 0;
  let signatures = 0;
  const seen: string[] = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    const page = Number(url.searchParams.get("page") ?? 1);
    seen.push(url.pathname + url.search);
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/vnd.tender-v1+json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname.startsWith("/assets/")) {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end("PNG!!");
    }
    if (req.headers.authorization !== `Bearer ${KEY}`) return json({ error: "unauthorized" }, 401);
    if (req.headers.accept !== "application/vnd.tender-v1+json") return json({}, 406);
    const p = url.pathname.replace(/^\/nodebox/, "");
    let m: RegExpExecArray | null;
    if (p === "/categories")
      return json(list("categories", [{ name: "Questions", permalink: "questions", href: `${api()}/categories/1`, resolved_discussions_count: 31, open_discussions_count: 1 }], page));
    if ((m = /^\/categories\/1\/discussions\/(\w+)$/.exec(p)))
      return json(list("discussions", discussions.filter((d) => d.state === m![1]), page));
    if (p === "/discussions") return json(list("discussions", discussions, page));
    if ((m = /^\/discussions\/(\d+)$/.exec(p))) {
      const id = Number(m[1]);
      if (id === 105 && hits429++ === 0) {
        res.writeHead(429, { "retry-after": "1" });
        return res.end();
      }
      if (id === 106) return json({ error: "not found" }, 404);
      const all = comments(id);
      const pageComments = all.slice((page - 1) * 30, page * 30);
      return json({ ...discussion(id, "resolved"), ...(pageComments.length ? { comments: pageComments } : {}) });
    }
    if (p === "/users") return json({ error: "forbidden" }, 403);
    if ((m = /^\/users\/(\d+)$/.exec(p)))
      return json({ name: m[1] === "7" ? "Alice" : "Bob", email: `${m[1]}@example.com`, href: `${api()}/users/${m[1]}` });
    if (p === "/sections") return json(list("sections", [{ title: "Manual", href: `${api()}/sections/5` }], page));
    if (p === "/faqs")
      return json(list("faqs", [{ title: "Install", body: "# Install", href: `${api()}/faqs/9`, section_href: `${api()}/sections/5` }], page));
    json({ error: "no route " + p }, 404);
  });
  return { server, seen };
}

test("idFromHref", () => {
  assert.equal(idFromHref("https://api.tenderapp.com/nodebox/discussions/42"), 42);
  assert.equal(idFromHref("https://api.tenderapp.com/nodebox/discussions/42/comments{?page}"), null);
  assert.equal(idFromHref("https://api.tenderapp.com/nodebox/categories/8{?page}"), 8);
  assert.equal(idFromHref(undefined), null);
});

test("full export against a fake Tender API, then resume", async () => {
  let base = "";
  const { server, seen } = fakeTender(() => base);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tender-"));
  const config: Config = {
    apiKey: KEY,
    site: "nodebox",
    apiBase: base + "/nodebox",
    assetBase: base,
    dataDir,
    dbPath: path.join(dataDir, "forum.sqlite"),
    attachmentsDir: path.join(dataDir, "attachments"),
    delayMs: 0,
    maxRetries: 3,
    includeDeleted: false,
    limit: undefined,
  };
  const db = openDb(config.dbPath);
  const ctx: steps.Ctx = { config, client: new TenderClient(config), db, refresh: false };
  const origLog = console.log;
  console.log = () => {};
  try {
    for (const s of ["categories", "discussions", "details", "users", "kb", "attachments"] as const) await steps[s](ctx);
    // Fetching a discussion again brings a new signature for the same file.
    db.exec("UPDATE discussions SET detail_fetched_at = NULL WHERE id = 101");
    await steps.details(ctx);
  } finally {
    console.log = origLog;
    server.close();
  }
  const one = (sql: string) => db.prepare(sql).get() as any;
  assert.equal(one("SELECT count(*) n FROM categories").n, 1);
  assert.equal(one("SELECT count(*) n FROM discussions").n, 32);
  assert.equal(one("SELECT count(*) n FROM discussions WHERE state = 'open'").n, 1);
  assert.equal(one("SELECT count(*) n FROM comments WHERE discussion_id = 101").n, 35, "second comment page fetched");
  assert.equal(one("SELECT count(*) n FROM discussions WHERE detail_error IS NOT NULL").n, 1, "404 recorded, not fatal");
  assert.ok(one("SELECT detail_fetched_at FROM discussions WHERE id = 105").detail_fetched_at, "429 retried");
  assert.deepEqual(
    db.prepare("SELECT id, name FROM users ORDER BY id").all().map((r: any) => ({ ...r })),
    [{ id: 7, name: "Alice" }, { id: 8, name: "Bob" }],
  );
  assert.equal(one("SELECT count(*) n FROM kb_articles WHERE section_id = 5").n, 1);
  const atts = db.prepare("SELECT * FROM attachments ORDER BY discussion_id").all() as any[];
  assert.deepEqual(atts.map((a) => [a.discussion_id, a.comment_number, a.download_path]), [
    [101, 1, "/assets/abc123/my%20file.png"],
    [102, 1, "/assets/abc123/my%20file.png"],
  ]);
  const signature = (a: any) => Number(new URL(a.download_url).searchParams.get("Signature"));
  assert.ok(signature(atts[0]) > signature(atts[1]), "the re-fetch replaced the signed URL");
  assert.equal(seen.filter((u) => u.startsWith("/assets/")).length, 1, "a shared file is downloaded once");
  assert.equal(atts[1].local_path, atts[0].local_path);
  const att = atts[0];
  assert.equal(att.local_path, "assets/abc123/my file.png");
  assert.equal(fs.readFileSync(path.join(config.attachmentsDir, att.local_path), "utf8"), "PNG!!");
  assert.equal(att.sha256.length, 64);

  // A second run makes no list requests (everything resumed as done) apart from categories.
  const before = seen.length;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  config.apiBase = base + "/nodebox";
  config.assetBase = base;
  console.log = () => {};
  try {
    for (const s of ["discussions", "details", "attachments"] as const) await steps[s](ctx);
  } finally {
    console.log = origLog;
    server.close();
  }
  assert.equal(seen.length, before, "nothing re-fetched on resume");
  db.close();
});

test("the API key is not sent to hosts other than Tender", async () => {
  // Tender hands out attachment URLs that are presigned for S3; S3 answers 400 when a request carries a second credential.
  const s3 = http.createServer((req, res) => {
    const extra = req.headers.authorization || req.headers["x-tender-auth"];
    res.writeHead(extra ? 400 : 200);
    res.end(extra ? "Only one auth mechanism allowed" : "PNG!!");
  });
  await new Promise<void>((r) => s3.listen(0, "127.0.0.1", r));
  const s3Base = `http://127.0.0.1:${(s3.address() as any).port}`;
  const client = new TenderClient({
    apiKey: KEY,
    apiBase: "https://api.tenderapp.com/nodebox",
    assetBase: "https://nodebox.tenderapp.com",
    delayMs: 0,
    maxRetries: 0,
  } as Config);
  try {
    const res = await client.raw(`${s3Base}/assets/abc123/file.png?AWSAccessKeyId=x&Signature=y`, { accept: "*/*" });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "PNG!!");
  } finally {
    s3.close();
  }
});
