# Setting up a Front Desk environment

How to stand this up, and the things that will bite you. No account ids or resource ids
live here — **this repo is public**. Real values go in `SETUP-LOG.md`, which is gitignored.

## Prerequisites
- Cloudflare account on **Workers Paid** (Durable Objects, Queues and Hyperdrive all need it)
- A Postgres (Neon) project
- Twilio account with an SMS-capable number per tenant
- `psql`, and `wrangler` via the repo's devDependencies

npm 11 blocks postinstall scripts, and wrangler will not run without `workerd`'s:
```bash
npm install
npm approve-scripts workerd
npm approve-scripts esbuild
```
Both are recorded in `package.json` → `allowScripts`, so this is a one-time step.

## 1. Database
```bash
export DATABASE_URL='postgresql://…'
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f schema.sql
```

Then check the role RLS will run as:
```sql
SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
```
**Both must be false.** A superuser or `BYPASSRLS` role ignores row-level security entirely,
and every tenant boundary in this schema silently disappears. `FORCE ROW LEVEL SECURITY` in
`schema.sql` covers the ordinary case where the app role *owns* the tables — an owner bypasses
its own policies without it — but nothing can save you from a superuser connection.

## 2. Provision a tenant
`orgs` is not under RLS (tenant resolution reads it before an org context exists), but
`counters` and `users` are, so their inserts must set the context first:

```sql
INSERT INTO orgs (id, slug, name, brand, comms, features) VALUES
 ('<ulid>', '<slug>', '<Display Name>',
  '{"app_name":"<App Name>","color":"#0B7FA8","ticket_prefix":"<XX>","show_powered_by":true}',
  '{"email_from":"<quotes@example.com>","sms_number":"<+1XXXXXXXXXX>"}',
  '{"chat":true,"drip":true,"pathfinder":true,"imports":true}');

BEGIN;
SELECT set_config('app.org_id', '<ulid>', true);
INSERT INTO counters (org_id, next_ticket) VALUES ('<ulid>', 2000);
INSERT INTO users (id, org_id, email, name, role)
  VALUES ('<ulid>', '<ulid>', '<email>', '<name>', 'admin');
COMMIT;
```

- `comms.sms_number` must match Twilio's `To` **exactly**, in E.164. That string is the only
  thing linking an inbound text to a tenant.
- `brand.ticket_prefix` produces `DL-2046`. Code falls back to the slug's first two letters.
  Nothing tenant-specific is compiled in.

> `users.email` is globally `UNIQUE`, not per-org, so one address cannot exist in two tenants.
> Worth changing to `UNIQUE (org_id, email)` before onboarding a second tenant.

## 3. Cloudflare resources
```bash
wrangler hyperdrive create frontdesk --connection-string="$DATABASE_URL"
wrangler r2 bucket create frontdesk-files
wrangler kv namespace create CONFIG
wrangler queues create frontdesk-jobs
wrangler queues create frontdesk-dlq
```
Put the Hyperdrive and KV ids into `wrangler.toml`; R2 and the queues bind by name.

Secrets:
```bash
wrangler secret put TWILIO_SID
wrangler secret put TWILIO_AUTH_TOKEN
wrangler secret put RESEND_API_KEY
wrangler secret put SESSION_SECRET     # openssl rand -base64 32
```

## 4. Deploy and connect Twilio
```bash
npm run typecheck && wrangler deploy
```
Point the number's **A MESSAGE COMES IN** webhook at
`https://<worker>.workers.dev/hooks/twilio/sms`, POST. With the Twilio CLI:
```bash
twilio phone-numbers:update <PN…> --sms-url="https://<worker>.workers.dev/hooks/twilio/sms"
```

Signature validation covers the exact URL. A 403 on every inbound message almost always means
the URL Twilio signed differs from `req.url` — a trailing slash, or `http` vs `https`.

## Architecture notes

| file | role |
|---|---|
| `src/db.ts` | `withOrg()` — the only way to reach tenant data |
| `src/org.ts` | tenant resolution by hostname, and by phone number for webhooks |
| `src/hooks/twilio-sms.ts` | inbound SMS → contact → lead → message → `extract_specs` |
| `src/jobs/extract-specs.ts` | Workers AI → spec columns, confidence, missing fields |
| `src/api/leads.ts` | queue list, ticket detail, reply |
| `src/do/` | `ChatSession` / `InboxRoom` stubs |

Things that are easy to get wrong:

- **`SET LOCAL` takes no bind parameters.** `withOrg` uses
  `SELECT set_config('app.org_id', $1, true)` rather than interpolating an org id into SQL.
- **`fetch_types: false` is required by Hyperdrive**, and it leaves postgres.js unable to parse
  or infer `text[]`. Read such columns through `to_jsonb(...)` and write them through
  `jsonb_array_elements_text(...)`, or `missing_fields` arrives at the client as the string `'{}'`.
- **One Postgres client per request**, closed with `ctx.waitUntil(sql.end())`. Do not open a
  second one inside a handler: a socket belongs to the I/O context that opened it, and ending
  one mid-request kills the query with `CONNECTION_ENDED`.
- **`x-dev-user` is gated to a localhost hostname** and cannot authenticate a deployed worker.
  Real session auth is not built yet, so `/api/*` returns 501 off localhost.
- **Reply sends before it writes**, so a Twilio failure is a 502 and the ticket keeps its prior
  status rather than claiming a reply the customer never got.
- **Every queue job carries `orgId`** — the consumer has no request to resolve a tenant from.

## Local development
```bash
npx wrangler dev        # then ?org=<slug> and header x-dev-user: <users.id>
```
Point Hyperdrive at a local Postgres with `localConnectionString` on the `[[hyperdrive]]`
block. It rejects a connection string with no password. On macOS the postmaster needs
`LC_ALL=C` or it exits with "became multithreaded during startup".

Workers AI has **no local emulation** (`env.AI — not supported`), so `extract_specs` cannot be
exercised with `wrangler dev`; it needs a deployed worker or a logged-in remote session.

## Onboarding another tenant
Data and DNS, no code change and no deploy:
1. Insert the `orgs` row, then `counters` and `users` inside a `set_config` transaction.
2. Buy their number, point its SMS webhook at the same `/hooks/twilio/sms`. Resolution is by
   `To`, so one worker serves every tenant.
3. `<slug>.midlayr.app` works at once. For a custom hostname add an `org_domains` row
   (`kind='app'`, `verified_at` set) and attach it via Cloudflare for SaaS.

## Not built yet
Session auth · voice → R2 → Whisper · inbound email · the `ChatSession` / `InboxRoom` DOs ·
the Pages front end · drip and SLA cron.
