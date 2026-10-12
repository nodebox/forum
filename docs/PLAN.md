# Plan: the new NodeBox forum

The forum replaces the Tender-hosted NodeBox support forum. It runs as one
Cloudflare Worker (Hono + TypeScript) with D1 for data, R2 for files and
Cloudflare Images for screenshot variants. The code lives in `web/`; the Tender
exporter stays in `src/` and keeps writing `data/forum.sqlite`.

Decisions taken here are marked **Decided**. Things Frederik has to answer or
set up are marked **Needs Frederik**.

## 1. Accounts and sign-in

**Decided: no passwords at all.** Two ways in, both tied to an email address:

1. **Continue with Google** (OpenID Connect). We trust Google's email only when
   `email_verified` is true, and then link the Google identity to the user with
   that email.
2. **Email me a sign-in link** (magic link, valid 15 minutes, single use).

An imported Tender user "claims" their old account just by signing in with the
same email, by either route. No reset step, no migration email needed for it
to work. New people sign up through the same two buttons; the first sign-in
asks for a display name.

Why both and not Google only: an imported user whose email is not a Google
account (a university address, an old ISP address, a Fastmail user) could
never reach their account with Google alone. Magic links cover them and replace
the password-reset flow the brief mentions, so we don't need a reset flow at all.

