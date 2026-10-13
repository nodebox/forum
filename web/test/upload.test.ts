// The attachment uploader against local R2 from wrangler's platform proxy.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPlatformProxy } from "wrangler";
import { uploadFiles } from "../scripts/upload-attachments.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forum-upload-"));
let proxy: Awaited<ReturnType<typeof getPlatformProxy>>;

before(async () => {
  proxy = await getPlatformProxy({ persist: { path: path.join(tmp, "state") } });
});
after(async () => {
  await proxy.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("puts each attachment's file under its storage key, once", async () => {
  const bucket = (proxy.env as any).FILES as R2Bucket;
  const dir = path.join(tmp, "attachments");
  fs.mkdirSync(path.join(dir, "assets/abc"), { recursive: true });
  fs.writeFileSync(path.join(dir, "assets/abc/shot.png"), "PNG!!");
  const rows = [
    { id: "a1", r2_key: "posts/7/a1/shot.png", filename: "shot.png", content_type: "image/png" },
    { id: "a2", r2_key: "posts/9/a2/shot.png", filename: "shot.png", content_type: "image/png" },
    { id: "a3", r2_key: "posts/9/a3/gone.zip", filename: "gone.zip", content_type: "application/zip" },
  ];
  const local = new Map([["a1", "assets/abc/shot.png"], ["a2", "assets/abc/shot.png"], ["a3", "assets/zzz/gone.zip"]]);

  assert.deepEqual(await uploadFiles(rows, local, dir, bucket), { uploaded: 2, present: 0, missing: ["a3"] });
  const obj = await bucket.get("posts/9/a2/shot.png");
  assert.equal(await obj!.text(), "PNG!!");
  assert.equal(obj!.httpMetadata?.contentType, "image/png");
  assert.match(obj!.httpMetadata?.contentDisposition ?? "", /^inline; filename="shot.png"/);

  assert.deepEqual(await uploadFiles(rows, local, dir, bucket), { uploaded: 0, present: 2, missing: ["a3"] }, "a second run uploads nothing");
});
