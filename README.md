# NodeBox forum

The plan is to replace the Tender-hosted NodeBox forum with our own forum on
Cloudflare (Hono + TypeScript, D1 for data, R2 for attachments). Step one, in
this repo now, is getting everything out of Tender into a local SQLite database.

## Exporting from Tender

Needs Node 22.18 or later (it runs the TypeScript directly and uses the built-in
`node:sqlite`, so there are no runtime dependencies).

```sh
npm install                # dev tools only (typescript, @types/node)
npm run env                # writes .env from 1Password (op inject on .env.tpl)
npm run export -- ping     # check the key and site name
npm run export             # everything; safe to stop and re-run
```

The key lives in 1Password at `op://NodeBox/NodeBox Tender Forum/credential`.
`npm run env` needs the 1Password CLI (`op`) signed in. Without 1Password, copy
`.env.example` to `.env` and fill it in by hand.

Output goes to `data/` (git-ignored):

- `data/forum.sqlite`: categories, discussions, comments, users, attachment
  metadata and knowledge base articles. Each row keeps the untouched API JSON
  in a `raw` column next to the normalized columns.
- `data/attachments/assets/<hash>/<filename>`: the attachment files, laid out
  like Tender's download paths so the same path can be the R2 key.

The run is sequential and polite: one request at a time with a 400 ms gap
(`TENDER_DELAY_MS`), honouring `Retry-After` on 429 and backing off on 5xx.
Every list page and every discussion is committed as it arrives, so an
interrupted run picks up where it stopped. Individual 4xx failures (a deleted
discussion, a missing file) are recorded in the database and skipped;
`npm run export -- retry-failed` re-queues them.

Steps can be run on their own: `npm run export -- details attachments`. See
`npm run export -- --help`. For a trial run, set `TENDER_LIMIT=20` to fetch
comments for only 20 discussions.

To catch up later (new posts while we build the new forum), run
`npm run export -- --refresh`: it re-walks the lists and re-fetches only
discussions whose `updated_at` changed.

To have Claude Code run and debug the first export: `claude "$(cat HANDOFF.md)"`.

## Schema

`migrations/0001_tender_import.sql` is plain SQLite and D1-compatible, so the
same file can be applied with `wrangler d1 migrations apply`. It is an import
schema that mirrors Tender; the new forum's own schema will be designed
separately and filled from it.

Notes on Tender's data:

- The API doesn't expose comment ids, so comments are keyed by
  `(discussion_id, number)`.
- `body` is the text as written, `formatted_body` is Tender's HTML.
- Internal notes (`internal = 1`) are exported too; leave them out when
  importing into a public forum.
- Discussions keep `html_href`, the old public URL, for redirects.
- User rows contain email addresses. Treat the database as personal data.

## Tests

`npm test` runs the whole export against a fake Tender server
(`test/export.test.ts`), including pagination, a 429, a 404, and resume.
