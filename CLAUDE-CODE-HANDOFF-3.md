# Claude Code handoff · Session 3 — Pathfinder (Pipeline)

Design: `design/Pathfinder Wireframes.dc.html` (six wireframes 1a–1f with build notes under each). Brand rules unchanged: `design/BRAND.md`, `web/src/tokens.css`. Screenshots of the existing Inbox for chrome reference in `design/ref-*.png`.

Goal: a **Pipeline** nav item in Front Desk with a board, health scores that explain themselves, a company drawer, hold-to-talk notes, list import, and a radar tab. Build in the order below; each step is shippable on its own.

## 0. Schema
Run `schema-pathfinder.sql`. Adds quote_amount / won_at / lost_reason on leads, lifetime_value / last_order_at / reorder_interval_days / radar on companies, `notes`, `tasks`, `leads.health`.

## 1. Health score (backend) — wireframe 1b
`src/jobs/score-intent.ts`. Six deterministic factors, each 0–20, sum capped at 98:
- recency: hours since last inbound or outbound message → 20 (<2h) … 0 (>14d)
- deadline: days to deadline_at → 20 (≤3d) … 0 (none / >30d)
- value: quote_amount or qty-based estimate → 0–20 log scale ($200 → 4, $2k → 12, $10k+ → 20)
- reply_speed: OUR first_reply_at − created_at → 20 (<15min) … 0 (>24h or none)
- repeat: company has ≥1 won lead → 20; ≥3 → 20; else 0
- fit: from companies.enrichment (industry in print-heavy list, size 11–200) → 0–20
Then one LLM call (Workers AI) for `why` — a single sentence "next best move" given the factors and last 3 messages. Write to `leads.health` and `leads.intent_score`. Trigger on: lead created, message in/out, status change, nightly cron for all open leads. Also roll up `companies.health_score` = max over open leads.

## 2. Pipeline board — wireframe 1a
Route `/pipeline`. Four columns from leads.status: **New** (new, needs_info, replied), **Quoted** (quoted), **Won**, **Lost**. Header shows Σ quote_amount of Quoted + "N deals", board/list toggle.
Card: company or contact name, health ring (score inside; ring color ≥70 ok / 40–69 warn / <40 danger; card border danger when <35), one line of specs (product · qty · deadline), one line of state ("needs stock", "$1,840 · sent 2h ago", "drip: follow-up in 22h", "no reply · going cold").
Drag between columns → `PATCH /api/leads/:id {status}`; moving to Quoted prompts for quote_amount; to Lost prompts for lost_reason (price / timing / went elsewhere / no response). Set quoted_at / won_at server-side. On won: add quote_amount to companies.lifetime_value, set last_order_at, enqueue `learn_interval`.
List view = same data as a table sorted by score desc.

## 3. Health popover — wireframe 1b
Click the ring → popover: six rows "factor · evidence · +N", then the `why` sentence in a sunk box. Evidence strings are generated server-side alongside the factors (e.g. "2h ago", "Mon", "$1,840", "11 min", "no", "real estate · 12 staff"). `GET /api/leads/:id/health`.

## 4. Company drawer — wireframe 1c
Opens from any card, any ticket, any contact name. Right-side drawer 420px over the current view (never a route change).
Header: name, domain · city, health ring. Three cells: industry, size, lifetime (`$X · N orders` or `$0 · prospect`). "Enriched Xh ago · provider" + refresh. Contacts list with ☎ ✉ actions that open the reply composer on the most recent lead. Timeline merges leads, messages (collapsed per lead), notes, tasks, ordered desc. Footer: 🎤 Add note, Enroll in drip.
`GET /api/companies/:id` returns everything in one payload. Enrichment: `JOBS.enrich` → Clearbit or Apollo by domain (ask me which key I have) → companies.enrichment; 30-day cache; strip to {industry, size_band, city, logo_url, description}.

## 5. Audible notes — wireframe 1d
Hold-to-talk button (mouse down / touch start → MediaRecorder; release → upload). Available on ticket, company drawer, and pipeline card (long-press). Shows "Recording · 0:14 · release to save" in accent bar while held.
`POST /api/notes` multipart → R2 `org/<orgId>/notes/<id>.webm` → `JOBS.transcribe` (Whisper) → `JOBS.extract_note` (LLM): `{specs:{…}, tasks:[{text, due_iso}], interests:[…]}`.
Extract results render as chips under the transcript: spec chips PATCH the lead when clicked (or auto if confidence high); task chips insert into `tasks` with assignee = author; interest chips tag the company. Transcript is editable inline; edits re-run extract.

## 6. List import — wireframe 1e
Route `/pipeline/import`. Four-step wizard: Upload (CSV/XLSX drop, parse client-side with papaparse/sheetjs, show first 5 rows) → Map (each source column → target field select, auto-guess by header name, "skip") → Review (counts: new / already in system → merge / invalid phone or email) → Enrich & enroll (checkbox enrich all with estimated cost at $0.01/row, checkbox enroll in a sequence, optional tag).
Server: `POST /api/imports` stores file in R2 + mapping; `JOBS.import_rows` in batches of 100: dedupe on phone / email / domain within org, insert companies + contacts with source `import:<id>`, then `JOBS.enrich` per new company, then enrollments if chosen. Progress pushed via InboxRoom DO; wizard shows a live bar.

## 7. Radar — wireframe 1f
Tab inside Pipeline. Nightly `JOBS.learn_interval` per company with ≥2 won leads: median gap between won_at values → reorder_interval_days (source learned) unless manual. Flags:
- reorder_due: now − last_order_at ≥ 0.9 × interval
- lapsed: ≥ 2 × interval or ≥ 180d with ≥1 past order
- seasonal: orders cluster in same month ≥2 years → flag 60d before that month
Radar list: company, flag pill, one-line evidence ("wine labels every 90d · last 87 days ago · $3,100 avg"), what happens next ("Reorder drip sends Thu unless you call first"). Rep can edit interval inline and snooze a flag. Radar flags are valid `sequences.trigger` values (`reorder_due`, `lapsed`) so drips can fire automatically when the org enables it.

## Nav & shell
Add **Pipeline** between Inbox and Campaigns. Same 3-pane shell; Pipeline uses full width for the board. Keyboard: `g p` go to pipeline, `1–4` filter to a column, `n` new note on the focused card.

## Constraints
Every query via `withOrg()`. Every job carries orgId. Nothing Dumont-specific. Commit per numbered step. Append to SETUP-LOG.md with any new secrets (enrichment provider) I gave you.
