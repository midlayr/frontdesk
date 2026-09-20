import PostalMime from 'postal-mime';

/**
 * Turning an email into a request.
 *
 * The awkward case is the one people actually do: a rep forwards a customer's enquiry to
 * Front Desk. The envelope then says the *rep* sent it, and naively trusting `From` files
 * every forwarded job under the colleague who passed it on. So a forward is detected and
 * the original sender dug out of the body, where the forwarding client wrote it.
 *
 * Everything here is pure and works on a raw RFC822 message, which is what makes it
 * testable against real mail without a mailbox, a domain or an inbound provider.
 */

export interface Party { name: string | null; email: string }

export interface ParsedEmail {
  /** Who the request is really from — the original sender of a forward, else the sender. */
  from: Party;
  /** Set when this arrived as a forward, so the ticket can record who passed it on. */
  forwardedBy: Party | null;
  subject: string;
  /** The message worth reading: quoted history and forwarding preamble removed. */
  body: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  /** A ticket number in the subject, for threading a reply that lost its headers. */
  ticketHint: string | null;
  attachments: { filename: string; mimeType: string; content: ArrayBuffer }[];
  to: string[];
  /** Every header, lower-cased. The loop guards need ones nothing else looks at. */
  header(name: string): string | null;
}

/** Lines a forwarding client writes above the message it is carrying. */
const FORWARD_MARKERS = [
  /^-{2,}\s*forwarded message\s*-{2,}\s*$/im,
  /^begin forwarded message:\s*$/im,
  /^-{2,}\s*original message\s*-{2,}\s*$/im,
];

/** Where a reply's quoted history starts. Everything from here down is the past. */
const REPLY_MARKERS: RegExp[] = [
  /^\s*On\b[\s\S]{0,300}?\bwrote:\s*$/im,
  /^\s*Le\b[\s\S]{0,300}?\ba écrit\s*:\s*$/im,
  /^-{2,}\s*original message\s*-{2,}\s*$/im,
  /^_{10,}\s*$/m,
  /^\s*From:\s.+\r?\n\s*(Sent|Date):\s/im,
];

