# Handoff: run the Tender export locally

You are in a clone of github.com/nodebox/forum on Frederik's Mac. The code
(`src/`, tested against a fake Tender server in `test/`) exports the NodeBox
forum from the Tender API into `data/forum.sqlite` plus `data/attachments/`.
It has never been run against the real API. Your job: run it, fix whatever
the real API does differently, and report.

Rules: never print, cat or log `.env` or the API key. Don't upload `data/`
anywhere (it contains user emails). Commit code fixes to `main` and push.

1. `git pull`. Check `node -v` is 22.18 or later (it runs .ts directly and
   uses `node:sqlite`). If not, stop and say so.
2. `npm install`. If `.env` doesn't exist, `npm run env` (op inject from
   `op://NodeBox/NodeBox Tender Forum/credential`). If `op` fails on the item
   name with spaces, try the item's ID instead (`op item get "NodeBox Tender Forum" --vault NodeBox --format json | jq -r .id`)
   and update `.env.tpl`.
3. `npm run export -- ping`. On 401: auth header (client.ts sends both
   `Authorization: Bearer` and `X-Tender-Auth`; Tender may want HTTP basic
   with the key as username instead). On 404: `TENDER_SITE` is wrong (the
   permalink in `<site>.tenderapp.com`). On 406: Accept header.
4. Trial: `TENDER_LIMIT=20 npm run export`, then `npm run export -- stats`.
   Check with `sqlite3 data/forum.sqlite` that:
   - categories/discussions/users have ids (parsed from `href` by `idFromHref`);
   - comments exist for the 20 discussions (embedded in `GET /discussions/{id}`,
     30 per page, `?page=2` for more);
   - attachments have `download_path` and downloaded (`local_path` set). If
     downloads 404, find the right host for `TENDER_ASSET_BASE` (try
     `https://nodebox.tenderapp.com`, `https://support.nodebox.net`, or the
     `html_href` host of a discussion).
   If anything is off, fix it, run `npm test` and `npm run typecheck`, commit, push.
5. If clean, run the full `npm run export`. It is resumable: rerun the same
   command after any interruption. Then `npm run export -- stats`.
6. Report: the stats output, any category count mismatches, failures, size of
   `data/` (`du -sh data`), and which fixes you pushed.
