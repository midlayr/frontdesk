# Claude Code handoff · Session 3 — Pipeline + Deal Flow

**Design files (read these first, they are working prototypes — match them):**
- `design/Pipeline.dc.html` — board, list, radar, company drawer, health popover, voice notes, drag rules, toasts
- `design/Deal Flow Builder.dc.html` — stage map, stage editor, test-a-deal simulator
- `design/Pathfinder Wireframes.dc.html` — build notes for enrichment, import, radar internals
- `design/BRAND.md`, `web/src/tokens.css` — fonts, colors, recipes. No new colors or fonts.

Open the `.dc.html` files in a browser to click through them. The data model is in each file's `class Component` (DEALS, STAGES, AUTOS, RADAR, NOTES constants and the `defaults()` flow).

## 0. Schema
Run `schema-pathfinder.sql`, then `schema-dealflow.sql`. Seed Dumont's `deal_flows` row from `defaults()` in Deal Flow Builder and publish it (version 1).

## 1. Deal Flow engine (backend first — Pipeline depends on it)
`src/flow/engine.ts`, pure functions, unit-tested:
- `enterStage(lead, stageId, flow, ctx)` → list of effects: `autoreply(text)`, `assign(rule)`, `enroll(sequenceName)`, `notify(target)`, `task(text)`, `tag(tag)`, `stopSequences()`, `askLostReason()`. Only `on:true` actions.
- `evaluateExits(lead, event, flow)` → next stage id or null. Events: `specs_missing`, `specs_filled`, `rep_reply`, `quote_entered`, `customer_approved`, `marked_won`, `marked_lost`, `sla_passed`.
- Rule from the simulator: returning to New from Needs info does **not** re-run New's automations.
- Platform rule, always on: inbound customer reply stops all active enrollments on the lead.

Wire it in: every place that changes `leads.status` (inbound hooks, extract_specs, reply, PATCH, pipeline drag) calls one function `transition(tx, leadId, event | {to})` that updates status + `stage_entered_at`, runs effects, writes `activity`, pushes to InboxRoom. Nothing else may write `leads.status`.
Time limits: 5-min cron finds `now() - stage_entered_at > sla.hours` with `sla_breached_at IS NULL`, applies `sla.then`, sets `sla_breached_at`.

API `src/api/deal-flow.ts`: `GET /api/deal-flow` (draft + published + version), `PUT` (save draft, zod-validated), `POST /publish` (copy draft → published, bump version), `POST /simulate {events[]}` (runs engine on the draft, returns rows exactly like the prototype's right panel).

## 2. Health score — Pipeline popover
`src/jobs/score-intent.ts`. Six factors 0–20, sum capped at 98. Each factor returns `[points, evidence]` exactly like `d.f` in Pipeline.dc.html:
recency (hours since last message), deadline (days to deadline_at), value (quote_amount or estimate, `valPts` thresholds in the file), reply_speed (our first_reply_at − created_at), repeat (won deals for company), fit (enrichment industry + size). Plus one LLM sentence `why`. Store in `leads.health` `{recency:[n,'2h ago'],…,why}` and `leads.intent_score`. Recompute on every transition, message in/out, and nightly.

## 3. Pipeline board
Route `/pipeline`, nav between Inbox and Campaigns.
- **Columns come from the published Deal Flow**: one column per non-terminal stage in flow order (names from the flow), plus a 260px right rail with Won and Lost. Column header: name, count, `⏱ {sla} LIMIT`, Σ value on Quoted.
- **Card** (copy markup/spacing from the prototype): company, spec line (product · qty · due), health ring 34px (≥70 #1F7A4D, 40–69 #B4690E, <40 #B4261B), status lines from `stateLines()` in the file, footer with rep initials, channel glyph + ticket, RUSH pill. Card border #B4261B when score < 35. Sorted by score desc within a column.
- **Drag and drop** (HTML5 DnD, column highlight #E6F2F7 on dragover). Drop calls `POST /api/leads/:id/transition {to}`. To Quoted without a value → modal asks quote amount. To Lost → modal with Price / Timing / Went elsewhere / No response. Response returns fired effects; show them in the bottom-left dark toast (4.5s) exactly like the prototype.
- **Health popover**: `position:fixed` at the root, placed from the ring's `getBoundingClientRect()` (below, or above if no room), click-outside closes. Six factor rows + NEXT MOVE box.
- Header: `$X QUOTED · N OPEN DEALS`. Sub-bar: Board / List / Radar · N segmented, filters All / Mine / Rush / Needs attention (cold, over SLA, or score < 35) with counts, search by company.
- Realtime: subscribe to InboxRoom; cards move when other reps move them.

## 4. List view
Same data as a table sorted by score: Company · Stage pill · Value (or ~estimate) · Due · Health ring · Rep · Next move. Row click opens the drawer.

## 5. Company drawer
Fixed right drawer `min(440px, 94vw)` with scrim; never a route change. Opens from any card, list row, won/lost row, or ticket. Sections in order: header (name, domain · city, 46px ring, Industry / Size / Lifetime cells, "Enriched X ago · ↻ refresh"), Open deal (spec, ticket · channel · rep, stage pill, NEXT MOVE), Contacts (☎ ✉ open the composer), Voice notes, Timeline.
`GET /api/companies/:id` returns it in one payload. Enrichment job per Pathfinder wireframe 1c — ask me which provider key I have.

## 6. Voice notes
Hold-to-talk button (mousedown/touchstart → MediaRecorder; release or mouseleave → stop). States exactly as the prototype: blue "Hold to record a note" → red "Recording · 0:14 / Release to save" → grey "Transcribing…". Upload → R2 `org/<id>/notes/<noteId>.webm` → `JOBS.transcribe` → `JOBS.extract_note` → `{specs:[…], tasks:[…], interests:[…]}` rendered as chips (spec = blue, task = amber). Clicking a chip applies it: spec → PATCH lead (and if that clears missing fields on a Needs info deal, `transition(event:'specs_filled')`); task → `tasks` row; interest → company tag. Applied chips turn green with ✓. Push progress over InboxRoom so the note appears when transcription finishes.

## 7. Radar tab
Nightly `JOBS.learn_interval` per Pathfinder 1f. Radar list: company, flag pill (Reorder due amber / Lapsed red / Seasonal grey), evidence line, what happens next line, **Call today** (creates task, toast) and **Snooze 30d**.

## 8. Deal Flow Builder UI
Route `/settings/deal-flow` (admin only), also linked as "Deal flow" in nav for admins. Port `Deal Flow Builder.dc.html` 1:1: stage map strip (click to select, "● DEAL HERE" marker from the simulator), stage editor (name, enters-when, time limit + then, automations with on/off, add chips, exits), test-a-deal panel calling `/simulate` with the unsaved draft, Publish button amber when draft ≠ published. Autosave draft 500ms.

## 9. List import
Per Pathfinder wireframe 1e (unchanged from before). Lower priority; do last.

## Constraints
Every query via `withOrg()`. Every job carries orgId. Only `transition()` writes `leads.status`. Nothing Dumont-specific in code. Commit after each numbered step. After step 3, give me the Pipeline URL so I can react before you continue. Append new secrets and URLs to SETUP-LOG.md.
