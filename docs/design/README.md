# Design proposals (October 2026)

Two directions for the forum's look, plus usability fixes they share. Mockups only: nothing
here is wired into `web/`.

- **A · Calm grid**: today's identity (navy header, copper marks), on a stricter grid and a
  five-step type scale.
- **B · Print**: after the Braille Institute print work Atkinson Hyperlegible was made for.
  White header with a heavy navy rule, 52 px underlined headlines, sky-blue and sand colour
  fields instead of hairlines. Replaces the navy header bar and the copper marks.

Shared: a 588 px reading column (about 65 characters at 18/28), a 4 px baseline instead of
8 px, search in the header, excerpts and written-out status (Pinned, No replies yet)
in the topic list, labelled post actions, the welcome note moved into the content column.

## Files

- `build.mjs` writes `mockups/{a,b}-{home,topic}.html` from one set of markup.
- `mockups/base.css` is the shared grid and type; `a.css` and `b.css` set each look.

## Viewing

The mockups load the self-hosted fonts from `/fonts`, so serve them through the forum:

```sh
node docs/design/build.mjs
cp -r docs/design/mockups web/public/_design   # don't commit this copy
cd web && npm run dev                          # http://localhost:8787/_design/a-topic
```
