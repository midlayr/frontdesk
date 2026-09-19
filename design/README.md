# Design handoff — Midlayr Front Desk

Everything the front end needs to match the approved prototypes.

## Files
- `tokens.css` — every color, font, size, radius as CSS variables. Load first.
- `theme.ts` — applies tenant overrides (`orgs.brand`) onto the variables at runtime.
- `prototypes/leads-inbox.html`, `prototypes/midlayr-chat.html` — the approved hi-fi prototypes. Open them in a browser; inspect for exact spacing. Inline styles are the spec.
- `reference/*.png` — screenshots of the target states.
- `tenants/dumont/` — Dumont's logo files (upload to R2 under `org/<dumont-id>/brand/`, store keys on `orgs.brand`).

## Fonts (Google Fonts, no self-hosting needed)
```html
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@125,500;125,600;125,700&family=Inter+Tight:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
```
- **Archivo** (width 125, i.e. `font-variation-settings:'wdth' 125`) — headings, wordmark, big numbers. Always `letter-spacing:-.02em`.
- **Inter Tight** — all body and UI text.
- **IBM Plex Mono** — uppercase labels, ticket ids, statuses, timestamps, keyboard hints. `letter-spacing:.08em`.

## Rules the prototypes follow
- Paper `#FBFAF8`, panels `#F2F1EE`, every border 1px `#E3E1DC`. No shadows except the floating chat widget and nudge.
- `border-radius: 2px` everywhere. No pills, no rounded cards.
- Section labels are mono, 10.5–11px, uppercase, `--ink-2` or `--ink-3`.
- Accent `#0B7FA8` is used for: primary buttons, active tab underline, selected state, links, visitor chat bubbles. Nothing else.
- Status colors: green `#1F7A4D` live/done, amber `#B4690E` rush/needs-info/handoff, red `#B4261B` destructive only.
- Dark surfaces (chat widget header, code blocks) are `--ink` with `--paper` text.
- Missing or low-confidence spec fields render as dashed `--rule` boxes with `--ink-3` text. Never hide them.
- Dense: 13.5px body, 28px controls, 36px inputs. Hit targets stay ≥ 28px.
- Keyboard first: j/k rows, Enter open, r reply, ⌘↵ send, Esc back, / search. Visible focus ring.

## White-label
Only these change per tenant: `--accent` (and its derived deep/wash), logo, app name, powered-by toggle. Fonts, paper, ink, layout are Midlayr's and stay constant.

## Component inventory (from prototypes)
AppShell · Header · Rail(views, channel toggles) · QueueList · TriageRow · StatusPill · SpecChip · JobTicket · SpecGrid · SourcePanel(voice/sms/email/form/chat) · Composer · ChatWidget(launcher, window, bubbles, quick replies) · ProspectPanel · FlowBuilder(step list, step editor, live preview) · InstallPage
