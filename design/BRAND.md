# Brand & design handoff — Front Desk app

Source of truth: `Dumont Front Desk Deck.dc.html`, `Dumont Leads Inbox.dc.html`, `Live Chat Demo.dc.html`, `Midlayr Chat.dc.html` in the design project. Screenshots in `design/`.

## Files
- `web/src/tokens.css` — every color, font, radius, shadow, and the recipes for eyebrow / label / display / buttons / chips / spec cells. Import once in the app root. **Do not invent new colors or fonts.**
- `web/public/brand/dumont/logo-horizontal.png` — header logo, render at 18–24px tall, `object-fit:contain`
- `web/public/brand/dumont/logo-mark.png` — 200×200 mark for favicon / mobile / widget avatar
- `design/ref-*.png` — pixel references for the app shell, queue list, ticket, and widget

## Fonts (Google Fonts, already in tokens.css @import)
- **Archivo** — headings only. Always `font-variation-settings: 'wdth' 125`, weight 700, letter-spacing −.02em. Uppercase + .06em tracking for wordmarks ("Front Desk", "Midlayr Chat").
- **Inter Tight** — body, buttons, inputs. 400/500/600.
- **IBM Plex Mono** — every label, id, timestamp, status tag, spec chip. Uppercase, .08–.1em tracking, 10–11px.

## Palette
Paper #FBFAF8 · Paper-2 #F2F1EE · Line #E3E1DC · Ink #14161A · Ink-2 #5C6169 · Ink-3 #9AA0A8
Accent #0B7FA8 (deep #075E7C, tint #E6F2F7) · OK #1F7A4D · Warn #B4690E · Danger #B4261B
Radius 2px everywhere. 1px borders, never 2px except active tab underline. No drop shadows on cards; shadows only on floating widget/launcher.

## Rules
- Dark bars (#14161A) only for: widget header, chat header, deck. App chrome is paper.
- Status colors: live/replied = OK green, rush/needs-info = warn amber, never red except destructive buttons.
- Missing spec = dashed chip in Ink-3 with a `?` suffix. Filled spec = solid Ink border.
- Queue row selected: Ink border + 3px left bar. Unread: Paper-2 background.
- Hit targets ≥ 28px; primary buttons 34px.

## Tenant theming
At boot: `GET /api/org` → set `--accent`, `--accent-deep`, `--accent-tint` from `brand.color` (derive deep = darken 20%, tint = 10% on paper), swap logo src to `brand.logo_r2_key`, set `document.title` to `brand.app_name`. Everything else stays platform default. Store logos at `org/<orgId>/brand/…` in R2 and expose via `/api/files/brand/:kind`.
