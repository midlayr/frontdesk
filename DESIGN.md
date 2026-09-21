# Design tokens — Midlayr Front Desk

Platform defaults. Per-tenant overrides live in `orgs.brand` (color, ink, paper, logo_r2_key, app_name). Nothing here is Dumont-specific except `brand/dumont/`.

## Fonts (Google Fonts, all open license)
```html
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@125,600;125,700&family=Inter+Tight:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
```
| Role | Family | Settings |
|---|---|---|
| Headings, app name, wordmark | Archivo | `font-variation-settings:'wdth' 125; font-weight:700; letter-spacing:-.02em` (Expanded axis is the identity — always set wdth 125) |
| Body, UI, buttons, inputs | Inter Tight | 400 / 500 / 600; 13–14px in app, line-height 1.45–1.55 |
| Labels, IDs, timestamps, status | IBM Plex Mono | 10–11px, `letter-spacing:.06–.1em`, uppercase |

Self-host for production: `npm i @fontsource-variable/archivo @fontsource/inter-tight @fontsource/ibm-plex-mono`.

## Colors
| Token | Hex | Use |
|---|---|---|
| paper | #FBFAF8 | app background, cards |
| paper-2 | #F2F1EE | panels, queue, inactive bubbles |
| line | #E3E1DC | every 1px border |
| ink | #14161A | text, dark headers, primary buttons (secondary) |
| ink-2 | #5C6169 | secondary text |
| ink-3 | #9AA0A8 | labels, placeholders, disabled |
| accent | #0B7FA8 | tenant primary (Dumont). Buttons, active tab underline, visitor bubbles, chips |
| accent-dark | #075E7C | accent border / hover |
| accent-tint | #E6F2F7 | chip background |
| live | #1F7A4D | live chat, rep bubbles border, success |
| live-bright | #4FC28A | live indicator on dark |
| rush | #B4690E | rush / deadline / warnings |
| danger | #B4261B | delete, failed send |

## Shape & spacing
- Radius: **2px** everywhere (buttons, inputs, cards). Never rounder.
- Borders: 1px `line`. Selected/active: 1px `ink`. Missing/unknown data: 1px **dashed** `ink-3`.
- Shadows: only on floating things (chat widget) — `0 12px 32px rgba(20,22,26,.16)`.
- Spacing scale: 4 / 6 / 8 / 10 / 12 / 14 / 16 / 20 / 24 / 28 / 32.
- App shell: header 56px; three-pane grid `44px | 320px | 1fr`, each pane scrolls alone.

## Components (from the designs)
- **Status pill**: mono 10px uppercase, colored text only, no fill. `● LIVE` green, `RUSH · FRI` rush, `NEW` accent.
- **Spec chip**: mono 11px, 1px solid ink when known, 1px dashed ink-3 + `field?` when missing.
- **Chat bubble**: 1px border, no radius. Visitor = accent fill / white text. Bot = paper-2. Rep = paper with `live` border. Who-label above in mono 10px.
- **Primary button**: accent fill, accent-dark border, white 13px/600, height 34px.
- **Secondary button**: paper fill, line border, ink text.

## Files
- `brand/dumont/logo-horiz.png` — header wordmark (use at 22px tall)
- `brand/dumont/logo-mark.png` — square mark, favicon source
- `design/*.png` — reference screenshots of the approved designs
- Live designs (open in browser): `../Live Chat Demo.dc.html`, `../Midlayr Chat.dc.html`, `../Dumont Leads Inbox.dc.html`
