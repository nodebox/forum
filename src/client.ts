import type { Config } from "./config.ts";

export class HttpError extends Error {
  status: number;
  url: string;
  constructor(status: number, url: string, body: string) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 200)}`);
    this.status = status;
    this.url = url;
  }
}

export interface Page<T> {
  items: T[];
  offset?: number;
  total?: number;
  perPage?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Strip RFC 6570 template parts like `{?page}` or `{/state}` from an href. */
export function stripTemplate(href: string): string {
  return href.replace(/\{[^}]*\}/g, "");
}

/** Numeric id from the last path segment of an API href. */
export function idFromHref(href: string | undefined | null): number | null {
  if (!href) return null;
  const m = /\/(\d+)\/?$/.exec(stripTemplate(href).split(/[?#]/)[0]);
  return m ? Number(m[1]) : null;
}

/**
 * Sequential, polite Tender API client: one request at a time, a fixed delay
 * between requests, honours 429 Retry-After and backs off on 5xx / network errors.
 */
export class TenderClient {
  private lastRequest = 0;
  requests = 0;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  url(pathOrHref: string): string {
    if (/^https?:\/\//.test(pathOrHref)) return stripTemplate(pathOrHref);
    return this.config.apiBase + (pathOrHref.startsWith("/") ? "" : "/") + pathOrHref;
  }

  private async throttle() {
    const wait = this.lastRequest + this.config.delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequest = Date.now();
  }

  async raw(url: string, init: { accept?: string; auth?: boolean } = {}): Promise<Response> {
    const headers: Record<string, string> = { Accept: init.accept ?? "application/vnd.tender-v1+json" };
    if (init.auth !== false) {
      // Current docs use a bearer token; older keys used X-Tender-Auth. Sending both is harmless.
      headers.Authorization = `Bearer ${this.config.apiKey}`;
      headers["X-Tender-Auth"] = this.config.apiKey;
    }
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      this.requests++;
      let res: Response;
      try {
        res = await fetch(url, { headers, redirect: "follow" });
      } catch (err) {
        if (attempt >= this.config.maxRetries) throw err;
        const backoff = Math.min(60_000, 1000 * 2 ** attempt);
        console.warn(`  network error on ${url} (${(err as Error).message}), retrying in ${backoff / 1000}s`);
        await sleep(backoff);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= this.config.maxRetries) {
          throw new HttpError(res.status, url, await res.text());
        }
        const retryAfter = Number(res.headers.get("retry-after"));
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(60_000, 1000 * 2 ** attempt);
        console.warn(`  ${res.status} on ${url}, waiting ${Math.round(backoff / 1000)}s`);
        await res.body?.cancel();
        await sleep(backoff);
        continue;
      }
      return res;
    }
  }

  async get<T = any>(pathOrHref: string, query: Record<string, string | number> = {}): Promise<T> {
    const u = new URL(this.url(pathOrHref));
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));
    const res = await this.raw(u.toString());
    if (!res.ok) throw new HttpError(res.status, u.toString(), await res.text());
    return (await res.json()) as T;
  }

  /** One page of a list endpoint. Tender wraps lists as `{offset, total, per_page, <name>: [...]}`. */
  async page<T = any>(pathOrHref: string, page: number, query: Record<string, string | number> = {}): Promise<Page<T>> {
    const body = await this.get<any>(pathOrHref, { ...query, page });
    if (Array.isArray(body)) return { items: body };
    const key = Object.keys(body).find((k) => Array.isArray(body[k]));
    return {
      items: key ? body[key] : [],
      offset: body.offset,
      total: body.total,
      perPage: body.per_page,
    };
  }
}
