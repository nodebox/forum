import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { attachmentId } from "../scripts/import-tender.ts";
import { planRewrite, updateStatements, type LinkSnapshot } from "../scripts/rewrite-legacy-links.ts";

const file = attachmentId(20, 2, "/assets/abc/sound-test.ndbx.zip");
const body = [
  "See http://support.nodebox.net/discussions/show-your-work/574-sign-node.",
  "Also [the star](https://support.nodebox.net/discussions/show-your-work/550-fancy-star-node#comment_1) and",
  "https://nodebox.tenderapp.com/discussions/show-your-work/574-sign-node/assets/abc/sound-test.ndbx.zip,",
  "http://support.nodebox.net/discussions/show-your-work/6331/r?go=https%3A%2F%2Fexample.com%2Fx",
  "http://support.nodebox.net/discussions/support/310-out-of-memory",
  "http://support.nodebox.net/discussions/nodebox-2-3/7170-complement-node",
  "https://github.com/discussions/show-your-work/574 and /discussions/show-your-work/550 (relative).",
  "[Tender](http://tenderapp.com/) and https://help.tenderapp.com/kb/x stay.",
  `[msi](http://support.nodebox.net/discussions/show-your-work/6331/r?go=${Buffer.from("https://github.com/nodebox/nodebox/releases/download/v3.0.53/NodeBox-3.0.53.msi").toString("base64")})`,
  "http://support.nodebox.net/discussions/show-your-work/574/r?go=aHR0cH",
].join("\n");

const snap: LinkSnapshot = {
  posts: [
    { id: 1, topic_id: 10, tender_number: 1, body },
    { id: 2, topic_id: 10, tender_number: 2, body: "Nothing old here: https://forum.nodebox.net/t/20/sign" },
  ],
  numbers: [
    { topic_id: 10, tender_number: 1 },
    { topic_id: 20, tender_number: 1 },
    { topic_id: 20, tender_number: 2 },
  ],
  redirects: [
    { path: "/discussions/show-your-work/574", topic_id: 20 },
    { path: "/discussions/general-discussion/574", topic_id: 30 },
    { path: "/discussions/show-your-work/550-fancy-star-node", topic_id: 40 },
  ],
  topics: [
    { id: 10, slug: "cartan" },
    { id: 20, slug: "sign-node" },
    { id: 30, slug: "workshop" },
    { id: 40, slug: "fancy-star" },
  ],
  categories: [{ slug: "show-your-work" }, { slug: "general-discussion" }, { slug: "nodebox-2-3" }],
  attachments: [{ id: file, filename: "sound-test.ndbx.zip" }],
};

test("points old links in posts at their new place", async () => {
  const { updates, changes } = await planRewrite(snap);
  assert.equal(updates.length, 1, "a post without old links is left alone");
  assert.equal(
    updates[0]!.body,
    [
      "See https://forum.nodebox.net/t/20/sign-node.",
      "Also [the star](/t/40/fancy-star) and",
      `https://forum.nodebox.net/files/${file}/sound-test.ndbx.zip,`,
      "https://example.com/x",
      "http://support.nodebox.net/discussions/support/310-out-of-memory",
      "http://support.nodebox.net/discussions/nodebox-2-3/7170-complement-node",
      "https://github.com/discussions/show-your-work/574 and /t/40/fancy-star (relative).",
      "[Tender](http://tenderapp.com/) and https://help.tenderapp.com/kb/x stay.",
      "[msi](https://github.com/nodebox/nodebox/releases/download/v3.0.53/NodeBox-3.0.53.msi)",
      "https://forum.nodebox.net/t/20/sign-node",
    ].join("\n"),
  );
  assert.deepEqual(
    changes.filter((c) => c.to === null).map((c) => c.from),
    ["http://support.nodebox.net/discussions/support/310-out-of-memory", "http://support.nodebox.net/discussions/nodebox-2-3/7170-complement-node"],
    "private and deleted discussions keep their old link",
  );
});

test("the update only applies to a post nobody changed since", async () => {
  const { updates } = await planRewrite(snap);
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE posts (id INTEGER PRIMARY KEY, body TEXT)");
  db.prepare("INSERT INTO posts VALUES (1, ?)").run(body + " edited");
  db.exec(updateStatements(updates).join("\n"));
  assert.match((db.prepare("SELECT body FROM posts").get() as any).body, /edited$/);
  db.prepare("UPDATE posts SET body = ?").run(body);
  db.exec(updateStatements(updates).join("\n"));
  assert.equal((db.prepare("SELECT body FROM posts").get() as any).body, updates[0]!.body);
});
