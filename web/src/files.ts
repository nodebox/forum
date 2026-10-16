import type { Bindings } from "./env.ts";
import type { Attachment } from "./db.ts";
import { now, randomId } from "./util.ts";

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Formats Cloudflare Images accepts and browsers display inline. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Refused outright: nobody needs to share these on a NodeBox forum. */
const BLOCKED_EXTENSIONS = /\.(exe|msi|bat|cmd|com|scr|ps1|vbs|jar|apk|dmg|pkg|app|sh)$/i;

export function isImage(contentType: string): boolean {
  return IMAGE_TYPES.has(contentType);
}

/**
 * Video and sound that browsers play in a post, by content type or extension
 * (Tender stored some MP4s as application/mp4). The value is the type the file
 * is served with, so the player accepts it: QuickTime movies go out as MP4,
 * the same container, which Chrome and Firefox otherwise refuse to play.
 */
const PLAYABLE: Record<string, { kind: "video" | "audio"; type: string }> = {
  mp4: { kind: "video", type: "video/mp4" },
  m4v: { kind: "video", type: "video/mp4" },
  mov: { kind: "video", type: "video/mp4" },
  webm: { kind: "video", type: "video/webm" },
  mp3: { kind: "audio", type: "audio/mpeg" },
  m4a: { kind: "audio", type: "audio/mp4" },
  wav: { kind: "audio", type: "audio/wav" },
  ogg: { kind: "audio", type: "audio/ogg" },
};
const PLAYABLE_TYPES = new Set(["video/mp4", "application/mp4", "video/quicktime", "video/webm", "audio/mpeg", "audio/mp3", "audio/mp4", "audio/wav", "audio/x-wav", "audio/ogg"]);

export function playable(a: Pick<Attachment, "filename" | "content_type">): { kind: "video" | "audio"; type: string } | null {
  const ext = a.filename.toLowerCase().split(".").pop() ?? "";
  const known = PLAYABLE[ext];
  if (!known) return null;
  return PLAYABLE_TYPES.has(a.content_type) || a.content_type === "application/octet-stream" ? known : null;
}

