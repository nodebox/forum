# NodeBox forum

Replaces the Tender-hosted NodeBox forum with our own on Cloudflare. `docs/PLAN.md` has the decisions and what is still open.

## Map

- `src/`, `migrations/`, `test/`: the Tender exporter and the spam filter. They fill `data/forum.sqlite` and `data/attachments/`. See `README.md`.
- `web/`: the forum, a Cloudflare Worker (Hono, D1, R2). Also the importer and the attachment uploader, in `web/scripts/`. See `web/README.md`.
- `data/`: git-ignored. It holds the export, with people's email addresses and private helpdesk messages. Never commit it or upload it.

## Working here

- Branch policy: commit straight to `main` and push. No pull requests.
- Verify: `npm test && npm run typecheck` in the root, and the same two commands in `web/`.
- Deploy: Cloudflare Workers Builds deploys `web/` on every push to `main` (tests, D1 migrations, then deploy). Setup and rollback: `web/DEPLOY.md`.
- Secrets come from 1Password: `npm run env` writes `.env` from `.env.template`.

## Rules of the data

- Private Tender discussions are not imported.
- A user is imported only with at least one visible public post.
- An attachment belongs to one post. Its file is at `posts/<post id>/<attachment id>/<filename>` in R2; an upload waits in `pending/` until its post exists.
