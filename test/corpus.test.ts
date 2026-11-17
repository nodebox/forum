import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pack, select } from "../src/corpus.ts";
import { encodePath, signedHeaders } from "../src/s3.ts";

function tree(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-test-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

test("select keeps public topics and drops private ones, junk and the Node Library", () => {
  const dir = tree({
    "d1/0-a.ndbx/a.ndbx": "<ndbx/>",
    "d1/0-a.ndbx/data.csv": "x",
    "d1/1-zip/__MACOSX/._a.ndbx": "junk",
    "d1/1-zip/.DS_Store": "junk",
    "d1/1-zip/Icon\r": "",
    "d2/0-secret.ndbx/secret.ndbx": "private",
    "d3/0-Node_Library_3.7/Node Library 3.7/time.py": "lib",
    "notes/readme.txt": "not a topic",
    "stray.ndbx": "not a topic",
  });
  fs.symlinkSync("/etc/hosts", path.join(dir, "d1/link"));
  const isPublic = (id: number) => id !== 2;
  const picked = select(dir, isPublic);
  assert.deepEqual(picked.files, ["d1/0-a.ndbx/a.ndbx", "d1/0-a.ndbx/data.csv"]);
  assert.deepEqual(picked.skipped, { privateTopics: 1, unknownFolders: 2, junk: 3, nodeLibrary: 1, notFiles: 1 });
  assert.ok(select(dir, isPublic, true).files.includes("d3/0-Node_Library_3.7/Node Library 3.7/time.py"));
});

test("pack writes exactly the selected files and a manifest without anything else", async () => {
  const dir = tree({ "d1/a b.ndbx": "<ndbx/>", "d1/data.csv": "x", "d1/odd\r.txt": "", "d2/secret.ndbx": "private" });
  const archive = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "corpus-out-")), "c.tar.gz");
  const manifest = await pack(dir, ["d1/a b.ndbx", "d1/data.csv", "d1/odd\r.txt"], archive, "2026-01-01");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-x-"));
  execFileSync("tar", ["-xzf", archive, "-C", out]);
  assert.deepEqual(fs.readdirSync(out), ["d1"]);
  assert.deepEqual(fs.readdirSync(path.join(out, "d1")).sort(), ["a b.ndbx", "data.csv", "odd\r.txt"]);
  assert.equal(manifest.documents, 1);
  assert.equal(manifest.archive.key, "snapshots/2026-01-01/corpus.tar.gz");
  assert.equal(manifest.archive.size, fs.statSync(archive).size);
  assert.deepEqual(Object.keys(manifest).sort(), ["archive", "created", "documents", "files", "snapshot"]);
  assert.deepEqual(manifest.files[1], {
    path: "d1/data.csv",
    size: 1,
    sha256: "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
  });
});

// The GET Object example from the Amazon S3 API reference, "Signature
// Calculations for the Authorization Header: Transferring Payload in a Single Chunk".
test("signedHeaders matches the published Signature Version 4 example", () => {
  const headers = signedHeaders(
    "GET",
    new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1" },
    { Range: "bytes=0-9" },
    new Date("2013-05-24T00:00:00Z"),
  );
  assert.equal(
    headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
      "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
      "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
  assert.equal(headers["x-amz-date"], "20130524T000000Z");
});

test("encodePath escapes what S3 escapes and keeps the slashes", () => {
  assert.equal(encodePath("snapshots/2026-11-16/a b(1)*.gz"), "snapshots/2026-11-16/a%20b%281%29%2A.gz");
});
