import type { User } from "./db.ts";

/** Worker bindings. Secrets are optional so the forum runs locally without them. */
export interface Bindings {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  EMAIL: SendEmail;
  SITE_NAME: string;
  PUBLIC_URL: string;
  CF_IMAGES_PREFIX: string;
  CF_IMAGES_VARIANT_POST: string;
  CF_IMAGES_VARIANT_THUMB: string;
  MAILER: string;
  MAIL_FROM: string;
  /** Git commit of this deploy. Workers Builds passes it in (`npm run ci:deploy`); absent in development. */
  GIT_COMMIT?: string;
  /** The old forum's domains (comma-separated). Requests on them redirect to the same page on PUBLIC_URL. */
  LEGACY_HOSTS?: string;
  /** "true" while the forum waits for the move from Tender: members can read and sign in, only admins can write. */
  READ_ONLY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  CF_ACCOUNT_ID?: string;
  CF_IMAGES_TOKEN?: string;
  CF_IMAGES_HASH?: string;
  /** For the spam filter on new posts (src/spamfilter.ts). Without it nothing is checked. */
  ANTHROPIC_API_KEY?: string;
}

export interface Variables {
  user: User | null;
  /** Shown once at the top of the next page (set by redirects through `?notice=`). */
  notice: string | null;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
