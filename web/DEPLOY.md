# Deploying the forum

Cloudflare Workers Builds deploys the forum on every push to `main`. In the
Worker's settings (Workers & Pages → nodebox-forum → Settings → Build):

| Setting | Value |
| --- | --- |
| Git repository | `nodebox/forum`, production branch `main` |
| Root directory | `web` |
| Build command | `npm run ci:build` (typecheck, tests, client bundle) |
| Deploy command | `npm run ci:deploy` (D1 migrations, then `wrangler deploy`; passes the build's `WORKERS_CI_COMMIT_SHA` as `GIT_COMMIT` for the footer) |
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
   resized variant, an old Tender path (`/discussions/…`) on the forum redirects.

## Read-only until the move

`READ_ONLY` in `wrangler.jsonc` is `"true"` while Tender is still the forum:
everyone can read and sign in, only admins can post, and every page says so.
At the switch, do the final import first, then remove `READ_ONLY` and push.

## The move, step by step

On the machine with `data/`, from the repo root:

1. Point `support.nodebox.net` at the Worker (below). That also stops people
   posting on Tender, so the export after it is the last one.
2. `npm run export -- --refresh` fetches what changed on Tender since the last run.
3. `npm run spam -- classify` checks only what it hasn't seen yet. Then
   `npm run spam -- review`, fill in the rows without a decision, and
   `npm run spam -- apply data/spam-review.csv`.
4. Note the time (`date -u +%FT%TZ`) for D1 Time Travel, in case the next
   step has to be undone.
5. In `web/`: `npm run import:tender -- --top-up` reads production D1 and
   writes `../data/top-up.sql` with only what is new. Check the counts it
   prints, then `npx wrangler d1 execute nodebox-forum --remote --file ../data/top-up.sql`.
6. `npm run upload:attachments:remote` uploads the new files; files already
   there are skipped.
7. Remove `READ_ONLY` from `wrangler.jsonc`, and change or remove
   `FORUM_NOTICE`, the banner on every page. Commit and push.

## The old domain

Once Tender is switched off, point `support.nodebox.net` at the Worker so old
links keep working: delete its DNS record (the CNAME to Tender) and add it as a
second custom domain of the Worker. Every request on a host in `LEGACY_HOSTS`
gets a 301 to the same page on `PUBLIC_URL`: old discussion URLs go to their
topic (found by the discussion number, so moved and renamed discussions
resolve too), category pages to their category, anything else to the same
path, where it shows the forum's not-found page. Links to `*.tenderapp.com`
can't be redirected; the import rewrites those inside posts instead.

Check: `curl -sI https://support.nodebox.net/discussions/<category>/<number>-<slug>`
answers 301 with the topic's URL.

## Deploying by hand

When Workers Builds can't run, `npm run deploy` does the same as a build: it
applies the D1 migrations, then deploys. Code that expects a migration fails on
every page until that migration has run.

The footer shows the deployed commit only when the working tree is clean:
with uncommitted changes there is no commit to link to. A bare
`npx wrangler deploy` shows no version.

## Rolling back

- Code: `npx wrangler rollback` (or pick a version under Workers → Deployments).
- Data: D1 Time Travel, `npx wrangler d1 time-travel restore nodebox-forum --timestamp <ISO time>`.
  Migrations only go forward; a bad one is fixed by a new migration or a restore.
- Older than 30 days, or the database or account is gone: the backups below.

## Backups

The forum, its bucket and the backup bucket are in the Sint Lucas Cloudflare
account (`account_id` in `wrangler.jsonc`).

`.github/workflows/backup.yml` runs `backup/backup.sh` every night at 03:23 UTC
and on demand (`gh workflow run backup.yml`). It writes to the private R2 bucket
`nodebox-forum-backup` and, when `STORAGEBOX_HOST` is set, to a Hetzner Storage
Box sub-account:

| Path | What | Kept |
| --- | --- | --- |
| `d1/daily/forum-<day>.sql.gz` | D1 as SQL, from `/backup.sql`: schema, then data | 35 days |
| `d1/monthly/forum-<day>.sql.gz` | the dump of the 1st | 400 days |
| `files/` | the `nodebox-forum` bucket as it is now | |
| `files-removed/<day>/` | files that left the bucket that day | 90 days |
| `archive/` | the Tender export, `nodebox-tender-archive-2026-10-25.zip` | always |

The script prunes by the date in the name, on both sides. Before it writes, it
loads the dump into SQLite and checks integrity, foreign keys, the row counts
on its last line, and the search index. It stops before syncing when the
source has fewer than 90% of the mirrored files.

The forum writes the dump itself (`src/backup.ts`) at `/backup.sql`, for a
request with `Authorization: Bearer <BACKUP_TOKEN>`; without the secret, or with
a wrong token, the page is a 404. A D1 API token can't be limited to one
database, and this account holds others; the Worker's binding reaches only this
one. All tables are read in one batch, so the dump is one moment. It leaves out
`sessions`, `login_tokens` and `rate_limits` (after a restore everyone signs in
again) and the search tables, which their triggers fill again on load. Its last
line counts each table's rows. (`wrangler d1 export` refuses this database
anyway, because of the FTS5 tables.)

