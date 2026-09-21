import { ulid } from 'ulid';
import { stopOnReply } from './delivery';
import { onLeadCreated } from '../lib/enroll';
import type { Env, Org } from '../env';
import { withOrg, type Sql, type Tx } from '../db';
import { resolveOrgByPhone, ticketPrefix } from '../org';
import { findThreadableLead } from '../lib/threading';
import { verifySignature, emptyTwiml } from '../lib/twilio';
import { messagingFor, render } from '../lib/messaging';

/** Next ticket number for the tenant. The UPDATE ... RETURNING locks the counter row. */
async function nextTicket(tx: Tx, org: Org): Promise<string> {
  const [row] = await tx<{ next_ticket: number }[]>`
    UPDATE counters SET next_ticket = next_ticket + 1
     WHERE org_id = ${org.id}
     RETURNING next_ticket - 1 AS next_ticket`;
  if (!row) throw new Error(`no counters row for org ${org.id}`);
  return `${ticketPrefix(org)}-${row.next_ticket}`;
}

async function findOrCreateContact(tx: Tx, orgId: string, phone: string): Promise<string> {
  const [found] = await tx<{ id: string }[]>`
    SELECT id FROM contacts WHERE org_id = ${orgId} AND phone = ${phone} LIMIT 1`;
  if (found) return found.id;

  const id = ulid();
  await tx`INSERT INTO contacts (id, org_id, phone, source)
           VALUES (${id}, ${orgId}, ${phone}, 'inbound')`;
  return id;
}

/**
 * POST /hooks/twilio/sms
 *
 * Inbound text → contact → lead (or the contact's open lead) → message → extract_specs job.
 * Replies with empty TwiML so Twilio doesn't auto-send anything; the rep replies from the queue.
 */
export async function twilioSms(req: Request, env: Env, sql: Sql): Promise<Response> {
  const form = await req.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form) params[k] = String(v);

  const from = params.From;
  const to = params.To;
  const body = params.Body ?? '';
  const providerId = params.MessageSid;
  if (!from || !to) return new Response('missing From/To', { status: 400 });

  const org = await resolveOrgByPhone(env, sql, to);
  // Unknown number: 404 rather than 403, and never before signature check leaks nothing —
  // we cannot verify a signature without knowing which tenant's token to use, and the token
  // is account-wide, so verify first using the account token.
  if (!org) return new Response('no tenant for that number', { status: 404 });

  const ok = await verifySignature(env.TWILIO_AUTH_TOKEN, req.url, params, req.headers.get('x-twilio-signature'));
  if (!ok) return new Response('bad signature', { status: 403 });

  let isNewLead = false;
  let ticketNo: string | null = null;

  const leadId = await withOrg(sql, org.id, async (tx) => {
    // Webhook retries replay the same MessageSid. The unique partial index on
    // messages.provider_id makes the insert the idempotency check.
    if (providerId) {
      const [dupe] = await tx<{ lead_id: string }[]>`
        SELECT lead_id FROM messages WHERE provider_id = ${providerId} LIMIT 1`;
      if (dupe) return null;
    }

    const contactId = await findOrCreateContact(tx, org.id, from);

    // Same conversation only while it is still warm — see lib/threading.
    const openId = await findThreadableLead(tx, org.id, contactId);

    let id: string;
    if (openId) {
      id = openId;
    } else {
      id = ulid();
      isNewLead = true;
      ticketNo = await nextTicket(tx, org);
      await tx`INSERT INTO leads (id, org_id, ticket_no, contact_id, channel, status)
               VALUES (${id}, ${org.id}, ${ticketNo}, ${contactId}, 'sms', 'new')`;
      await tx`INSERT INTO activity (id, org_id, lead_id, actor, kind, detail)
               VALUES (${ulid()}, ${org.id}, ${id}, 'system', 'lead_created',
                       ${tx.json({ channel: 'sms', ticket_no: ticketNo, from })})`;
    }

    await tx`INSERT INTO messages (id, lead_id, channel, direction, author, body, raw, provider_id)
             VALUES (${ulid()}, ${id}, 'sms', 'in', 'visitor', ${body},
                     ${tx.json(params)}, ${providerId ?? null})
             ON CONFLICT (provider_id) WHERE provider_id IS NOT NULL DO NOTHING`;

    await tx`INSERT INTO activity (id, org_id, lead_id, actor, kind, detail)
             VALUES (${ulid()}, ${org.id}, ${id}, 'system', 'message_in',
                     ${tx.json({ channel: 'sms', provider_id: providerId ?? null })})`;

    // A text back ends any drip on this ticket, before the next step can go out. Ordered
    // before enrolment so a reply on an existing ticket cannot be undone by a new-lead
    // sequence starting in the same transaction.
    await stopOnReply(tx, org.id, id);
    if (isNewLead) await onLeadCreated(tx, org.id, id);

    return id;
  });

  if (leadId) {
    await env.JOBS.send({ kind: 'extract_specs', orgId: org.id, leadId });
  }

  // An acknowledgement, if the tenant wants one. Sent as TwiML rather than a separate API
  // call so it costs nothing extra and cannot race the inbound write. Only on a new ticket:
  // auto-replying to every message in a running conversation is maddening.
  const { sms } = messagingFor(org);
  if (leadId && isNewLead && sms.auto_reply_enabled && sms.auto_reply.trim()) {
    const body = render(sms.auto_reply, { org: org.name, ticket: ticketNo ?? '' });
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${body.replace(/[<&]/g, '')}</Message></Response>`,
      { headers: { 'content-type': 'text/xml' } },
    );
  }

  return emptyTwiml();
}
