# Claude Code handoff · Session 2 — Live chat with rep takeover

Context: session 1 shipped SMS → queue → reply. This session makes **Midlayr Chat** real end to end.
Design reference: `Live Chat Demo.dc.html` (visitor + rep side by side) and `Midlayr Chat.dc.html` (flow builder, install).

Read first: `DESIGN.md` (fonts, colors, tokens — follow exactly), `brand/dumont/` (logo), `design/` (reference screenshots), then `src/do/chat-session.ts`, `src/do/inbox-room.ts`, `widget/chat.js`, `schema.sql` (chat_flows, chat_sessions).

Goal: **open dumontprinting-test.html with the script tag, chat with the bot, a rep in the Front Desk app clicks "Take over chat", both sides see the rep join, messages flow both ways, a lead row exists in Postgres.**

1. Wire the two Durable Objects (already written) into `wrangler.toml` migrations. Add an `INTERNAL` service binding (self-binding) so DOs can call Worker routes. Add:
   - `POST /internal/leads/from-chat` — insert contact (from captured.contact if email/phone), lead (channel chat, status live|new), chat_sessions row; return `{leadId}`.
   - `POST /internal/leads/chat-turns` — upsert messages rows from turns (author visitor|bot|user id), update chat_sessions.state/captured.
2. `GET /widget/config?org=<slug>&flow=<slug>` — public, CORS to org.widget.allowed_domains. Returns `{orgId, orgName, brand:{color,ink,paper,app_name_public,show_powered_by}, widget:{launcher,nudge}}`. Read from KV `flow:<orgId>:<slug>` (published flow) + org row.
3. `GET /widget/session` — upgrade; route to `CHAT_SESSION.idFromName(sid)`.
4. `PUT /api/flows/:slug` + `POST /api/flows/:slug/publish` — save steps_json to Postgres, on publish write KV `flow:<orgId>:<slug>` = `{id, version, steps}` and bump version. Seed Dumont's `quote-intake` flow with the 6 steps from `Midlayr Chat.dc.html` state.
5. `GET /api/inbox/stream` — upgrade; route to `INBOX_ROOM.idFromName(org.id)`. `POST /api/leads/:id/takeover` — find chat_sessions.do_id for the lead, forward `{type:'takeover', repId, repName}` to that DO.
6. Serve `widget/chat.js` from a Pages project or R2+custom domain as `cdn.midlayr.com/chat.js` (dev: `/widget/chat.js` from the Worker with `Cache-Control: public, max-age=300`).
7. **Front end** (new `web/` Vite + React + TS, deploy to Pages): **read `design/BRAND.md` and import `web/src/tokens.css` first** — all colors, fonts, and component recipes are there; logos are in `web/public/brand/dumont/`. Port `Live Chat Demo.dc.html`'s rep pane — queue list (subscribes to `/api/inbox/stream`), ticket header with spec grid, chat thread, "Take over chat" button, composer with ⌘↵. Theme from `GET /api/org` brand JSON. Keep the exact palette and type from the design: paper #FBFAF8, ink #14161A, accent from org.brand.color, IBM Plex Mono for labels, Archivo (wdth 125) for headings.
8. Test page `web/public/dumontprinting-test.html` with the script tag pointing at the dev Worker. Run the scenario from the design's Autoplay button manually.

Constraints unchanged: every query via `withOrg()`, every job carries orgId, nothing Dumont-specific in code. Commit per step. Append to `SETUP-LOG.md`.
