#!/bin/sh
# Copies the forum's Cloudflare secrets from 1Password into the Worker.
# Needs the 1Password CLI (op) signed in. Values go from op straight into
# wrangler over a pipe; nothing is printed or written to disk.
set -eu
cd "$(dirname "$0")/.."
for name in CF_ACCOUNT_ID CF_IMAGES_HASH CF_IMAGES_TOKEN; do
  op read "op://NodeBox/NodeBox Forum/Cloudflare/$name" | npx wrangler secret put "$name"
done
