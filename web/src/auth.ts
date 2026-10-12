import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv, Bindings } from "./env.ts";
import type { User } from "./db.ts";
import { addSeconds, normalizeEmail, now, randomId, sha256 } from "./util.ts";

export const SESSION_COOKIE = "nbf_session";
const SESSION_DAYS = 60;
export const LOGIN_TOKEN_MINUTES = 15;

function secureCookies(c: Context<AppEnv>): boolean {
  return new URL(c.req.url).protocol === "https:";
}

export async function startSession(c: Context<AppEnv>, userId: number): Promise<void> {
  const token = randomId(32);
  await c.env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), userId, now(), addSeconds(SESSION_DAYS * 86400))
    .run();
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: secureCookies(c),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
}

export async function endSession(c: Context<AppEnv>): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export async function currentUser(c: Context<AppEnv>): Promise<User | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const user = await c.env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.banned_at IS NULL`,
  )
    .bind(await sha256(token), now())
    .first<User>();
  return user ?? null;
}

export interface SignInResult {
  user: User;
  /** True when this sign-in created the account (ask for a display name). */
  isNew: boolean;
  /** True on the first sign-in of an account imported from Tender. */
  claimed: boolean;
}

/**
 * Find the user for a verified email address, creating one if needed.
 * Imported Tender users are matched on email, which is how they get their
 * old posts back without a password.
 */
export async function userForVerifiedEmail(db: D1Database, rawEmail: string, suggestedName?: string): Promise<SignInResult> {
  const email = normalizeEmail(rawEmail);
  const existing = await db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<User>();
  if (existing) {
    const claimed = existing.tender_id !== null && existing.claimed_at === null;
    await db
      .prepare("UPDATE users SET last_seen_at = ?, claimed_at = coalesce(claimed_at, CASE WHEN tender_id IS NOT NULL THEN ? END) WHERE id = ?")
      .bind(now(), now(), existing.id)
      .run();
    return { user: existing, isNew: false, claimed };
  }
  const name = (suggestedName?.trim() || email.split("@")[0]!).slice(0, 60);
  const user = await db
    .prepare("INSERT INTO users (email, name, created_at, last_seen_at) VALUES (?, ?, ?, ?) RETURNING *")
    .bind(email, name, now(), now())
    .first<User>();
  return { user: user!, isNew: true, claimed: false };
}

// --- Magic links -----------------------------------------------------------

export async function createLoginToken(db: D1Database, email: string, next: string): Promise<string> {
  const token = randomId(32);
  await db
    .prepare("INSERT INTO login_tokens (token_hash, email, created_at, expires_at, next) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256(token), normalizeEmail(email), now(), addSeconds(LOGIN_TOKEN_MINUTES * 60), next)
    .run();
  return token;
}

/** Look a token up without using it (for the confirmation page). */
export async function peekLoginToken(db: D1Database, token: string): Promise<{ email: string; next: string } | null> {
  return db
    .prepare("SELECT email, coalesce(next, '/') AS next FROM login_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
    .bind(await sha256(token), now())
    .first<{ email: string; next: string }>();
}

/** Use a token once. Returns its email, or null when it is unknown, used or expired. */
export async function consumeLoginToken(db: D1Database, token: string): Promise<{ email: string; next: string } | null> {
  return db
    .prepare(
      `UPDATE login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
       RETURNING email, coalesce(next, '/') AS next`,
    )
    .bind(now(), await sha256(token), now())
    .first<{ email: string; next: string }>();
}

// --- Google (OpenID Connect) ------------------------------------------------

export function googleEnabled(env: Bindings): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

const GOOGLE_STATE_COOKIE = "nbf_google";

export function googleRedirectUri(env: Bindings): string {
  return `${env.PUBLIC_URL.replace(/\/$/, "")}/auth/google/callback`;
}

export function googleAuthUrl(c: Context<AppEnv>, next: string): string {
  const state = randomId(16);
  const nonce = randomId(16);
  setCookie(c, GOOGLE_STATE_COOKIE, JSON.stringify({ state, nonce, next }), {
    httpOnly: true,
    secure: secureCookies(c),
    sameSite: "Lax",
    path: "/auth/google",
    maxAge: 600,
  });
  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID!,
    redirect_uri: googleRedirectUri(c.env),
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export interface GoogleProfile {
  sub: string;
  email: string;
  name?: string;
}

/**
 * Finish the Google flow: check state, exchange the code, and read the ID
 * token. The token comes straight from Google's token endpoint over TLS,
 * authenticated with our client secret, so per OIDC Core 3.1.3.7 its
 * signature need not be re-verified; we still check issuer, audience, expiry
 * and nonce.
 */
export async function finishGoogle(c: Context<AppEnv>): Promise<{ profile: GoogleProfile; next: string }> {
  const saved = getCookie(c, GOOGLE_STATE_COOKIE);
  deleteCookie(c, GOOGLE_STATE_COOKIE, { path: "/auth/google" });
  if (!saved) throw new Error("The sign-in took too long or cookies are blocked. Please try again.");
  const { state, nonce, next } = JSON.parse(saved) as { state: string; nonce: string; next: string };
  if (c.req.query("state") !== state) throw new Error("Sign-in state mismatch. Please try again.");
  const code = c.req.query("code");
  if (!code) throw new Error(c.req.query("error") === "access_denied" ? "Google sign-in was cancelled." : "Google didn't send a code.");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID!,
      client_secret: c.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: googleRedirectUri(c.env),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status}).`);
  const { id_token } = (await res.json()) as { id_token?: string };
  if (!id_token) throw new Error("Google didn't return an ID token.");
  const claims = decodeJwtPayload(id_token);
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") throw new Error("Unexpected token issuer.");
  if (claims.aud !== c.env.GOOGLE_CLIENT_ID) throw new Error("Token was issued for another app.");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) throw new Error("Token expired.");
  if (claims.nonce !== nonce) throw new Error("Token nonce mismatch.");
  if (claims.email_verified !== true || typeof claims.email !== "string") {
    throw new Error("Your Google account has no verified email address. Use the email sign-in link instead.");
  }
  return { profile: { sub: String(claims.sub), email: claims.email, name: claims.name as string | undefined }, next };
}

export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1];
  if (!part) throw new Error("Malformed token.");
  const json = atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (ch) => ch.charCodeAt(0))));
}

/** Link a Google identity to the user with the same verified email (or a new user). */
export async function userForGoogle(db: D1Database, profile: GoogleProfile): Promise<SignInResult> {
  const linked = await db
    .prepare("SELECT u.* FROM identities i JOIN users u ON u.id = i.user_id WHERE i.provider = 'google' AND i.subject = ?")
    .bind(profile.sub)
    .first<User>();
  if (linked) {
    await db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").bind(now(), linked.id).run();
    return { user: linked, isNew: false, claimed: false };
  }
  const result = await userForVerifiedEmail(db, profile.email, profile.name);
  await db
    .prepare("INSERT OR IGNORE INTO identities (provider, subject, user_id, email, created_at) VALUES ('google', ?, ?, ?, ?)")
    .bind(profile.sub, result.user.id, normalizeEmail(profile.email), now())
    .run();
  return result;
}
