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

## Import from Tender

```sh
npm run import:tender                         # ../data/forum.sqlite → ../data/import.sql
npx wrangler d1 execute nodebox-forum --local --file ../data/import.sql
```

Run it against an empty, freshly migrated database. If the spam filter
(`npm run spam` in the repo root) has run, everything in its `spam_excluded`
view comes in with status `spam` (hidden, restorable from `/admin`).

## Tests

`npm test` runs the importer against a small Tender fixture, and the app itself
in Node against local D1/R2 (wrangler's platform proxy): sign-in by email link,
claiming an imported account, posting with an attachment, reactions,
moderation, CSRF and old-URL redirects.

## Deploy

Pushing to `main` tests, migrates and deploys through GitHub Actions. Setup,
the first deploy and rollback are in [DEPLOY.md](DEPLOY.md).