const ADDRESS = /([^<>\s,"]+@[^<>\s,"]+\.[^<>\s,"]+)/;

/** `Jane Doe <jane@acme.com>` or a bare address. */
export function parseParty(value: string): Party | null {
  const v = value.trim().replace(/^["']|["']$/g, '');
  const angled = /^(.*?)<\s*([^>]+?)\s*>$/.exec(v);
  if (angled) {
    const name = angled[1].trim().replace(/^["']|["']$/g, '');
    const email = angled[2].trim().toLowerCase();
    return ADDRESS.test(email) ? { name: name || null, email } : null;
  }
  const bare = ADDRESS.exec(v);
  return bare ? { name: null, email: bare[1].toLowerCase() } : null;
}

/**
 * Pull the original sender and subject out of a forwarded message.
 *
 * Gmail, Outlook and Apple Mail all write a small header block under their own marker line.
 * The formats differ but every one of them writes `From:` with an address, which is the only
 * field that has to be found.
 */
export function readForward(text: string): { from: Party; subject: string | null; body: string } | null {
  let at = -1;
  for (const m of FORWARD_MARKERS) {
    const hit = m.exec(text);
    if (hit && (at === -1 || hit.index < at)) at = hit.index + hit[0].length;
  }
  if (at === -1) return null;

  const rest = text.slice(at).replace(/^\r?\n+/, '');
  const lines = rest.split(/\r?\n/);

  let from: Party | null = null;
  let subject: string | null = null;
  let consumed = 0;

  // The header block runs until a line that is not one of these fields, allowing blanks.
  for (let i = 0; i < lines.length && i < 14; i++) {
    const line = lines[i];
    if (!line.trim()) { consumed = i + 1; continue; }
    const field = /^\s*(From|To|Cc|Bcc|Date|Sent|Subject|Reply-To)\s*:\s*(.*)$/i.exec(line);
    if (!field) break;
    consumed = i + 1;
    const key = field[1].toLowerCase();
    if (key === 'from' && !from) from = parseParty(field[2]);
    if (key === 'subject' && subject === null) subject = field[2].trim() || null;
  }

  if (!from) return null;
  return { from, subject, body: lines.slice(consumed).join('\n').replace(/^\n+/, '') };
}

/** Drop the quoted history under a reply, and any trailing `>` block. */
export function stripQuoted(text: string): string {
  let cut = text.length;
  for (const m of REPLY_MARKERS) {
    const hit = m.exec(text);
    if (hit && hit.index < cut) cut = hit.index;
  }
  const kept = text.slice(0, cut).split(/\r?\n/);
  while (kept.length && (/^\s*>/.test(kept[kept.length - 1]) || !kept[kept.length - 1].trim())) kept.pop();
  return kept.join('\n').trim();
}

/** `Re: [DL-2000] Banner quote` → `DL-2000`. */
export function ticketFromSubject(subject: string, prefix = '[A-Z]{2,5}'): string | null {
  const m = new RegExp(`\\[?\\b(${prefix}-\\d{3,})\\b\\]?`).exec(subject.toUpperCase());
  return m ? m[1] : null;
}

/**
 * Mail that must never create a ticket or be replied to.
 *
 * An out-of-office answering our auto-reply, answering its auto-reply, is a loop that fills
 * the queue with tickets nobody sent. Bounces (`Return-Path: <>`) are the same story.
 */
export function isAutomated(header: (name: string) => string | null): boolean {
  const auto = header('auto-submitted');
  if (auto && auto.toLowerCase() !== 'no') return true;
  if (header('x-autoreply') || header('x-autorespond')) return true;
  const precedence = (header('precedence') ?? '').toLowerCase();
  if (['bulk', 'auto_reply', 'junk', 'list'].includes(precedence)) return true;
  // An empty Return-Path is a bounce. An *absent* one says nothing, and returning on it
  // skipped every check below — so a mailing list sailed through into the queue.
  if ((header('return-path') ?? '').trim() === '<>') return true;
  if (header('list-unsubscribe') || header('list-id')) return true;
  return false;
}

/** Drop the Re:/Fwd: pile-up and our own [DL-2000] tag, which the ticket already knows. */
function cleanSubject(raw: string): string {
  return raw
    .replace(/^\s*((re|fwd?|fw|tr|aw|sv)\s*:\s*)+/i, '')
    .replace(/\[\s*[A-Za-z]{2,5}-\d{3,}\s*\]\s*/g, '')
    .trim() || '(no subject)';
}

const clean = (s: string) => s.replace(/ /g, ' ').replace(/[ \t]+$/gm, '').trim();

/** Parse a raw message into everything a ticket needs. */
export async function parseEmail(raw: ArrayBuffer | string): Promise<ParsedEmail> {
  const mail = await PostalMime.parse(raw);

  const header = (name: string): string | null =>
    mail.headers.find((h) => h.key.toLowerCase() === name.toLowerCase())?.value ?? null;

  const sender: Party = mail.from
    ? { name: mail.from.name || null, email: (mail.from.address ?? '').toLowerCase() }
    : { name: null, email: '' };

  const text = clean(mail.text ?? stripHtml(mail.html ?? ''));
  const subject = (mail.subject ?? '').trim();

  // A forward is worth trusting over the envelope only when the body really carries one.
  const fwd = readForward(text);
  const looksForwarded = /^\s*(fwd?|fw|tr)\s*:/i.test(subject) || !!fwd;

  const from = fwd?.from ?? sender;
  const forwardedBy = fwd && fwd.from.email !== sender.email ? sender : null;
  const body = stripQuoted(fwd?.body ?? text);

  return {
    header,
    from,
    forwardedBy,
    // The forwarded original's subject beats "Fwd: Fwd: Re: quote".
    subject: cleanSubject(fwd?.subject ?? subject),
    body: body || (looksForwarded ? clean(text) : ''),
    messageId: header('message-id'),
    inReplyTo: header('in-reply-to'),
    references: (header('references') ?? '').split(/\s+/).filter(Boolean),
    ticketHint: ticketFromSubject(subject),
    attachments: (mail.attachments ?? [])
      .filter((a) => a.disposition !== 'inline' || !a.related)
      .map((a) => ({
        filename: a.filename || 'attachment',
        mimeType: a.mimeType || 'application/octet-stream',
        content: a.content as ArrayBuffer,
      })),
    to: (mail.to ?? []).map((t) => (t.address ?? '').toLowerCase()).filter(Boolean),
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
