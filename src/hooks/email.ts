import { ulid } from 'ulid';
import type { Env, Job, Org } from '../env';
import { withOrg, type Sql, type Tx } from '../db';
import { resolveOrgByEmail } from '../org';
import { parseEmail, isAutomated, type ParsedEmail, type Party } from '../lib/email';
import { findThreadableLead } from '../lib/threading';
import { stopOnReply } from './delivery';

/**
 * Email into the queue.
 *
 * One address per tenant, used three different ways, and they are not the same request:
 *
 *   direct   a customer writes to it            → the sender is the customer
 *   forward  a rep passes a customer's mail on  → the customer is inside the body
 *   bcc      a rep mails a customer and bccs us → the customer is the *recipient*, and the
 *            message is something we sent, not something we received
 *
 * Which one it is is decided by whether the sender is a colleague. That is a fact the users
 * table already holds, so it needs no convention, no subject tag and nothing for the rep to
 * remember — they just bcc the address and it lands on the right ticket facing the right way.
 */

const MAX_ATTACHMENT = 20 * 1024 * 1024;

export interface Delivery {
  /** The envelope recipient. For a bcc this is the only place the address appears. */
  to: string;
  from: string;
  /** The whole message. Preferred: nothing is lost and the parser is shared. */
  raw?: ArrayBuffer | string;
  /** Already parsed, for a provider that posts fields rather than MIME. */
  mail?: ParsedEmail;
}

export interface Outcome {
  ok: boolean;
  reason?: string;
  leadId?: string;
  ticket?: string;
  direction?: 'in' | 'out';
  attachments?: number;
}

/** Everyone at the tenant, so a colleague is never mistaken for a customer. */
async function colleagues(tx: Tx, orgId: string): Promise<Map<string, string>> {
  const rows = await tx<{ id: string; email: string }[]>`
    SELECT id, lower(email) AS email FROM users WHERE org_id = ${orgId}`;
  return new Map(rows.map((r) => [r.email, r.id]));
}

export async function handleEmail(
  d: Delivery, env: Env, sql: Sql, ctx: { waitUntil(p: Promise<unknown>): void },
): Promise<Outcome> {
  const org = await resolveOrgByEmail(env, sql, d.to);
  if (!org) return { ok: false, reason: `no tenant for ${d.to}` };

  const mail = d.mail ?? await parseEmail(d.raw ?? '');
  if (isAutomated(mail.header)) return { ok: false, reason: 'automated mail, ignored' };

  // Our own address in From means we are reading something we sent — the start of a loop.
  const ours = new Set([d.to.toLowerCase(), String(org.comms.email_inbound ?? '').toLowerCase()]);
  if (ours.has(mail.from.email)) return { ok: false, reason: 'loop: from our own address' };

  return withOrg(sql, org.id, async (tx) => {
    const team = await colleagues(tx, org.id);
    const shape = classify(mail, team, ours);
    if (!shape.customer.email) return { ok: false, reason: 'no customer address found' };

    const lead = await attach(tx, env, org, mail, shape);
    const saved = await store(tx, env, org, lead.id, mail, shape, ctx);
    if (saved === null) {
      return { ok: true, leadId: lead.id, ticket: lead.ticket_no, reason: 'already had this message' };
    }

    if (shape.direction === 'in') {
      // A customer answering ends any drip on this ticket, before the next one can go out.
      await stopOnReply(tx, org.id, lead.id);
      await env.JOBS.send({ kind: 'extract_specs', orgId: org.id, leadId: lead.id } as Job);
    }

    return {
      ok: true, leadId: lead.id, ticket: lead.ticket_no,
      direction: shape.direction, attachments: saved,
    };
  });
}

interface Shape {
  direction: 'in' | 'out';
  customer: Party;
  /** The colleague who sent or forwarded it, when there was one. */
  agentId: string | null;
  note: string | null;
}

/** Decide whose request this is and which way the message points. */
export function classify(mail: ParsedEmail, team: Map<string, string>, ours: Set<string>): Shape {
  const senderIsColleague = team.get(mail.from.email);

  // bcc on an outgoing mail: the colleague wrote it, so the customer is who they wrote to.
  if (senderIsColleague && !mail.forwardedBy) {
    const counterpart = mail.to.find((a) => !ours.has(a) && !team.has(a));
    if (counterpart) {
      return {
        direction: 'out',
        customer: { name: null, email: counterpart },
        agentId: senderIsColleague,
        note: null,
      };
    }
  }

  // A forward carries the customer in its body; the forwarder is only worth recording.
  if (mail.forwardedBy) {
    return {
      direction: 'in',
      customer: mail.from,
      agentId: team.get(mail.forwardedBy.email) ?? null,
      note: `Forwarded by ${mail.forwardedBy.name ?? mail.forwardedBy.email}`,
    };
  }

  return { direction: 'in', customer: mail.from, agentId: null, note: null };
}

/**
 * Find the ticket this belongs to, or open one.
 *
 * Email threads properly, which SMS cannot: In-Reply-To and References name the exact
 * message being answered, and we stored our own Message-IDs when we sent them. That beats
 * the time window, which stays only as the last resort for a client that dropped the headers.
 */