export function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const cleaned = base.replace(/[\x00-\x1f"<>|*?:]/g, "_").replace(/^\.+/, "").trim().slice(0, 140);
  return cleaned || "file";
}

/** Content type from the extension when the browser sends nothing useful. */
export function guessType(filename: string, given: string): string {
  if (given && given !== "application/octet-stream") return given;
  const ext = filename.toLowerCase().split(".").pop();
  const map: Record<string, string> = {
    zip: "application/zip",
    ndbx: "application/xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    csv: "text/csv",
    json: "application/json",
    txt: "text/plain",
    pdf: "application/pdf",
    mp4: "video/mp4",
    m4v: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    wav: "audio/wav",
    ogg: "audio/ogg",
  };
  return (ext && map[ext]) || "application/octet-stream";
}

const PENDING_PREFIX = "pending/";

/** Where an attachment's file lives once it belongs to a post. One attachment, one post, one folder. */
export function postFileKey(postId: number, a: Pick<Attachment, "id" | "filename">): string {
  return `posts/${postId}/${a.id}/${a.filename}`;
}

/**
 * Move a post's freshly uploaded files from pending/ into the post's folder.
 * R2 has no rename, so this copies, repoints the row, then deletes the old
 * object; whatever a failure leaves behind, the row points at a file that exists.
 */
export async function settleAttachments(env: Bindings, postId: number): Promise<void> {
  const { results } = await env.DB.prepare(`SELECT * FROM attachments WHERE post_id = ? AND r2_key LIKE '${PENDING_PREFIX}%'`).bind(postId).all<Attachment>();
  for (const a of results) {
    const from = a.r2_key;
    const obj = await env.FILES.get(from);
    if (!obj) continue;
    const to = postFileKey(postId, a);
    await env.FILES.put(to, obj.body, { httpMetadata: obj.httpMetadata, customMetadata: obj.customMetadata });
    await env.DB.prepare("UPDATE attachments SET r2_key = ? WHERE id = ?").bind(to, a.id).run();
    await env.FILES.delete(from);
  }
}

/** How long an upload may wait for its post before the sweep removes it. */
const PENDING_MAX_AGE_MS = 24 * 3600 * 1000;

/**
 * Clean up pending/: remove uploads that no post claimed within a day (the
 * file, its Cloudflare Images copy and its row), and finish the move for files
 * whose post exists. Runs from the hourly cron.
 */
export async function sweepPending(env: Bindings, nowMs = Date.now()): Promise<{ removed: number; moved: number }> {
  const cutoff = nowMs - PENDING_MAX_AGE_MS;
  const result = { removed: 0, moved: 0 };
  let cursor: string | undefined;
  do {
    const page = await env.FILES.list({ prefix: PENDING_PREFIX, cursor });
    for (const obj of page.objects) {
      if (obj.uploaded.getTime() > cutoff) continue;
      const a = await env.DB.prepare("SELECT * FROM attachments WHERE r2_key = ?").bind(obj.key).first<Attachment>();
      if (a?.post_id != null) {
        await settleAttachments(env, a.post_id);
        result.moved++;
        continue;
      }
      await env.FILES.delete(obj.key);
      if (a) {
        if (a.image_id) await deleteFromImages(env, a.image_id);
        await env.DB.prepare("DELETE FROM attachments WHERE id = ? AND post_id IS NULL").bind(a.id).run();
      }
      result.removed++;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return result;
}

export class UploadError extends Error {
  readonly status: 400 | 413 | 415 | 429;
  constructor(message: string, status: 400 | 413 | 415 | 429 = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Store an upload in R2 and, for images, in Cloudflare Images. Returns the
 * attachment row (not yet linked to a post). The file waits under pending/
 * until its post exists; see settleAttachments.
 */
export async function storeUpload(env: Bindings, db: D1Database, userId: number, file: File): Promise<Attachment> {
  if (file.size === 0) throw new UploadError("That file is empty.");
  if (file.size > MAX_UPLOAD_BYTES) throw new UploadError(`Files can be up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`, 413);
  const filename = cleanFilename(file.name);
  if (BLOCKED_EXTENSIONS.test(filename)) throw new UploadError("That kind of file can't be attached.", 415);
  const contentType = guessType(filename, file.type);
  const id = randomId(12);
  const r2Key = `${PENDING_PREFIX}${id}/${filename}`;
  const bytes = await file.arrayBuffer();
  await env.FILES.put(r2Key, bytes, {
    httpMetadata: { contentType, contentDisposition: dispositionFor(filename, contentType) },
    customMetadata: { userId: String(userId) },
  });
  let imageId: string | null = null;
  if (isImage(contentType)) imageId = await uploadToImages(env, `${env.CF_IMAGES_PREFIX}${id}`, filename, contentType, bytes);
  const row: Attachment = {
    id,
    user_id: userId,
    post_id: null,
    r2_key: r2Key,
    filename,
    content_type: contentType,
    size: file.size,
    image_id: imageId,
    width: null,
    height: null,
    created_at: now(),
  };
  await db
    .prepare(
      `INSERT INTO attachments (id, user_id, post_id, r2_key, filename, content_type, size, image_id, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(row.id, userId, r2Key, filename, contentType, row.size, imageId, row.created_at)
    .run();
  return row;
}

/**
 * Upload to Cloudflare Images with a custom id. The id carries the
 * `nodebox-forum-` prefix because image ids are global to the Cloudflare account.
 * Returns null (and the forum falls back to serving the R2 original) when
 * Images isn't configured or the upload fails.
 */
export async function uploadToImages(env: Bindings, imageId: string, filename: string, contentType: string, bytes: ArrayBuffer): Promise<string | null> {
  if (!env.CF_ACCOUNT_ID || !env.CF_IMAGES_TOKEN) return null;
  const form = new FormData();
  form.append("file", new File([bytes], filename, { type: contentType }));
  form.append("id", imageId);
  form.append("metadata", JSON.stringify({ project: "nodebox-forum" }));
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/images/v1`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_IMAGES_TOKEN}` },
    body: form,
  });
  if (!res.ok) {
    console.error(`Cloudflare Images upload failed for ${imageId}: ${res.status} ${await res.text()}`);
    return null;
  }
  return imageId;
}

/** Delete a post's files: the R2 objects, their Cloudflare Images copies and the rows. */
export async function deletePostFiles(env: Bindings, postId: number): Promise<void> {
  const { results } = await env.DB.prepare("SELECT * FROM attachments WHERE post_id = ?").bind(postId).all<Attachment>();
  for (const a of results) {
    await env.FILES.delete(a.r2_key);
    if (a.image_id) await deleteFromImages(env, a.image_id);
  }
  await env.DB.prepare("DELETE FROM attachments WHERE post_id = ?").bind(postId).run();
}

async function deleteFromImages(env: Bindings, imageId: string): Promise<void> {
  if (!env.CF_ACCOUNT_ID || !env.CF_IMAGES_TOKEN) return;
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/images/v1/${encodeURIComponent(imageId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${env.CF_IMAGES_TOKEN}` },
  });
  if (!res.ok && res.status !== 404) console.error(`Cloudflare Images delete failed for ${imageId}: ${res.status} ${await res.text()}`);
}

/** Where to show an image attachment: a resized variant if we have one, else the original. */
export function imageUrls(env: Bindings, a: Attachment): { src: string; thumb: string; full: string } {
  const full = fileUrl(a);
  if (a.image_id && env.CF_IMAGES_HASH) {
    const base = `https://imagedelivery.net/${env.CF_IMAGES_HASH}/${encodeURIComponent(a.image_id)}`;
    return { src: `${base}/${env.CF_IMAGES_VARIANT_POST}`, thumb: `${base}/${env.CF_IMAGES_VARIANT_THUMB}`, full };
  }
  return { src: full, thumb: full, full };
}

export function fileUrl(a: Pick<Attachment, "id" | "filename">): string {
  return `/files/${a.id}/${encodeURIComponent(a.filename)}`;
}

/** Images, video and sound open in the browser; everything else downloads. */
export function dispositionFor(filename: string, contentType: string): string {
  const kind = isImage(contentType) || playable({ filename, content_type: contentType }) ? "inline" : "attachment";
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function fileKind(a: Pick<Attachment, "filename" | "content_type">): "nodebox" | "zip" | "image" | "file" {
  const name = a.filename.toLowerCase();
  if (name.endsWith(".ndbx")) return "nodebox";
  if (name.endsWith(".zip") || a.content_type === "application/zip") return "zip";
  if (isImage(a.content_type)) return "image";
  return "file";
}

/** One byte range from a Range header (`bytes=0-99`, `bytes=100-`, `bytes=-500`); several ranges get the whole file. */
export function parseRange(header: string | undefined, size: number): { offset: number; length: number } | "unsatisfiable" | null {
  const m = header && /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const suffix = Math.min(Number(m[2]), size);
    return suffix === 0 ? "unsatisfiable" : { offset: size - suffix, length: suffix };
  }
  const start = Number(m[1]);
  if (start >= size) return "unsatisfiable";
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (end < start) return null;
  return { offset: start, length: end - start + 1 };
}
