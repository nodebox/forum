# 1Password template. Resolve with:  npm run env   (runs `op inject -i .env.tpl -o .env`)
# or skip writing .env at all:        op run --env-file=.env.tpl -- npm run export
TENDER_API_KEY={{ op://NodeBox/NodeBox Tender Forum/credential }}
TENDER_SITE=nodebox
