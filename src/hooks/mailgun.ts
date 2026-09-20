import type { Env } from '../env';
import type { Sql } from '../db';
import { verifyMailgun } from '../lib/mailgun';
import { handleEmail, type Outcome } from './email';
import { parseEmail, readForward, stripQuoted, ticketFromSubject, type ParsedEmail, parseParty } from '../lib/email';

/**
 * Mailgun Route → ticket.
 *
 * Two payload shapes, because a Route can be configured either way:
 *
 *   raw MIME   `body-mime` holds the whole message — preferred, since nothing is lost and
 *              it goes through exactly the same parser as any other source.
 *   parsed     Mailgun has already split the message into fields. Usable, but its
 *              `stripped-text` has its own idea of where a quote begins, and attachments
 *              arrive as separate form parts.
 *
 * Either way the tenant comes from `recipient`, which is the envelope recipient — the only
 * place a bcc'd address survives.
 */
export async function mailgunInbound(
  req: Request, env: Env, sql: Sql, ctx: { waitUntil(p: Promise<unknown>): void },
): Promise<{ status: number; body: Outcome | { ok: false; error: string } }> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return { status: 400, body: { ok: false, error: 'expected multipart form data' } };
  }

  const field = (n: string) => {
    const v = form.get(n);
    return typeof v === 'string' ? v : null;
  };

  const ok = await verifyMailgun(
    env.MAILGUN_SIGNING_KEY,
    field('timestamp') ?? '', field('token') ?? '', field('signature') ?? '');
  // 406 rather than 401: Mailgun stops retrying on a 406 and keeps retrying a 4xx it thinks
  // is transient. An unverified post is never going to verify on the second attempt.
  if (!ok) return { status: 406, body: { ok: false, error: 'bad or stale signature' } };

  const to = field('recipient') ?? '';
  const from = field('sender') ?? '';
  if (!to) return { status: 406, body: { ok: false, error: 'no recipient' } };

  const raw = field('body-mime');
  const delivery = raw
    ? { to, from, raw }
    : { to, from, mail: await fromFields(form, field) };

  const out = await handleEmail(delivery, env, sql, ctx);
  // 200 even when we decline: Mailgun should not retry an out-of-office we chose to drop.
  return { status: 200, body: out };
}

/** Build the same shape parseEmail produces, from Mailgun's parsed fields. */
async function fromFields(
  form: FormData, field: (n: string) => string | null,
): Promise<ParsedEmail> {
  // message-headers is a JSON array of [name, value], and carries the ones the loop guards
  // need — Auto-Submitted, Precedence, List-Unsubscribe — which have no field of their own.
  const headers = new Map<string, string>();
  try {
    for (const [k, v] of JSON.parse(field('message-headers') ?? '[]') as [string, string][]) {
      headers.set(k.toLowerCase(), v);
    }
  } catch { /* a malformed header blob must not lose the message */ }

  const header = (n: string) => headers.get(n.toLowerCase()) ?? null;
  const sender = parseParty(field('from') ?? field('sender') ?? '') ?? { name: null, email: '' };
  const subject = field('subject') ?? '';

  // Mailgun's own stripped-text is used only as a fallback: our stripper also has to handle
  // the forward case, where the quoted block is the message rather than history.
  const text = field('body-plain') ?? field('stripped-text') ?? '';
  const fwd = readForward(text);

  const attachments: ParsedEmail['attachments'] = [];
  for (const [, v] of form.entries()) {
    if (typeof v === 'string' || !(v instanceof File)) continue;
    attachments.push({
      filename: v.name || 'attachment',
      mimeType: v.type || 'application/octet-stream',
      content: await v.arrayBuffer(),
    });
  }

  return {
    header,
    from: fwd?.from ?? sender,
    forwardedBy: fwd && fwd.from.email !== sender.email ? sender : null,
    subject: (fwd?.subject ?? subject)
      .replace(/^\s*((re|fwd?|fw|tr|aw|sv)\s*:\s*)+/i, '')
      .replace(/\[\s*[A-Za-z]{2,5}-\d{3,}\s*\]\s*/g, '').trim() || '(no subject)',
    body: stripQuoted(fwd?.body ?? text),
    messageId: header('message-id') ?? field('Message-Id'),
    inReplyTo: header('in-reply-to') ?? field('In-Reply-To'),
    references: (header('references') ?? field('References') ?? '').split(/\s+/).filter(Boolean),
    ticketHint: ticketFromSubject(subject),
    attachments,
    to: (field('To') ?? field('recipient') ?? '')
      .split(',').map((a) => (parseParty(a)?.email ?? '')).filter(Boolean),
  };
}

export { parseEmail };
