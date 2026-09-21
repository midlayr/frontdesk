# Claude Code handoff · Session 4 — Campaigns (drip sequences)

Design: `design/Campaigns Wireframes.dc.html` (1a–1f, build notes under each). The existing hi-fi for the sequence list and detail header is in `design/ref-camp-*.png` and `Dumont Leads Inbox.dc.html` › Campaigns tab. Brand rules: `design/BRAND.md`, `web/src/tokens.css`.

Goal: reps can **create a sequence, write steps with merge tokens, add IF/THEN branches, see who's enrolled, and see whether it makes money**. Drips send from the tenant's own address/number inside their send window and stop the moment a human replies.

## 0. Schema
Run `schema-campaigns.sql`. Adds trigger_config / send_window / send_as on sequences; kind / attach_quote / branches on steps; held state + current_step on enrollments; delivery timestamps on messages; `sequence_stats`.

## 1. Send engine (backend first — nothing in the UI matters until this is right)
`src/jobs/drip.ts`, run by the 5-min cron.
- Pick `enrollments WHERE state='active' AND next_send_at <= now()`. For each: load sequence, step, lead, contact, company, assignee.
- **Send window**: if now is outside `sequences.send_window` in the org's tz, push next_send_at to the next window open. Never send outside it.
- **Stop checks** before every send: contact.opted_out → `opted_out`; lead.status in (won, lost, closed, spam) → `completed`; any inbound message on the lead since enrollment → `replied`; a rep sent a manual reply since last drip → `paused` (rep took over).
- **Tokens**: `{first_name} {company} {qty} {product} {size} {stock} {deadline} {quote_amount} {quote_link} {ticket_no} {rep_name} {rep_phone}`. Resolve from lead/contact/company/assignee. Any unresolved token → state `held`, `held_reason='missing:{qty}'`; do not send. When a `PATCH /api/leads/:id` fills that field, flip back to `active` (hook in leads.ts).
- **Email** via Resend from `org.comms.email_from`, display name = assignee name if send_as='rep' else org.name; footer from `org.comms.footer` + "Reply STOP to opt out" for SMS. Attach quote PDF from R2 when attach_quote and the lead has one. **SMS** via Twilio from `org.comms.sms_number`.
- Insert `messages` row: author `sequence:<id>`, enrollment_id, step_id, provider_id. Set enrollment.last_sent_at, advance `current_step_id` / `next_step` / `next_send_at` (next step's delay).
- **Wait** steps just set next_send_at. **Task** steps insert into `tasks` for the assignee and advance immediately.

## 2. Branches
Evaluated when a step's *following* step comes due (that's the "check at day N" moment). Load the last drip message for the enrollment and test branches in order; first match wins. Conditions: replied (inbound since send) · opened_no_reply · not_opened · clicked · bounced · sms_delivered · health_below N (leads.intent_score). Actions: continue · stop · resend (same body, `config.subject`) · skip_to step · switch_sms (send this step's body as SMS instead) · assign (`config.user_id`) · task (`config.text`) · tag (company). API rejects a step whose first branch isn't `{if:'replied', then:'stop'}`; UI renders it locked.

## 3. Delivery webhooks
`POST /hooks/resend` (delivered, opened, clicked, bounced → messages.*_at by provider_id; bounced → also enrollment `held`, reason `bounced`). `POST /hooks/twilio/status` (delivered / failed). Reply-in handlers (SMS, email, chat) already exist — add: stop active enrollments for that lead, set lead status → `new` if it was `replied`/`quoted`, reassign to last rep who sent, and notify InboxRoom.

## 4. Triggers
- `lead_created`: in every inbound handler after lead insert, enroll into any active sequence with this trigger (one per lead per sequence).
- `quoted_no_reply`: cron; leads.status='quoted' AND quoted_at < now() − trigger_config.days AND no inbound since quoted_at AND not already enrolled.
- `reorder_due` / `lapsed`: from Pathfinder radar job when it sets `companies.radar`; enroll the primary contact on a new manual-channel lead (channel 'form'? no — add `channel` value `campaign` to the enum) so the thread has a home.
- `list`: on import completion when the wizard chose a sequence.
- `manual`: `POST /api/leads/:id/enroll {sequence_id}`.

## 5. API — `src/api/sequences.ts`
GET list (with 30d stats inline) · GET one (steps + branches) · POST create (1a) · PATCH · POST `/:id/steps` · PATCH/DELETE step · PATCH reorder · POST `/:id/steps/:sid/preview {leadId}` → rendered subject/body/from/footer with tokens resolved (1b) · GET `/:id/enrollments?state=` · PATCH `/:id/enrollments {ids, state}` bulk (1d) · GET `/:id/stats?window=` (1e) · POST `/:id/live` toggle. All via `withOrg()`.

## 6. Front end (order matches value)
**1b Step editor** — right pane replaces the read-only step card when a step is selected. Left: kind pill, subject input, body textarea, token chips (click inserts at cursor; unknown token in body underlines red and disables Save), attach quote / send as rep checkboxes. Right: live preview against a real lead picker (defaults to most recent lead in the audience); shows the actual From, footer, opt-out line. Autosave 500ms.
**1c Branch editor** — under each step: IF [condition ▾] → THEN [action ▾] rows, first row locked "Replied → Stop sequence", "+ branch". Resend action reveals a subject input.
**1a New sequence** — modal from "New": name, 6 trigger cards (radio), days input where relevant, list picker for `list`, channel segmented (Email / SMS / Email → SMS if no open), read-only "Stops on" line. Create → opens the sequence with one empty step selected.
**1d Enrolled tab** — table: lead · step · next · state pills with counts filter. Row click → ticket. Checkbox bulk pause / remove. Held rows show the reason and a "Fix on ticket →" link.
**1e Performance tab** — 4 stat cells (enrolled, replied %, won after, revenue), per-step horizontal bars (open %, replies), one-line "Read" from stats.read, window toggle 30d / 90d / all.
**1f Ticket panel** — "Sequences" card on the ticket: current enrollment with step/next, Pause / Remove, "+ Enroll ▾" listing manual-eligible sequences. In the thread, drip sends render as dashed accent-border cards with the sequence name, day, and open state; they are not editable.

## 7. Stats job
Nightly `JOBS.sequence_stats`: for each sequence × step × window aggregate from messages (sent/opened/clicked), enrollments (enrolled/replied), leads (won within 30d of last drip send → won + revenue = quote_amount). One Workers AI call per sequence for `read` (one sentence, plain, about which step earns replies and what to try).

## Constraints
Every query via `withOrg()`. Every job carries orgId. Nothing Dumont-specific — copy in seed sequences is Dumont's, but code reads it from rows. Commit per numbered step. Append to SETUP-LOG.md.
