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
  };
  return (ext && map[ext]) || "application/octet-stream";
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
 * attachment row (not yet linked to a post).
 */
export async function storeUpload(env: Bindings, db: D1Database, userId: number, file: File): Promise<Attachment> {
  if (file.size === 0) throw new UploadError("That file is empty.");
  if (file.size > MAX_UPLOAD_BYTES) throw new UploadError(`Files can be up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`, 413);
  const filename = cleanFilename(file.name);
  if (BLOCKED_EXTENSIONS.test(filename)) throw new UploadError("That kind of file can't be attached.", 415);
  const contentType = guessType(filename, file.type);
  const id = randomId(12);
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "/");
  const r2Key = `uploads/${day}/${id}/${filename}`;
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

/** Images open in the browser; everything else downloads. */
export function dispositionFor(filename: string, contentType: string): string {
  const kind = isImage(contentType) ? "inline" : "attachment";
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
