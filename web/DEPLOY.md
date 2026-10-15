# Deploying the forum

Cloudflare Workers Builds deploys the forum on every push to `main`. In the
Worker's settings (Workers & Pages → nodebox-forum → Settings → Build):

| Setting | Value |
| --- | --- |
| Git repository | `nodebox/forum`, production branch `main` |
| Root directory | `web` |
| Build command | `npm run ci:build` (typecheck, tests, client bundle) |
| Deploy command | `npm run ci:deploy` (D1 migrations, then `wrangler deploy`) |
| Non-production branch builds | Off. Preview versions would use the production D1 database and R2 bucket |

A failing test stops the build, so nothing is deployed. Migrations run before
the new code is live, so every migration must keep the running version
working: add tables and columns, don't drop or rename them in the same
release. Node comes from `web/.node-version` (22).

The build's API token needs **D1 → Edit** on top of the Workers permissions,
or the migration step fails with an authorisation error. If the token
Cloudflare creates for the build lacks it, edit that token (or pick one that
has it) under the build settings.

GitHub Actions (`.github/workflows/forum.yml`) only runs the tests on pull
requests; it holds no Cloudflare credentials.

## One-time setup

| What | Where |
| --- | --- |
| D1 database | Created; its id is in `wrangler.jsonc` |
| R2 bucket | `npx wrangler r2 bucket create nodebox-forum` |
| Hostname | After the first deploy: add `forum.nodebox.net` as a custom domain (`routes` in `wrangler.jsonc`). Until then the forum runs on its workers.dev URL |
| Email | Onboard `nodebox.net` for Email Sending in the dashboard; sender is `MAIL_FROM` (`forum@nodebox.net`) |
| Images | Uses the account's existing variants `medium` (1000 px wide, in posts) and `thumb` (600 × 600, galleries) |
| Worker secrets | `npm run secrets` copies `CF_ACCOUNT_ID`, `CF_IMAGES_HASH`, `CF_IMAGES_TOKEN` (`op://NodeBox/NodeBox Forum/Cloudflare/…`) and `ANTHROPIC_API_KEY` (spam filter) from 1Password |
| Git connection | The build settings above. Connect it last: the first build deploys |

## First deploy

1. Merge this setup to `main` with the database id filled in. Nothing deploys
   while the repository isn't connected in Cloudflare.
2. Connect the repository in the build settings. The first build creates the
   schema in the empty D1 database and deploys.
3. Load the Tender data from the machine that has `data/` (it contains email
   addresses; it never goes to GitHub):
   `npx wrangler d1 execute nodebox-forum --remote --file ../data/import.sql`
4. Upload the old attachments, from the same machine. This reads the
   production D1 and fills the R2 bucket and Cloudflare Images; it is safe to
   run again after an interruption:
   `npm run upload:attachments:remote`
5. Make the first admin: `npm run admin -- grant <email> --remote`.
6. Check: a sign-in email arrives, an upload works, a screenshot shows its
   resized variant, an old Tender URL redirects.

## Read-only until the move

`READ_ONLY` in `wrangler.jsonc` is `"true"` while Tender is still the forum:
everyone can read and sign in, only admins can post, and every page says so.
At the switch, do the final import first, then remove `READ_ONLY` and push.

## Deploying by hand

When Workers Builds can't run, `npm run deploy` does the same as a build: it
applies the D1 migrations, then deploys. Code that expects a migration fails on
every page until that migration has run.

## Rolling back

- Code: `npx wrangler rollback` (or pick a version under Workers → Deployments).
- Data: D1 Time Travel, `npx wrangler d1 time-travel restore nodebox-forum --timestamp <ISO time>`.
  Migrations only go forward; a bad one is fixed by a new migration or a restore.
