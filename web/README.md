# NodeBox Forum (web)

The forum itself: one Cloudflare Worker (Hono, server-rendered) with D1, R2,
Cloudflare Images and Cloudflare Email Sending. See `../docs/PLAN.md` for the
why; this file is the how.

## Run it locally

```sh
npm install
npm run db:migrate:local      # create the local D1 schema
npm run db:seed:local         # sample categories, topics and users (optional)
npm run dev                   # http://localhost:8787
```

Sign in with any address: with `MAILER=log` (the default) the sign-in email is
printed in the terminal and the link also appears on the "Check your email"
page. To try the Google button, put `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` in `.dev.vars`; the redirect URI is
`http://localhost:8787/auth/google/callback`.

Without `CF_ACCOUNT_ID`/`CF_IMAGES_TOKEN`/`CF_IMAGES_HASH`, images are served
as originals from R2 instead of resized Cloudflare Images variants.

The spam filter on new posts needs `ANTHROPIC_API_KEY`. `npm run env` writes it
to `.env` from 1Password (`.env.template`, needs the `op` CLI signed in), and
`wrangler dev` reads `.env`. Without the key no post is checked.

## Admins

The first admin comes from the command line; after that, admins promote others
at `/admin/users`.

```sh
npm run admin -- grant you@example.com            # local database
npm run admin -- grant you@example.com --remote   # production
npm run admin -- list --remote
```

`grant` works before the person has signed in: their first sign-in with that
email picks up the admin account. Admins get a "Moderate" menu on every post
(mark as spam, optionally banning the author and hiding all their posts; or
remove for breaking the acceptable use policy, with a reason) and Pin/Lock on
topics. Nothing is deleted: hidden posts stay in the database and show up at
`/admin` (Spam, Removed), where they can be restored. Every action is in the
log at `/admin/log`.

## Profile pictures

People set a picture in Settings. The browser crops it to the circle and uploads
a 256 by 256 WebP (PNG in Safari), so the server only checks the bytes (PNG,
JPEG, WebP or GIF, up to 1 MB) and stores it in R2 at
`avatars/<user id>/<random id>`; `users.avatar` holds the id. A new picture gets
a new id, so `/avatars/...` is cached for good and the old file is deleted.
A banned person's picture isn't shown (but kept, in case of an unban). Admins
can remove anyone's picture in Moderation > People; that is logged.

## Import from Tender

```sh
npm run import:tender                         # ../data/forum.sqlite → ../data/import.sql
npx wrangler d1 execute nodebox-forum --local --file ../data/import.sql
npm run upload:attachments                    # ../data/attachments → local R2
                                              # (production: see DEPLOY.md)
```

Run it against an empty, freshly migrated database. If the spam filter
(`npm run spam` in the repo root) has run, everything in its `spam_excluded`
view comes in with status `spam` (hidden, restorable from `/admin`). To start
over, delete `.wrangler/state` and run `npm run db:migrate:local` first.

Links in posts to the old forum (`support.nodebox.net`, `*.tenderapp.com`)
are rewritten to the new topics, categories and files. A bare URL becomes an
absolute link on `https://forum.nodebox.net`; set `FORUM_URL` to import for
another host (`FORUM_URL=http://localhost:8787 npm run import:tender`).

Posts from the first import predate that rewriting. `npm run rewrite:links -- --remote`
reads production and writes `../data/rewrite-links.sql` plus a report,
`../data/rewrite-links.md`; it changes nothing until you run the SQL with
`wrangler d1 execute`. Links it can't place (private or deleted discussions)
stay as they are.

## Tests

`npm test` runs the importer against a small Tender fixture, and the app itself
in Node against local D1/R2 (wrangler's platform proxy): sign-in by email link,
claiming an imported account, posting with an attachment, reactions,
moderation, CSRF and old-URL redirects.

## Deploy

Pushing to `main` tests, migrates and deploys through GitHub Actions. Setup,
the first deploy and rollback are in [DEPLOY.md](DEPLOY.md).