The backups hold email addresses. Neither the bucket nor the sub-account is public.

### Setup

1. Bucket and locks (done; needs a `wrangler login` with R2 scopes):
   `npx wrangler r2 bucket create nodebox-forum-backup --location weur`,
   `npx wrangler r2 bucket lock add nodebox-forum-backup d1 d1/ --retention-days 30`,
   `npx wrangler r2 bucket lock add nodebox-forum-backup archive archive/ --retention-indefinite`.
   A lock stops anyone with an R2 key from deleting or overwriting what it covers;
   `files/` has none, because the mirror follows deletions.
2. R2 API tokens (R2 → Manage API tokens, account tokens): one with Object Read
   only on `nodebox-forum`, one with Object Read & Write only on
   `nodebox-forum-backup`. In 1Password: `op://NodeBox/NodeBox Forum/Cloudflare/CF_R2_NODEBOX_FORUM`
   and `…/CF_R2_NODEBOX_FORUM_BACKUP`. The workflow turns each into an S3 key
   (the token's ID, and the SHA-256 of the token).
3. The dump's token: a random value (`openssl rand -hex 32`) in 1Password at
   `op://NodeBox/NodeBox Forum/Cloudflare/BACKUP_TOKEN`, set on the Worker with
   `npm run secrets` and in GitHub as `BACKUP_TOKEN`.
4. Storage Box: a sub-account with SSH on and base directory
   `nodebox-forum-backup`; a new key pair, installed with
   `cat key.pub | ssh -p 23 <sub-account>@<host> install-ssh-key`; and
   automatic snapshots on the box, which the sub-account's key cannot delete.
5. GitHub (Settings → Environments → `backup`, deployment branch `main` only).
   Variables: `CLOUDFLARE_ACCOUNT_ID` (`40728e030c0e1a608b66d84b0de7ac62`),
   `BACKUP_URL` (`https://forum.nodebox.net/backup.sql`), `STORAGEBOX_HOST`, `STORAGEBOX_USER`,
   `STORAGEBOX_KNOWN_HOSTS` (`ssh-keyscan -p 23 <host>`). Secrets:
   `BACKUP_TOKEN`, `R2_LIVE_TOKEN`, `R2_BACKUP_TOKEN`,
   `STORAGEBOX_SSH_KEY`.
6. Once, the Tender archive, from a machine with rclone remotes `r2` and `sb` for the two:
   `rclone copyto data/nodebox-tender-archive-2026-10-25.zip r2:nodebox-forum-backup/archive/nodebox-tender-archive-2026-10-25.zip`,
   and the same to `sb:nodebox-forum/archive/`.

GitHub turns off scheduled workflows in a public repository after 60 days
without a commit, and emails before it does; turn it back on under Actions.

### Restore

With the same rclone remotes. The database, into a new D1 (the dump creates every table, the search index
and its triggers):

```sh
rclone copyto r2:nodebox-forum-backup/d1/daily/forum-<day>.sql.gz . && gunzip forum-<day>.sql.gz
npx wrangler d1 create nodebox-forum-restored
npx wrangler d1 execute nodebox-forum-restored --remote --file forum-<day>.sql
```

Then put its `database_id` in `wrangler.jsonc` and deploy. To try a dump
first, load it into a throwaway local state and run the forum on it:
`npx wrangler d1 execute nodebox-forum --local --persist-to /tmp/restore --file forum-<day>.sql`,
then `npx wrangler dev --persist-to /tmp/restore`.

The files: `rclone copy r2:nodebox-forum-backup/files r2:nodebox-forum`, or one
day's `files-removed/<day>/` for files deleted by mistake.
