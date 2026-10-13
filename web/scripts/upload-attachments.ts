// Put the exported Tender attachment files into the forum's R2 bucket.
//
//   npm run upload:attachments          # ../data/attachments → local R2 (what `npm run dev` reads)
//
// Run it after the import (npm run import:tender, then wrangler d1 execute):
// the forum's attachments table says where each file goes, the export says
// which file on disk it is. A file already in the bucket is left alone, so an
// interrupted run picks up where it stopped.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { getPlatformProxy } from "wrangler";
import { dispositionFor } from "../src/files.ts";
import { attachmentId } from "./import-tender.ts";

export interface UploadRow {
  id: string;
  r2_key: string;
  filename: string;
  content_type: string;
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

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const dataDir = path.join(here, "../../data");
  const src = new DatabaseSync(path.join(dataDir, "forum.sqlite"), { readOnly: true });
  const localById = new Map<string, string>();
  for (const a of src.prepare("SELECT discussion_id, comment_number, download_path, local_path FROM attachments WHERE local_path IS NOT NULL").all() as any[]) {
    localById.set(attachmentId(a.discussion_id, a.comment_number, a.download_path), a.local_path);
  }
  const proxy = await getPlatformProxy();
  try {
    const env = proxy.env as unknown as { DB: D1Database; FILES: R2Bucket };
    const { results } = await env.DB.prepare("SELECT id, r2_key, filename, content_type FROM attachments WHERE post_id IS NOT NULL ORDER BY post_id").all<UploadRow>();
    console.log(`${results.length} attachments in the forum database.`);
    const r = await uploadFiles(results, localById, path.join(dataDir, "attachments"), env.FILES, (done) => {
      if (done % 200 === 0) console.log(`  ${done}/${results.length}`);
    });
    console.log(`Uploaded ${r.uploaded}, already there ${r.present}, no file on disk ${r.missing.length}.`);
    if (r.missing.length) console.log(`  missing: ${r.missing.slice(0, 20).join(" ")}`);
  } finally {
    await proxy.dispose();
  }
}