async function attach(
  tx: Tx, env: Env, org: Org, mail: ParsedEmail, shape: Shape,
): Promise<{ id: string; ticket_no: string }> {
  const refs = [mail.inReplyTo, ...mail.references].filter(Boolean) as string[];
  if (refs.length) {
    // Passed as jsonb, not a text[]: the pool runs with fetch_types disabled, so postgres.js
    // cannot infer an array's element type and binds it as a string literal that matches
    // nothing. Same reason leads.missing_fields is read through to_jsonb.
    const [hit] = await tx<{ id: string; ticket_no: string }[]>`
      SELECT l.id, l.ticket_no FROM messages m JOIN leads l ON l.id = m.lead_id
       WHERE m.provider_id IN (SELECT jsonb_array_elements_text(${tx.json(refs)}))
       LIMIT 1`;
    if (hit) return hit;
  }

  if (mail.ticketHint) {
    const [hit] = await tx<{ id: string; ticket_no: string }[]>`
      SELECT id, ticket_no FROM leads WHERE ticket_no = ${mail.ticketHint} AND archived_at IS NULL`;
    if (hit) return hit;
  }

  // Last resort, and only for a customer we already know: the same time window SMS uses.
  const [known] = await tx<{ id: string }[]>`
    SELECT id FROM contacts WHERE org_id = ${org.id} AND email = ${shape.customer.email} LIMIT 1`;
  if (known) {
    const recent = await findThreadableLead(tx, org.id, known.id);
    if (recent) {
      const [row] = await tx<{ id: string; ticket_no: string }[]>`
        SELECT id, ticket_no FROM leads WHERE id = ${recent}`;
      if (row) return row;
    }
  }

  return openTicket(tx, env, org, mail, shape);
}

async function openTicket(
  tx: Tx, env: Env, org: Org, mail: ParsedEmail, shape: Shape,
): Promise<{ id: string; ticket_no: string }> {
  const r = await env.INTERNAL.fetch('https://internal/internal/leads/from-email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': env.SESSION_SECRET },
    body: JSON.stringify({
      orgId: org.id,
      contact: { name: shape.customer.name, email: shape.customer.email },
      subject: mail.subject,
      body: mail.body,
      assigneeId: shape.direction === 'out' ? shape.agentId : null,
      status: shape.direction === 'out' ? 'replied' : 'new',
    }),
  });
  if (!r.ok) throw new Error(`from-email failed: ${r.status} ${await r.text()}`);
  return r.json() as Promise<{ id: string; ticket_no: string }>;
}

/** Write the message and its attachments. */
async function store(
  tx: Tx, env: Env, org: Org, leadId: string, mail: ParsedEmail, shape: Shape,
  ctx: { waitUntil(p: Promise<unknown>): void },
): Promise<number | null> {
  const messageId = ulid();
  const body = [shape.note, mail.subject ? `Subject: ${mail.subject}` : null, mail.body]
    .filter(Boolean).join('\n\n');

  // Message-ID is unique, which makes redelivery harmless: mail providers retry, and
  // Cloudflare will replay a message the Worker failed on. Conflicting means we already have
  // it, so this is a no-op rather than an error or a second copy on the ticket.
  const [written] = await tx<{ id: string }[]>`
    INSERT INTO messages (id, lead_id, channel, direction, author, body, raw, provider_id)
           VALUES (${messageId}, ${leadId}, 'email', ${shape.direction},
                   ${shape.direction === 'out' ? (shape.agentId ?? 'system') : 'visitor'},
                   ${body}, ${tx.json({
                     subject: mail.subject,
                     from_name: mail.from.name, from_email: mail.from.email,
                     to: mail.to,
                     forwarded_by: mail.forwardedBy?.email ?? null,
                   })}, ${mail.messageId})
    ON CONFLICT (provider_id) WHERE provider_id IS NOT NULL DO NOTHING
    RETURNING id`;
  if (!written) return null;

  let kept = 0;
  for (const a of mail.attachments) {
    const size = a.content.byteLength;
    // Artwork is the job in a print shop, but a 40MB PDF cannot ride an email. Recorded as a
    // row with no file so the rep can see something was sent and ask for a link.
    const tooBig = size > MAX_ATTACHMENT;
    const key = `org/${org.id}/email/${leadId}/${ulid()}-${safeName(a.filename)}`;
    if (!tooBig) {
      ctx.waitUntil(env.FILES.put(key, a.content, { httpMetadata: { contentType: a.mimeType } }));
      kept++;
    }
    await tx`INSERT INTO attachments (id, lead_id, message_id, filename, mime, bytes, r2_key)
             VALUES (${ulid()}, ${leadId}, ${messageId}, ${a.filename}, ${a.mimeType},
                     ${size}, ${tooBig ? null : key})`;
  }

  await tx`UPDATE leads SET updated_at = now() WHERE id = ${leadId}`;
  await tx`INSERT INTO activity (id, org_id, lead_id, actor, kind, detail)
           VALUES (${ulid()}, ${org.id}, ${leadId},
                   ${shape.agentId ?? 'system'},
                   ${shape.direction === 'out' ? 'replied' : 'message_in'},
                   ${tx.json({ channel: 'email', provider_id: mail.messageId, attachments: mail.attachments.length })})`;
  return kept;
}

const safeName = (n: string) => n.replace(/[^\w.\-]+/g, '_').slice(-80);
