# Telegram Price Alert Worker

Instructions to deploy to Cloudflare Workers and connect to Telegram.

1. Set up KV namespace `ALERTS`.
2. Add secrets: BOT_TOKEN and COINGECKO_URL
3. Deploy via Cloudflare UI (connect GitHub repo) or wrangler publish.

Commands:
- /set BTC 100000
- /list
- /remove <id>
