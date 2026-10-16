import MarkdownIt from "markdown-it";
import type { Attachment } from "./db.ts";
import { playable } from "./files.ts";

/** How an attachment is shown when a post refers to it by its `/files/<id>/...` URL. */
export interface ImageResolver {
  (attachment: Attachment): { src: string; full: string } | null;
}

export interface RenderContext {
  attachments?: Map<string, Attachment>;
  image?: ImageResolver;
}

// Raw HTML is escaped, never passed through: posts come from anyone.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });

const FILE_URL = /^\/files\/([A-Za-z0-9_-]{8,})(?:\/|$)/;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

md.renderer.rules.image = (tokens, idx, _options, rawEnv, self) => {
  const env = (rawEnv ?? {}) as RenderContext;
  const token = tokens[idx]!;
  const src = String(token.attrGet("src") ?? "");
  const alt = self.renderInlineAsText(token.children ?? [], _options, rawEnv);
  const id = FILE_URL.exec(src)?.[1];
  const attachment = id ? env.attachments?.get(id) : undefined;
  const media = attachment && playable(attachment);
  if (media) return mediaPlayer(media.kind, src, alt || attachment.filename);
  const resolved = attachment && env.image ? env.image(attachment) : null;
  const shown = resolved?.src ?? src;
  const full = resolved?.full ?? src;
  const dims = attachment?.width && attachment.height ? ` width="${attachment.width}" height="${attachment.height}"` : "";
  return (
    `<a class="post-image" href="${esc(full)}" target="_blank" rel="noopener" data-lightbox>` +
    `<img src="${esc(shown)}" alt="${esc(alt)}" loading="lazy" decoding="async"${dims}></a>`
  );
};

/**
 * A video or sound attachment, played in the post. `#t=0.1` makes Safari show
 * the first frame instead of a black box; the link inside is for browsers that
 * can't play the file.
 */
export function mediaPlayer(kind: "video" | "audio", url: string, label: string): string {
  const fallback = `<a href="${esc(url)}" download>${esc(label)}</a>`;
  return kind === "video"
    ? `<video class="post-video" src="${esc(url)}#t=0.1" controls playsinline preload="metadata" aria-label="${esc(label)}">${fallback}</video>`
    : `<audio class="post-audio" src="${esc(url)}" controls preload="none" aria-label="${esc(label)}">${fallback}</audio>`;
}

const defaultLinkOpen = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = String(tokens[idx]!.attrGet("href") ?? "");
  if (/^https?:\/\//i.test(href)) {
    tokens[idx]!.attrSet("rel", "nofollow ugc noopener");
    tokens[idx]!.attrSet("target", "_blank");
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

export function renderMarkdown(source: string, ctx: RenderContext = {}): string {
  return md.render(source, ctx as Record<string, unknown>);
}

/** Attachment ids a post body refers to inline. */
export function referencedAttachmentIds(source: string): Set<string> {
  const ids = new Set<string>();
  for (const m of source.matchAll(/\]\(\/files\/([A-Za-z0-9_-]{8,})[/)]/g)) ids.add(m[1]!);
  return ids;
}

/** Plain-text excerpt for previews and meta descriptions. */
export function excerpt(source: string, max = 180): string {
  const text = source
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
}
