# Deploying the forum

Pushes to `main` that touch `web/` run `.github/workflows/forum.yml`:

1. **test**: `npm ci`, typecheck, tests. Runs on pull requests too.
2. **deploy** (main only, and only once the repository variable
   `DEPLOY_ENABLED` is `true`): builds the client, applies new D1 migrations
   (`wrangler d1 migrations apply --remote`), then `wrangler deploy`.

Migrations run before the new code is live, so every migration must keep the
running version working: add tables and columns, don't drop or rename them in
the same release.

## One-time setup

| What | Where |
| --- | --- |
| D1 database | `npx wrangler d1 create nodebox-forum`, then put its id in `wrangler.jsonc` (`database_id`) |
| R2 bucket | `npx wrangler r2 bucket create nodebox-forum` |
| Hostname | `forum.nodebox.net` in `wrangler.jsonc` (`routes`). The `nodebox.net` zone must be on the same Cloudflare account |
| Email | Onboard `nodebox.net` for Email Sending in the dashboard; sender is `MAIL_FROM` (`forum@nodebox.net`) |
| Images | Variants `nodebox-forum-post` (1200 px wide) and `nodebox-forum-thumb` (400 px) |
| Worker secrets | `npx wrangler secret put CF_ACCOUNT_ID`, `CF_IMAGES_TOKEN` (Images: Edit), `CF_IMAGES_HASH` |
| GitHub secrets | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| GitHub variable | `DEPLOY_ENABLED` = `true` when the above is done |
| Approval (optional) | Settings → Environments → `production` → Required reviewers |

The API token for GitHub: start from the "Edit Cloudflare Workers" template
and add **Account → D1 → Edit**. Limit it to the NodeBox account and the
`nodebox.net` zone.

## First deploy

1. Merge with `DEPLOY_ENABLED` unset: only tests run.
2. Set the secrets and the variable, then run the workflow (Actions → Forum →
   Run workflow). It creates the schema in the empty D1 database and deploys.
3. Load the Tender data from the machine that has `data/` (it contains email
   addresses; it never goes to GitHub):
   `npx wrangler d1 execute nodebox-forum --remote --file ../data/import.sql`
4. Upload the old attachments to R2 and Images (script still to write).
5. Make the first admin: `npm run admin -- grant <email> --remote`.
6. Check: a sign-in email arrives, an upload works, a screenshot shows its
   resized variant, an old Tender URL redirects.

## Rolling back

- Code: `npx wrangler rollback` (or pick a version under Workers → Deployments).
- Data: D1 Time Travel, `npx wrangler d1 time-travel restore nodebox-forum --timestamp <ISO time>`.
  Migrations only go forward; a bad one is fixed by a new migration or a restore.
