# NodeBox forum

The plan is to replace the Tender-hosted NodeBox forum with our own forum on
Cloudflare (Hono + TypeScript, D1 for data, R2 for attachments). This repo has
two parts: the Tender exporter (here, in `src/`), which gets everything out of
Tender into a local SQLite database, and the forum app in `web/` (see
`web/README.md`). The plan is in `docs/PLAN.md`.

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
  like Tender's download paths.

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

## Filtering spam

Tender only knows about the spam its own filter caught. `npm run spam` finds the
rest (phishing, link drops, casino ads) with Claude, after the export has run.
Nothing is deleted: verdicts go into `spam_verdicts`, and the import leaves out
what is in the `spam_excluded` view.

```sh
npm run spam -- estimate             # how many discussions reach the model, and the cost
npm run spam -- classify --limit=50  # trial run
npm run spam -- classify             # everything; safe to stop and re-run
npm run spam -- review               # writes data/spam-review.csv
npm run spam -- apply data/spam-review.csv
npm run spam -- stats
```

It needs `ANTHROPIC_API_KEY` in `.env`; `npm run env` fills it in from 1Password
(`op://NodeBox/NodeBox Tender Forum/ANTHROPIC_API_KEY`). The model is
`claude-haiku-5-5` at low effort; `SPAM_MODEL` picks another one.

How a discussion is decided:

- Discussions Tender marked as spam are spam (export them with `TENDER_INCLUDE_DELETED=1`).
- A discussion that NodeBox staff replied to, where nobody else posted a link to
  an unknown site, is genuine without asking the model.
- Everything else goes to the model with all its public comments. It returns
  spam, ham or unsure for the discussion, with a confidence, and can flag single
  spam replies inside a genuine discussion.

Model verdicts with confidence 0.9 or more are excluded straight away. The review
CSV lists everything else worth a look, least certain first: all spam and unsure
verdicts, and genuine verdicts below 0.7. Put `spam` or `ham` in the `decision`
column where you want to confirm or overrule, and run `apply`; your decisions win
over the model's. An empty decision keeps the model's verdict.

For the import, `spam_excluded` has `(discussion_id, comment_number, reason)` rows;
`comment_number = 0` drops the whole discussion, any other number drops that reply:

```sql
SELECT * FROM discussions d
WHERE NOT EXISTS (SELECT 1 FROM spam_excluded s WHERE s.discussion_id = d.id AND s.comment_number = 0);

SELECT * FROM comments c
WHERE NOT EXISTS (SELECT 1 FROM spam_excluded s WHERE s.discussion_id = c.discussion_id
                  AND s.comment_number IN (0, c.number));
```

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
