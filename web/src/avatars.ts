import type { Bindings } from "./env.ts";
import { randomId } from "./util.ts";

/**
 * Profile pictures. The browser crops and scales the picture to a small square
 * before it uploads (client/app.ts), so this only has to check and store it.
 * Without the script the original arrives, which is why the limit has room.
 */
export const MAX_AVATAR_BYTES = 1024 * 1024;

/** The picture's type from its first bytes; the browser's word for it isn't trusted. */
export function sniffImage(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
  return null;
}

export const avatarKey = (userId: number, avatar: string) => `avatars/${userId}/${avatar}`;

export const avatarUrl = (userId: number, avatar: string) => `/avatars/${userId}/${avatar}`;

export class AvatarError extends Error {
  readonly status: 400 | 413 | 415;
  constructor(message: string, status: 400 | 413 | 415 = 400) {
    super(message);
    this.status = status;
  }
}

/** Store a new picture for a user and drop the one it replaces. */
export async function setAvatar(env: Pick<Bindings, "DB" | "FILES">, userId: number, file: File): Promise<string> {
  if (file.size === 0) throw new AvatarError("That file is empty.");
  if (file.size > MAX_AVATAR_BYTES) throw new AvatarError("That picture is too large. Pictures can be up to 1 MB.", 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffImage(bytes);
  if (!type) throw new AvatarError("Use a PNG, JPEG, WebP or GIF picture.", 415);
  const avatar = randomId(9);
  await env.FILES.put(avatarKey(userId, avatar), bytes, { httpMetadata: { contentType: type } });
  const old = await env.DB.prepare("SELECT avatar FROM users WHERE id = ?").bind(userId).first<{ avatar: string | null }>();
  await env.DB.prepare("UPDATE users SET avatar = ? WHERE id = ?").bind(avatar, userId).run();
  if (old?.avatar) await env.FILES.delete(avatarKey(userId, old.avatar));
  return avatar;
}

/** Back to initials. Returns false when there was no picture. */
export async function removeAvatar(env: Pick<Bindings, "DB" | "FILES">, userId: number): Promise<boolean> {
  const row = await env.DB.prepare("SELECT avatar FROM users WHERE id = ?").bind(userId).first<{ avatar: string | null }>();
  if (!row?.avatar) return false;
  await env.DB.prepare("UPDATE users SET avatar = NULL WHERE id = ?").bind(userId).run();
  await env.FILES.delete(avatarKey(userId, row.avatar));
  return true;
}
