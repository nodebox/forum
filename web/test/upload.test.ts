// The attachment uploader against local R2 from wrangler's platform proxy.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPlatformProxy } from "wrangler";
import { uploadFiles, uploadImages } from "../scripts/upload-attachments.ts";

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

test("puts images into Cloudflare Images under their id, once", async (t) => {
  const dir = path.join(tmp, "images");
  fs.mkdirSync(path.join(dir, "assets/def"), { recursive: true });
  fs.writeFileSync(path.join(dir, "assets/def/shot.png"), "PNG!!");
  const stored = new Map<string, string>();
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer tok");
    if (init?.method === "POST") {
      const form = init.body as FormData;
      stored.set(form.get("id") as string, await (form.get("file") as File).text());
      return new Response("{}", { status: 200 });
    }
    const id = decodeURIComponent(url.split("/").pop()!);
    return new Response("{}", { status: stored.has(id) ? 200 : 404 });
  });
  const rows = [
    { id: "b1", r2_key: "posts/7/b1/shot.png", filename: "shot.png", content_type: "image/png", image_id: "nodebox-forum-b1" },
    { id: "b2", r2_key: "posts/7/b2/scene.ndbx", filename: "scene.ndbx", content_type: "application/xml", image_id: null },
    { id: "b3", r2_key: "posts/7/b3/gone.png", filename: "gone.png", content_type: "image/png", image_id: "nodebox-forum-b3" },
  ];
  const local = new Map([["b1", "assets/def/shot.png"], ["b2", "assets/def/scene.ndbx"]]);

  assert.deepEqual(await uploadImages(rows, local, dir, "acct", "tok"), { uploaded: 1, present: 0, missing: ["b3"], failed: [] });
  assert.equal(stored.get("nodebox-forum-b1"), "PNG!!");
  assert.deepEqual(await uploadImages(rows, local, dir, "acct", "tok"), { uploaded: 0, present: 1, missing: ["b3"], failed: [] }, "a second run uploads nothing");
});
