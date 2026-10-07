import type { Env, Org } from '../env';

/**
 * The shop's own letterhead, for everything Front Desk sends.
 *
 * Email is not the web and this file does not pretend otherwise. Outlook renders through
 * Word, Gmail strips most of a <style> block, and nothing may be fetched from our servers
 * at read time. So: tables for layout, every rule inline, a fixed 600px, no webfonts, no
 * flexbox, no grid. It looks like 2004 markup because that is what survives.
 *
 * TWO VARIANTS, and the distinction matters more than the styling:
 *
 *   'notice'  — the product talking. Sign-in links, invites, password resets. Full chrome:
 *               the shop's mark, a heading, a real button, a footer that says where this
 *               came from. Someone who was not expecting this mail needs to place it fast.
 *
 *   'message' — a person talking. A rep's reply to a customer, a follow-up in a campaign.
 *               Almost no chrome: the words, then a thin rule and a signature. A branded
 *               header above "Hi Priya, that comes to $640" reads as marketing, makes a
 *               colleague look like a newsletter, and is the quickest way to get a human
 *               reply treated as bulk. Restraint here is the feature.
 *
 * Both carry a plain-text part, always. Some people read in plain text by choice, some
 * clients fall back to it, and a text part materially helps deliverability.
 */

export type Variant = 'notice' | 'message';

export interface Letter {
  variant: Variant;
  /** One line, the point of the mail. Shown as the heading on a notice. */
  heading?: string;
  /** Paragraphs. Plain strings — they are escaped, never trusted as markup. */
  body: string[];
  action?: { label: string; url: string };
  /** Small print under the action, e.g. how long a link lasts. */
  fine?: string;
  /** Overrides the derived signature on a 'message'. */
  signature?: string;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
   .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* Contrast, the same rule the app and the widget use: keep the tenant's light text on their
   accent unless it is genuinely unreadable. A button nobody can read is worse than an
   off-brand one, and an email cannot be fixed after it is sent. */
function luminance(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const LEGIBLE_FLOOR = 2.5;

const HEX = /^#[0-9a-fA-F]{6}$/;
const safe = (v: unknown, fallback: string) =>
  typeof v === 'string' && HEX.test(v) ? v : fallback;

export interface Palette {
  accent: string; accentFg: string; ink: string; ink2: string;
  paper: string; line: string; name: string; logo: string | null;
}

/** The tenant's colours, with the platform's as the floor, plus an absolute logo URL. */
export function paletteFor(org: Org, env: Env): Palette {
  const b = org.brand as Record<string, unknown>;
  const accent = safe(b.color, '#0B7FA8');
  const ink = safe(b.ink, '#14161A');
  const paper = safe(b.paper, '#FBFAF8');
  const explicit = safe(b.accent_fg, '');
  const accentFg = explicit
    || (ratio(accent, paper) >= LEGIBLE_FLOOR ? paper
        : ratio(accent, ink) > ratio(accent, paper) ? ink : paper);

  // Absolute, because an email client will not resolve a relative path, and served by the
  // Worker so it does not depend on the shop's own site being up.
  const origin = env.PUBLIC_ORIGIN?.replace(/\/$/, '') ?? '';
  const logo = b.logo_r2_key && origin
    ? `${origin}/widget/logo?org=${encodeURIComponent(org.slug)}`
    : null;

  return { accent, accentFg, ink, paper, logo,
           ink2: '#5C6169', line: '#E3E1DC', name: org.name };
}

/** Plain text, always sent alongside. Readable on its own — not a stripped-tags afterthought. */
export function toText(l: Letter, p: Palette): string {
  const out: string[] = [];
  if (l.heading) out.push(l.heading, '');
  out.push(...l.body);
  if (l.action) out.push('', l.action.url);
  if (l.fine) out.push('', l.fine);
  out.push('', '—', l.signature ?? p.name);
  return out.join('\n') + '\n';
}

export function toHtml(l: Letter, p: Palette): string {
  const sys = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
  const mono = `ui-monospace,SFMono-Regular,Menlo,Consolas,monospace`;

  // Shown in the inbox list beside the subject, then hidden. Without one, clients grab the
  // first words of markup, which is why so many emails preview as "View this in a browser".
  const preheader = esc((l.body[0] ?? l.heading ?? '').slice(0, 120));

  const para = (t: string) =>
    `<p style="margin:0 0 14px;font:400 15px/1.6 ${sys};color:${p.ink};">${esc(t)}</p>`;

  const button = l.action ? `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 6px;">
      <tr><td bgcolor="${p.accent}" style="border-radius:2px;">
        <a href="${esc(l.action.url)}"
           style="display:inline-block;padding:13px 26px;font:600 15px ${sys};
                  color:${p.accentFg};text-decoration:none;border-radius:2px;">${esc(l.action.label)}</a>
      </td></tr>
    </table>
    <!-- The same link in the open, because a button is unclickable in a surprising number of
         clients and some people will not press one they cannot see the destination of. -->
    <p style="margin:10px 0 0;font:400 12px/1.5 ${mono};color:${p.ink2};word-break:break-all;">
      ${esc(l.action.url)}</p>` : '';

  const fine = l.fine
    ? `<p style="margin:16px 0 0;font:400 13px/1.55 ${sys};color:${p.ink2};">${esc(l.fine)}</p>`
    : '';

  const header = l.variant === 'notice' ? `
    <tr><td style="padding:26px 32px 0;">
      ${p.logo
        ? `<img src="${esc(p.logo)}" alt="${esc(p.name)}" height="24"
                style="height:24px;width:auto;border:0;display:block;">`
        : `<div style="font:700 15px ${sys};letter-spacing:.04em;color:${p.ink};
                       text-transform:uppercase;">${esc(p.name)}</div>`}
    </td></tr>
    ${l.heading ? `<tr><td style="padding:20px 32px 2px;">
      <h1 style="margin:0;font:700 22px/1.3 ${sys};color:${p.ink};letter-spacing:-.01em;">
        ${esc(l.heading)}</h1></td></tr>` : ''}` : '';

  const footer = l.variant === 'notice' ? `
    <tr><td style="padding:24px 32px 28px;border-top:1px solid ${p.line};">
      <p style="margin:0;font:400 12px/1.6 ${sys};color:${p.ink2};">
        Sent by ${esc(p.name)} Front Desk. If you were not expecting this, you can ignore it.
      </p></td></tr>`
    : `<tr><td style="padding:4px 32px 28px;">
      <div style="border-top:1px solid ${p.line};padding-top:14px;
                  font:400 13px/1.6 ${sys};color:${p.ink2};">
        ${esc(l.signature ?? p.name)}</div></td></tr>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<!-- Tell the client we have chosen our colours deliberately, so Apple Mail and Outlook do
     not invert them into something that fails contrast. -->
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${esc(l.heading ?? p.name)}</title>
</head>
<body style="margin:0;padding:0;background:${p.paper};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background:${p.paper};">
  <tr><td align="center" style="padding:28px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
           style="width:600px;max-width:100%;background:#ffffff;border:1px solid ${p.line};
                  border-radius:2px;">
      ${header}
      <tr><td style="padding:${l.variant === 'notice' ? '14px' : '28px'} 32px 8px;">
        ${l.body.map(para).join('\n        ')}
        ${button}
        ${fine}
      </td></tr>
      ${footer}
    </table>
  </td></tr>
</table>
</body></html>`;
}

/** Both parts at once — the only way these should be built. */
export function render(l: Letter, org: Org, env: Env): { html: string; text: string } {
  const p = paletteFor(org, env);
  return { html: toHtml(l, p), text: toText(l, p) };
}
