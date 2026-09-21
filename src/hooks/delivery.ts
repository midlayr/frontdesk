import { ulid } from 'ulid';
import type { Env } from '../env';
import type { Sql, Tx } from '../db';
import { withOrg } from '../db';
import { verifyMailgun } from '../lib/mailgun';
import { verifySignature } from '../lib/twilio';

/**
 * Delivery events — what happened to a message after we handed it over.
 *
 * These exist for the branch conditions: opened_no_reply, not_opened, clicked, bounced and
 * sms_delivered are unanswerable without them, and until one of these fires for a tenant the
 * engine deliberately refuses to act on "not opened" at all.
 *
 * Nothing here changes how mail is sent. It only writes timestamps back onto messages rows
 * that a send already created.
 */

/** Mailgun reports ids bare; we store what the send API returned, which has the brackets. */
const bracketed = (id: string) => (id.startsWith('<') ? id : `<${id}>`);

const COLUMN: Record<string, string> = {
  delivered: 'delivered_at',
  opened: 'opened_at',
  clicked: 'clicked_at',
  failed: 'bounced_at',
  complained: 'bounced_at',
};

/**
 * Stamp the event onto the message, and hold the enrollment if it bounced.
 *
 * The message is found by provider_id alone, which is unique across the platform, so the
 * tenant is derived from the row rather than trusted from the payload — a webhook cannot
 * name someone else's message and have it believed.
 */
async function record(sql: Sql, providerId: string, event: string): Promise<boolean> {
  const column = COLUMN[event];
  if (!column) return false;

  const [found] = await sql<{ lead_id: string; org_id: string; enrollment_id: string | null }[]>`
    SELECT m.lead_id, l.org_id, m.enrollment_id
      FROM messages m JOIN leads l ON l.id = m.lead_id
     WHERE m.provider_id IN (${providerId}, ${bracketed(providerId)})
     LIMIT 1`;
  if (!found) return false;

  await withOrg(sql, found.org_id, async (tx: Tx) => {
    // COALESCE so a replayed webhook keeps the first timestamp rather than moving it.
    await tx.unsafe(
      `UPDATE messages SET ${column} = COALESCE(${column}, now())
        WHERE provider_id = ANY($1::text[])`,
      [[providerId, bracketed(providerId)]]);

    if ((event === 'failed' || event === 'complained') && found.enrollment_id) {
      await tx`UPDATE enrollments SET state = 'held', held_reason = 'bounced'
                WHERE id = ${found.enrollment_id} AND state = 'active'`;
      await tx`INSERT INTO activity (id, org_id, lead_id, actor, kind, detail)
               VALUES (${ulid()}, ${found.org_id}, ${found.lead_id}, 'system', 'sequence_held',
                       ${tx.json({ reason: 'bounced', provider_id: providerId })})`;
    }
  });
  return true;
}

/** Mailgun's event webhook: {signature:{timestamp,token,signature}, event-data:{...}}. */
export async function mailgunEvents(req: Request, env: Env, sql: Sql): Promise<Response> {
  const body = await req.json().catch(() => null) as {
    signature?: { timestamp?: string; token?: string; signature?: string };
    'event-data'?: { event?: string; message?: { headers?: { 'message-id'?: string } } };
  } | null;

  const s = body?.signature;
  const ok = await verifyMailgun(
    env.MAILGUN_SIGNING_KEY, s?.timestamp ?? '', s?.token ?? '', s?.signature ?? '');
  // 406 so Mailgun stops retrying something that will never verify.
  if (!ok) return Response.json({ ok: false, error: 'bad or stale signature' }, { status: 406 });

  const data = body?.['event-data'];
  const id = data?.message?.headers?.['message-id'];
  if (!data?.event || !id) return Response.json({ ok: true, ignored: 'no message id' });

  const hit = await record(sql, id, data.event);
  return Response.json({ ok: true, event: data.event, matched: hit });
}

/** Twilio's status callback: form-encoded MessageSid / MessageStatus. */
export async function twilioStatus(req: Request, env: Env, sql: Sql): Promise<Response> {
  const form = await req.formData().catch(() => null);
  if (!form) return new Response('expected a form', { status: 400 });

  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === 'string') params[k] = v;

  const ok = await verifySignature(
    env.TWILIO_AUTH_TOKEN, req.url, params, req.headers.get('x-twilio-signature'));
  if (!ok) return new Response('bad signature', { status: 403 });

  const sid = params.MessageSid ?? params.SmsSid;
  const status = params.MessageStatus ?? params.SmsStatus;
  if (!sid || !status) return Response.json({ ok: true, ignored: 'no sid' });

  const event = status === 'delivered' ? 'delivered'
    : status === 'failed' || status === 'undelivered' ? 'failed'
    : null;
  if (!event) return Response.json({ ok: true, ignored: status });

  const hit = await record(sql, sid, event);
  return Response.json({ ok: true, status, matched: hit });
}

/**
 * A human answered — every running sequence on that lead stops.
 *
 * Called from the inbound handlers rather than left to the cron, because the next drip could
 * otherwise go out minutes after a customer replied, which is precisely the behaviour the
 * locked branch exists to prevent.
 */
export async function stopOnReply(tx: Tx, orgId: string, leadId: string): Promise<number> {
  const stopped = await tx<{ id: string }[]>`
    UPDATE enrollments SET state = 'replied'
     WHERE lead_id = ${leadId} AND state IN ('active', 'held')
     RETURNING id`;
  if (!stopped.length) return 0;

  // Back into the queue as something needing a person, and to whoever last spoke to them.
  await tx`UPDATE leads
              SET status = CASE WHEN status IN ('replied','quoted') THEN 'new'::lead_status ELSE status END,
                  assignee_id = COALESCE(assignee_id, (
                    SELECT m.author FROM messages m
                     WHERE m.lead_id = ${leadId} AND m.direction = 'out'
                       AND m.author NOT LIKE 'sequence:%'
                     ORDER BY m.sent_at DESC LIMIT 1))
            WHERE id = ${leadId}`;

  await tx`INSERT INTO activity (id, org_id, lead_id, actor, kind, detail)
           VALUES (${ulid()}, ${orgId}, ${leadId}, 'system', 'sequence_stopped',
                   ${tx.json({ reason: 'replied', enrollments: stopped.length })})`;
  return stopped.length;
}
