// Put the exported Tender attachment files into the forum's R2 bucket.
//
//   npm run upload:attachments          # ../data/attachments → local R2 (what `npm run dev` reads)
//   npm run upload:attachments:remote   # → production R2 and Cloudflare Images
//
// The remote run reads the production D1 and writes the production bucket
// through wrangler's remote bindings (it needs `wrangler login`). Images also
// go to Cloudflare Images under the id the importer gave them; the account id
// and Images token come from 1Password through `op run`.
//
// Run it after the import (npm run import:tender, then wrangler d1 execute):
// the forum's attachments table says where each file goes, the export says
// which file on disk it is. A file already in the bucket is left alone, so an
// interrupted run picks up where it stopped.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { experimental_readRawConfig, getPlatformProxy } from "wrangler";
import { dispositionFor } from "../src/files.ts";
import { attachmentId } from "./import-tender.ts";

export interface UploadRow {
  id: string;
  r2_key: string;
  filename: string;
  content_type: string;
  image_id?: string | null;
}

/** `localById` maps an attachment id to its file's path under `dir`. */
export async function uploadFiles(
  rows: UploadRow[],
  localById: Map<string, string>,
  dir: string,
  bucket: R2Bucket,
  progress: (done: number) => void = () => {},
): Promise<{ uploaded: number; present: number; missing: string[] }> {
  const result = { uploaded: 0, present: 0, missing: [] as string[] };
  let done = 0;
  for (const row of rows) {
    const rel = localById.get(row.id);
    const file = rel ? path.join(dir, rel) : null;
    if (!file || !fs.existsSync(file)) result.missing.push(row.id);
    else if (await bucket.head(row.r2_key)) result.present++;
    else {
      await bucket.put(row.r2_key, fs.readFileSync(file), {
        httpMetadata: { contentType: row.content_type, contentDisposition: dispositionFor(row.filename, row.content_type) },
      });
      result.uploaded++;
    }
    progress(++done);
  }
  return result;
}

/**
 * Put the rows that have an `image_id` into Cloudflare Images under that id.
 * An image already there is left alone, so a second run uploads nothing.
 */
export async function uploadImages(
  rows: UploadRow[],
  localById: Map<string, string>,
  dir: string,
  account: string,
  token: string,
  progress: (done: number) => void = () => {},
): Promise<{ uploaded: number; present: number; missing: string[]; failed: string[] }> {
  const result = { uploaded: 0, present: 0, missing: [] as string[], failed: [] as string[] };
  const api = `https://api.cloudflare.com/client/v4/accounts/${account}/images/v1`;
  const headers = { Authorization: `Bearer ${token}` };
  let done = 0;
  for (const row of rows) {
    if (!row.image_id) continue;
    const rel = localById.get(row.id);
    const file = rel ? path.join(dir, rel) : null;
    if (!file || !fs.existsSync(file)) result.missing.push(row.id);
    else if ((await fetch(`${api}/${encodeURIComponent(row.image_id)}`, { headers })).ok) result.present++;
    else {
      const form = new FormData();
      form.append("file", new File([fs.readFileSync(file)], row.filename, { type: row.content_type }));
      form.append("id", row.image_id);
      form.append("metadata", JSON.stringify({ project: "nodebox-forum" }));
      const res = await fetch(api, { method: "POST", headers, body: form });
      if (res.ok) result.uploaded++;
      else {
        result.failed.push(row.id);
        console.error(`Cloudflare Images upload failed for ${row.image_id}: ${res.status} ${await res.text()}`);
      }
    }
    progress(++done);
  }
  return result;
}

/** A copy of wrangler.jsonc whose D1 and R2 bindings point at production. */
function remoteConfig(here: string): string {
  const { rawConfig } = experimental_readRawConfig({ config: path.join(here, "../wrangler.jsonc") });
  const config = {
    name: rawConfig.name,
    compatibility_date: rawConfig.compatibility_date,
    compatibility_flags: rawConfig.compatibility_flags,
    d1_databases: rawConfig.d1_databases?.map((d: object) => ({ ...d, remote: true })),
    r2_buckets: rawConfig.r2_buckets?.map((b: object) => ({ ...b, remote: true })),
  };
  const file = path.join(here, "../.wrangler/upload-remote.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const dataDir = path.join(here, "../../data");
  const src = new DatabaseSync(path.join(dataDir, "forum.sqlite"), { readOnly: true });
  const localById = new Map<string, string>();
  for (const a of src.prepare("SELECT discussion_id, comment_number, download_path, local_path FROM attachments WHERE local_path IS NOT NULL").all() as any[]) {
    localById.set(attachmentId(a.discussion_id, a.comment_number, a.download_path), a.local_path);
  }
  const remote = process.argv.includes("--remote");
  const { CF_ACCOUNT_ID, CF_IMAGES_TOKEN } = process.env;
  if (remote && (!CF_ACCOUNT_ID || !CF_IMAGES_TOKEN)) {
    console.error("A remote run needs CF_ACCOUNT_ID and CF_IMAGES_TOKEN; use `npm run upload:attachments:remote`.");
    process.exit(1);
  }
  const proxy = await getPlatformProxy(remote ? { configPath: remoteConfig(here), persist: false } : {});
  try {
    const env = proxy.env as unknown as { DB: D1Database; FILES: R2Bucket };
    const { results } = await env.DB.prepare("SELECT id, r2_key, filename, content_type, image_id FROM attachments WHERE post_id IS NOT NULL ORDER BY post_id").all<UploadRow>();
    console.log(`${results.length} attachments in the forum database.`);
    const r = await uploadFiles(results, localById, path.join(dataDir, "attachments"), env.FILES, (done) => {
      if (done % 200 === 0) console.log(`  ${done}/${results.length}`);
    });
    console.log(`Uploaded ${r.uploaded}, already there ${r.present}, no file on disk ${r.missing.length}.`);
    if (r.missing.length) console.log(`  missing: ${r.missing.slice(0, 20).join(" ")}`);
    if (remote) {
      const images = results.filter((row) => row.image_id);
      console.log(`${images.length} of them go to Cloudflare Images.`);
      const i = await uploadImages(images, localById, path.join(dataDir, "attachments"), CF_ACCOUNT_ID!, CF_IMAGES_TOKEN!, (done) => {
        if (done % 100 === 0) console.log(`  ${done}/${images.length}`);
      });
      console.log(`Images: uploaded ${i.uploaded}, already there ${i.present}, no file on disk ${i.missing.length}, failed ${i.failed.length}.`);
      if (i.failed.length) process.exitCode = 1;
    }
  } finally {
    await proxy.dispose();
  }
}
