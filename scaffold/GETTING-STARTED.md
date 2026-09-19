# Midlayr Front Desk — getting started

## 0. Accounts (one-time, ~30 min)
- Cloudflare account with Workers Paid plan (Durable Objects, Queues, Hyperdrive need it)
- Neon.tech project `midlayr-frontdesk` (Postgres) — copy the pooled connection string
- Twilio account: one number for Dumont (SMS + voice), webhook URLs set later
- Resend account: verify `dumontprinting.com` for outbound email
- GitHub repo `midlayr/frontdesk`

## 1. Local setup
```bash
npm create cloudflare@latest frontdesk -- --type hello-world --ts
cd frontdesk
npm i hono postgres ulid zod
cp ../scaffold/wrangler.toml .
cp -r ../scaffold/src ./src
wrangler login
```

## 2. Database
```bash
psql "$DATABASE_URL" -f ../scaffold/schema.sql
psql "$DATABASE_URL" -c "INSERT INTO orgs (id, slug, name, brand, comms, features) VALUES
  ('01J...DUMONT', 'dumont', 'Dumont Printing',
   '{\"app_name\":\"Dumont Front Desk\",\"color\":\"#0B7FA8\",\"show_powered_by\":true}',
   '{\"email_from\":\"quotes@dumontprinting.com\",\"sms_number\":\"+1559555XXXX\"}',
   '{\"chat\":true,\"drip\":true,\"pathfinder\":true,\"imports\":true}');
  INSERT INTO counters (org_id, next_ticket) VALUES ('01J...DUMONT', 2000);"
```

## 3. Cloudflare resources
```bash
wrangler hyperdrive create frontdesk --connection-string="$DATABASE_URL"   # paste id into wrangler.toml
wrangler r2 bucket create frontdesk-files
wrangler kv namespace create CONFIG                                        # paste id
wrangler queues create frontdesk-jobs
wrangler queues create frontdesk-dlq
wrangler secret put TWILIO_AUTH_TOKEN
wrangler secret put RESEND_API_KEY
wrangler secret put SESSION_SECRET
wrangler deploy
```

## 4. First loop — SMS in, row in queue, reply out (week 1 target)
1. `src/hooks/twilio-sms.ts`: validate Twilio signature → resolve org by `To` number → find/create contact by `From` → INSERT lead (channel sms) + message → `JOBS.send({kind:'extract_specs'})`
2. `src/jobs/extract-specs.ts`: `env.AI.run('@cf/meta/llama-3.1-8b-instruct', …)` with a strict JSON schema → UPDATE leads spec columns + confidence + missing_fields
3. `GET /api/leads` → return queue sorted live → rush → deadline
4. `POST /api/leads/:id/reply` → Twilio send from `org.comms.sms_number` → status replied
5. Point Twilio's SMS webhook at `https://frontdesk.<worker>.workers.dev/hooks/twilio/sms`, text the number, watch the row appear.

## 5. Then, in order
- Voice: Twilio voicemail → R2 → `transcribe` job (Whisper) → same extract path
- Email: Resend inbound or Cloudflare Email Routing → `/hooks/email`
- Front end: Pages project; port Leads Inbox and Midlayr Chat prototypes to React, theme from `GET /api/org`
- Chat widget: `chat.js` on cdn.midlayr.com reads `/widget/config`, opens `ChatSession` DO socket
- Realtime: `InboxRoom` DO pushes new leads to open queues
- Cron: drip sends + SLA nudges

## Conventions
- IDs: `ulid()` everywhere. Never autoincrement.
- Every query goes through `db(orgId)` which runs `SET LOCAL app.org_id` in a transaction.
- Every Queue job body includes `orgId`. Every R2 key starts with `org/<orgId>/`.
- Nothing Dumont-specific in code; read from the org row.
- Branches: `main` deploys to prod, PRs get preview URLs via `wrangler versions upload`.