Sessions are a random token in an `HttpOnly; Secure; SameSite=Lax` cookie;
the database stores only its SHA-256. Cross-site form posts are rejected on
the `Origin` header (Hono's `csrf()`), which together with `SameSite=Lax` covers
CSRF without per-form tokens.

The link in the sign-in email opens a page with a "Sign in" button rather than
signing in straight away, because corporate mail scanners open links to check
them and would otherwise use up the single-use token.

**Needs Frederik:**
- A Google Cloud OAuth client (web application). Redirect URI:
  `https://<forum domain>/auth/google/callback` plus
  `http://localhost:8787/auth/google/callback` for development. Secrets go in
  `wrangler secret put GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
- **Decided:** sign-in links go out through Cloudflare Email Sending (a
  `send_email` binding). The sending domain has to be onboarded in the
  Cloudflare dashboard. Email is used for sign-in links only: no notification
  emails and no reply-by-email. People read and reply on the forum.
- Bot protection on the sign-in form: Cloudflare Turnstile (a site key and a
  secret). Without it, the magic-link form is an open relay for sending email
  to arbitrary addresses. The form already rate-limits per address.

## 2. Importing the Tender data

`web/scripts/import-tender.ts` reads `data/forum.sqlite` (the Tender export
schema) and writes `data/import.sql` for the forum schema, which
`wrangler d1 execute nodebox-forum --remote --file data/import.sql` loads.

Mapping:

| Tender                         | Forum                                   |
| ------------------------------ | --------------------------------------- |
| categories                     | categories (slug from `permalink`)      |
| discussions (open/assigned/resolved, public) | topics; `resolved` becomes a "solved" flag |
| comments (not `internal`, not `system_message`) | posts; comment 1 is the opening post |
| users                          | users, deduplicated on lowercased email |
| authors without a user row     | placeholder users with no email (cannot sign in) |
| attachments                    | attachments; files go to R2 under `tender/<download path>` |
| image attachments              | also uploaded to Cloudflare Images      |
| `html_href`                    | `legacy_redirects` (old path → new topic) |

Leave out: internal notes, spam, deleted discussions, private categories and
private discussions. The knowledge-base articles become a pinned "Guides"
category (open question below).

Bodies: Tender's `body` is the source text people typed (Markdown-ish). We
render it with the forum's own Markdown renderer, raw HTML disabled. Once the
real export is in, the first job is to sample a few hundred bodies and check
how many contain HTML or Tender-specific syntax; if many do, we convert
`formatted_body` through a sanitizer instead. Links in bodies that point at old
attachment URLs or old discussion URLs get rewritten to the new ones.

Uploading the files is a separate script (`upload-attachments.ts`, to write
once the export is in): it walks `data/attachments/`, puts each file in R2
through the S3-compatible API and pushes images to Cloudflare Images. It is
resumable in the same way the exporter is.

## 3. Attachments and screenshots

- Drag files onto the reply box, paste from the clipboard, or pick them. Upload
  starts the moment a file lands, with a progress bar per file.
- Images (PNG, JPEG, GIF, WebP) appear inline in the post. The original goes
  to R2; a copy goes to Cloudflare Images with the custom ID
  `nodebox-forum-<id>` so it never collides with other projects in the account.
  The post shows a resized variant; clicking opens the original.
- Everything else (ZIPs with `.ndbx` projects, loose `.ndbx` files) becomes a
  download card under the post with name, size and type. Downloads are served
  by the Worker from R2 with `Content-Disposition: attachment`.
- Limit: 50 MB per file (Workers accept request bodies up to 100 MB on the
  free and Pro plans). Executables are refused.

**Needs Frederik:** Cloudflare Images variant names are global to the account,
just like image IDs. The code asks for two variants, configured by name in
`wrangler.jsonc` (`nodebox-forum-post`, 1200 px wide, and
`nodebox-forum-thumb`, 400 px). Either create those two, or turn on flexible
variants and we'll request sizes directly. An API token with
`Cloudflare Images: Edit` goes in `wrangler secret put CF_IMAGES_TOKEN`.

## 4. The interface

Server-rendered pages (Hono's `html` templates), a single small script for the
composer and reactions. Every page works without JavaScript except
drag-and-drop and live reactions.

Pages: home (categories and latest topics), category, topic, new topic, sign
in, profile/settings, search.

Kept out on purpose: tags, signatures, private messages, ranks, badges,
polls, subscriptions per category, rich-text toolbar. Posts are Markdown with a
Write/Preview toggle and a one-line hint.

Reactions: six fixed emoji (👍 ❤️ 😄 🎉 🤔 👀), one click to add, one to
remove, counts with the names of who reacted on hover. A fixed set keeps the
row tidy and saves an emoji picker.

Type: Atkinson Hyperlegible Next for text, Atkinson Hyperlegible Mono for code,
self-hosted (no Google Fonts requests, which also avoids the GDPR question of
sending visitors' IPs to Google). 17 px base, 1.6 line height, 68-character
measure for post text.

Colour: the NodeBox blue, blue-tinted neutrals (near-black to near-white),
orange as the single accent for calls to action, unread markers and the
"new forum" banner. Light and dark mode follow the system setting. The exact
blue in `web/public/styles.css` is a stand-in.

**Needs Frederik:** the hex values of the nodebox.net blue (and the orange, if
there is one already).

"This is a new forum" is said three times: a dismissible orange banner on every
page for the first weeks, a short note on the sign-in page ("Had an account on
the old forum? Sign in with the same email and your posts are waiting"), and
an "Imported from the old forum" label on imported topics.

Search: SQLite FTS5 inside D1 over topic titles and post bodies.

Topic authors can mark their own topic solved.

## 4b. Moderation

**Decided, lightweight:**

- The first admin is made from the command line
  (`npm run admin -- grant <email> --remote`), which works even before that
  person has signed in. From then on, admins promote or demote others at
  `/admin/users`.
- On every post, admins get a small "Moderate" menu: **Mark as spam** (with an
  option to ban the author and hide all their posts at once) or **Remove** for
  breaking the acceptable use policy, with a reason from a short list.
  Removing or marking the opening post hides the whole topic.
- Admins can pin and lock topics, and ban or unban people.
- Nothing is deleted. A post has a status (`visible`, `spam`, `removed`);
  hidden posts are listed at `/admin` and can be restored. Every action goes in
  a moderation log.
- Spam that the import's spam filter flags arrives with status `spam`, in the
  same queue, so a false positive is one click to restore. The filter writes
  its verdicts to a `spam_verdicts` table in `data/forum.sqlite`
  (`discussion_id`, `comment_number` or NULL for the whole discussion,
  `is_spam`, `reason`).

**Needs Frederik:** the acceptable use policy text itself (the removal reasons
in `web/src/moderation.ts` are a first guess at its headings).

## 5. Launch and cutover

1. Build against the trial export; review the design together.
2. Create the D1 database, R2 bucket and Images variants; deploy to a staging
   hostname (`forum-staging.nodebox.net` or a `workers.dev` URL).
3. Full import into staging; spot-check old threads against Tender.
4. Freeze Tender (read-only notice), run `npm run export -- --refresh`, re-import.
5. Point the forum domain at the Worker. If the old forum lived on a domain we
   control (`support.nodebox.net`?), point that at the Worker too and let
   `legacy_redirects` send old links to the new topics. Links to
   `*.tenderapp.com` cannot be redirected.
6. Announce on nodebox.net and the newsletter/social channels.

**Needs Frederik / legal:** emailing every imported user to announce the move
is a separate decision from importing them. It is processing personal data for
a new purpose; check the basis (legitimate interest is the usual argument)
before sending. Also update the privacy notice on the new forum to say which
data came over from Tender.

## 6. Open questions

1. Forum domain: `forum.nodebox.net`? And what was the old public domain?
2. The sending address for sign-in links (`forum@nodebox.net`?).
3. Knowledge-base articles: import as a "Guides" category, or move them to the
   NodeBox docs site?
4. The acceptable use policy text, and who the admins are on day one.
5. Should imported users who never posted be imported at all? Data
   minimisation says no; the code imports only users who wrote something.

## 7. Build order

1. Schema, layout, typography and palette, read-only pages.
2. Sign-in: magic link (dev mailer logs the link), Google (behind env vars), sessions.
3. Posting, replies, drag-and-drop uploads to R2, images through Cloudflare Images.
4. Reactions.
5. Tender → forum SQL import script, tested on a fixture.
6. Search, profile page, moderation tools.
7. Attachment uploader script, legacy redirects, staging deploy.

Steps 1 to 5, plus moderation, are built, in `web/`, on the `claude/forum-app-cirr7p` branch.
