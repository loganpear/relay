# Host Relay on Cloudflare

Cloudflare Workers with SQLite-backed Durable Objects can run Relay without keeping a personal computer on. The free plan has usage limits: check the [current pricing](https://developers.cloudflare.com/workers/platform/pricing/) before deploying or inviting a large team. No paid plan is required for this configuration.

## Deployment

1. Create a free Cloudflare account, then run `npm install` in this repository with Node 24 or newer.
2. Run `npx wrangler login --scopes account:read user:read workers:write workers_scripts:write --use-keyring` and review its account authorization. This requests account/user read, Workers write, Workers Scripts write, and background access. Workers Scripts write covers deploying scripts, Durable Objects, subdomains, and scheduled triggers; Workers write alone is insufficient. This avoids requesting Wrangler's broader default permissions for unrelated products.
3. Create the Slack app in a developer sandbox using `slack-manifest.json`. Keep image uploads off unless you actually need them; the default scopes are `commands`, `chat:write`, and `users:read`.
4. Store the sandbox app's values privately with `npx wrangler secret put SLACK_SIGNING_SECRET`, `npx wrangler secret put SLACK_BOT_TOKEN`, and `npx wrangler secret put SLACK_TEAM_ID`. You can optionally set `SLACK_ALLOWED_CHANNEL_ID` as a secret to lock commands and card buttons to a private test channel. Never use a real club's credentials or database for a public sandbox demonstration.
5. Run `npm run deploy:cloudflare`. If Cloudflare asks you to choose a workers.dev subdomain, choose a suitable free subdomain. Do not add a paid subscription.
6. Replace the placeholder origins in your Slack app configuration with the Worker URL: `/slack/commands` for both slash commands, `/slack/actions` for interactivity, and `/slack/events` for app Home events. Ensure Socket Mode is disabled for this sandbox app. Complete Slack's URL verification and install the app.
7. Add Relay to a private sandbox channel, create a task with `/task`, complete it, and check the updated card and notification. Test Home task creation separately. Only test with consenting accounts.

`GET /health` reports whether Slack configuration is present. All Slack POST endpoints require a valid signature and the configured workspace. Other routes, including the local demo, are unavailable. Until the secrets are set, Slack endpoints return 503.

## Storage and reminders

Each configured workspace routes to one durable object. Its SQLite database stores tasks, permissions/history, notification queues, time zones, and sent-reminder receipts. The shared TaskStore uses a synchronous adapter with Cloudflare's `transactionSync`, so task updates and queue inserts remain atomic. Fresh cloud databases start with the current schema; no local data is uploaded automatically.

A Cron Trigger checks queued deliveries and reminders once a minute, even when nobody has the app open. Daily summaries use each assignee's time zone. In-memory delivery jobs are serialized; scheduled retries resume persisted queue entries after restarts. Slack posting can still duplicate if Slack accepts a request but the network loses its response before Relay saves the receipt.

When changing database migrations, update the fresh-cloud schema in `src/cloudflare-schema.js` and verify compatibility with Cloudflare SQL. Node's legacy migration pragmas are not a way to disable foreign-key enforcement in Cloudflare. Test schema changes against existing cloud data before release.

## Local verification

`npm test` runs the normal Node tests plus a Cloudflare runtime integration test. Slack API traffic in that test is mocked; no real user receives messages. It covers signed requests, wrong-workspace/unauthorized actions, duplicate delivery, persistent storage after a runtime restart, and reminder deduplication.

For an interactive local Worker, create a private `.dev.vars` with synthetic or sandbox-specific values and run `npm run dev:cloudflare`. This file and `.wrangler/` are gitignored. Keep your local Socket Mode worker separate; never run multiple workers against the same Slack app/database.
