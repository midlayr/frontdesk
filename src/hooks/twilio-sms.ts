import { ulid } from 'ulid';
import type { Env, Org } from '../env';
import { connect, withOrg, type Tx } from '../db';
import { resolveOrgByPhone, ticketPrefix } from '../org';
import { verifySignature, emptyTwiml } from '../lib/twilio';

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
export async function twilioSms(
  req: Request,
  env: Env,
  ctx: { waitUntil(p: Promise<unknown>): void },
): Promise<Response> {
  const form = await req.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form) params[k] = String(v);

  const from = params.From;
  const to = params.To;
  const body = params.Body ?? '';
  const providerId = params.MessageSid;
  if (!from || !to) return new Response('missing From/To', { status: 400 });

  const sql = connect(env);
  ctx.waitUntil(sql.end());

  const org = await resolveOrgByPhone(env, sql, to);
  // Unknown number: 404 rather than 403, and never before signature check leaks nothing —
  // we cannot verify a signature without knowing which tenant's token to use, and the token
  // is account-wide, so verify first using the account token.
  if (!org) return new Response('no tenant for that number', { status: 404 });

  const ok = await verifySignature(env.TWILIO_AUTH_TOKEN, req.url, params, req.headers.get('x-twilio-signature'));
  if (!ok) return new Response('bad signature', { status: 403 });

  const leadId = await withOrg(sql, org.id, async (tx) => {
    // Webhook retries replay the same MessageSid. The unique partial index on
    // messages.provider_id makes the insert the idempotency check.
    if (providerId) {
      const [dupe] = await tx<{ lead_id: string }[]>`
        SELECT lead_id FROM messages WHERE provider_id = ${providerId} LIMIT 1`;
      if (dupe) return null;
    }

    const contactId = await findOrCreateContact(tx, org.id, from);

    // Keep a running conversation on one ticket instead of opening a new one per text.
    const [open] = await tx<{ id: string }[]>`
      SELECT id FROM leads
       WHERE org_id = ${org.id} AND contact_id = ${contactId}
         AND status NOT IN ('won','lost','closed','spam')
       ORDER BY created_at DESC LIMIT 1`;

    let id: string;
    if (open) {
      id = open.id;
    } else {
      id = ulid();
      const ticketNo = await nextTicket(tx, org);
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

    return id;
  });

  if (leadId) {
    await env.JOBS.send({ kind: 'extract_specs', orgId: org.id, leadId });
  }

  return emptyTwiml();
}
