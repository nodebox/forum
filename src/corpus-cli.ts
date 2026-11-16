// Upload the NodeBox 4 test corpus to its private R2 bucket.
//
//   npm run corpus:push -- --dry-run          # count what would go, upload nothing
//   npm run corpus:push                       # snapshot named after today
//   npm run corpus:push -- --snapshot 2026-11-16 --inputs data/nb4-check/inputs
//
// Only files attached to public topics go, without post text or addresses (see
// corpus.ts). Each run writes a new snapshot and then points latest.json at it;
// a snapshot that exists is never overwritten. The keys come from 1Password
// (.env.corpus); the one used here can write, the one CI gets can only read.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { archiveKey, manifestKey, pack, select } from "./corpus.ts";
import { objectUrl, putObject, signedHeaders, type Bucket } from "./s3.ts";

const { values } = parseArgs({
  options: {
    inputs: { type: "string", default: "data/nb4-check/inputs" },
    db: { type: "string", default: "data/forum.sqlite" },
    snapshot: { type: "string", default: new Date().toISOString().slice(0, 10) },
    "node-library": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});
if (!/^[0-9A-Za-z._-]+$/.test(values.snapshot)) throw new Error("--snapshot: letters, digits, dot, dash and underscore only");

const db = new DatabaseSync(values.db, { readOnly: true });
// The same topics the forum import takes: public, and not flagged by Tender or the spam filter.
const hasSpamView = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'spam_excluded'").get() !== undefined;
const visible = new Set(
  db
    .prepare(
      "SELECT id FROM discussions d WHERE public = 1 AND state NOT IN ('spam', 'deleted')" +
        (hasSpamView
          ? " AND NOT EXISTS (SELECT 1 FROM spam_excluded s WHERE s.discussion_id = d.id AND s.comment_number = 0)"
          : ""),
    )
    .all()
    .map((r) => Number(r.id)),
);
db.close();

const picked = select(values.inputs, (id) => visible.has(id), values["node-library"]);
const documents = picked.files.filter((f) => f.toLowerCase().endsWith(".ndbx")).length;
console.log(`${picked.files.length} files, ${documents} documents`);
console.log("left out:", JSON.stringify(picked.skipped));
if (values["dry-run"]) process.exit(0);

const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (npm run corpus:push reads it from 1Password)`);
  return v;
};
const bucket: Bucket = {
  endpoint: env("CORPUS_R2_ENDPOINT"),
  bucket: process.env.CORPUS_R2_BUCKET ?? "nodebox-test-corpus",
  accessKeyId: env("CORPUS_R2_ACCESS_KEY_ID"),
  secretAccessKey: env("CORPUS_R2_SECRET_ACCESS_KEY"),
};

const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const head = objectUrl(bucket, manifestKey(values.snapshot));
const there = await fetch(head, { method: "HEAD", headers: signedHeaders("HEAD", head, emptyHash, bucket) });
if (there.status === 200) throw new Error(`snapshot ${values.snapshot} exists; pick another --snapshot`);
if (there.status !== 404) throw new Error(`could not check the bucket: HTTP ${there.status}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-"));
try {
  const archive = path.join(tmp, "corpus.tar.gz");
  console.log("packing…");
  const manifest = await pack(values.inputs, picked.files, archive, values.snapshot);
  console.log(`uploading ${(manifest.archive.size / 2 ** 20).toFixed(0)} MB…`);
  await putObject(bucket, archiveKey(values.snapshot), { file: archive }, "application/gzip");
  await putObject(bucket, manifestKey(values.snapshot), JSON.stringify(manifest), "application/json");
  await putObject(bucket, "latest.json", JSON.stringify({ snapshot: values.snapshot }), "application/json");
  console.log(`snapshot ${values.snapshot} is up, and latest.json points at it`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
