# Claude Code handoff — Midlayr Front Desk (Dumont tenant)

Paste this into Claude Code from inside a clone of `midlayr/frontdesk`:

---

You are setting up the Midlayr Front Desk backend on Cloudflare. I'm logged into Cloudflare in this terminal (`wrangler whoami` should work). Read `scaffold/GETTING-STARTED.md`, `scaffold/schema.sql`, `scaffold/wrangler.toml`, and everything in `scaffold/src/` first.

Goal for this session: **an SMS to Dumont's Twilio number creates a row in the leads queue with extracted specs, and `POST /api/leads/:id/reply` sends a text back from Dumont's number.**

Do it in this order, confirming each step works before the next:

1. Move `scaffold/*` to the repo root (the zip added a folder level). `npm init -y`, install `hono postgres ulid zod @cloudflare/workers-types wrangler`. Add `tsconfig.json` with workers types.
2. Ask me for the Neon connection string (I'll create the project at neon.tech). Run `schema.sql` against it with psql. Seed org `dumont` and its `counters` row per GETTING-STARTED step 2 — ask me for Dumont's Twilio number and quotes@ address.
3. Create Cloudflare resources: `wrangler hyperdrive create`, `wrangler r2 bucket create frontdesk-files`, `wrangler kv namespace create CONFIG`, `wrangler queues create frontdesk-jobs` and `frontdesk-dlq`. Paste every returned id into `wrangler.toml`. Set secrets `TWILIO_SID`, `TWILIO_AUTH_TOKEN`, `RESEND_API_KEY`, `SESSION_SECRET` (ask me for values).
4. Stub `src/do/chat-session.ts` and `src/do/inbox-room.ts` as minimal DurableObject classes so the worker compiles. `wrangler deploy`.
5. Set Twilio's messaging webhook for Dumont's number to `https://<worker>.workers.dev/hooks/twilio/sms`. Text the number. Verify with `psql` that `leads`, `messages`, and `activity` rows exist, and that the queue job populated `product/qty/…` on the lead.
6. Temporarily add `dumont.midlayr.app`-style resolution: for local testing, `GET /api/leads` with header `x-dev-user: <a users.id you insert>` against `http://localhost:8787` via `wrangler dev` won't resolve a hostname — add a dev fallback in `resolveOrg` that reads `?org=dumont` when hostname is localhost.
7. `curl -X POST /api/leads/<id>/reply -d '{"body":"Got it, quoting now"}'` and confirm the text arrives and `status` flips to `replied`.

Constraints: nothing Dumont-specific in code (read from the `orgs` row). Every query goes through `withOrg()`. Every queue job carries `orgId`. Every R2 key starts with `org/<orgId>/`. Commit after each numbered step with a clear message.

## Front end (next session)
Read `design/README.md` first, then open `design/prototypes/*.html` in a browser. Build a Vite + React app in `web/` on Cloudflare Pages. Load `design/tokens.css` globally, call `applyTheme(org.brand)` from `design/theme.ts` after `GET /api/org`. Use CSS variables from tokens.css, never hardcoded hex. Port screens in this order: Leads Inbox (queue + ticket + composer) → Midlayr Chat visitor widget as a standalone `chat.js` bundle → Flow Builder → Install page. Match the prototypes pixel-for-pixel; the inline styles in them are the spec. Upload `design/tenants/dumont/*.png` to R2 and set `orgs.brand.logo_r2_key` / `mark_r2_key`.

When done, write `SETUP-LOG.md` recording every id, URL, and command you ran so the next tenant can be onboarded from it.

---
