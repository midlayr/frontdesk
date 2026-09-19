import { Hono } from 'hono';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { Env, Org } from '../env';
import { withOrg, type Sql } from '../db';
import { sendSms } from '../lib/twilio';

type Vars = { org: Org; sql: Sql; userId: string };

export const leads = new Hono<{ Bindings: Env; Variables: Vars }>();

// queue order: live chats first, then rush, then soonest deadline, then oldest.
leads.get('/', async (c) => {
  const org = c.get('org');
  const status = c.req.query('status');
  const assignee = c.req.query('assignee');
  const q = c.req.query('q');

  const rows = await withOrg(c.get('sql'), org.id, (tx) => tx`
    SELECT l.id, l.ticket_no, l.channel, l.status, l.rush, l.deadline_at, l.assignee_id,
           l.product, l.qty, l.size, l.stock, l.color, l.finish,
           l.confidence, l.missing_fields, l.intent_score, l.first_reply_at, l.created_at,
           c.name AS contact_name, c.phone AS contact_phone, c.email AS contact_email
      FROM leads l LEFT JOIN contacts c ON c.id = l.contact_id
     WHERE (${status ?? null}::text IS NULL OR l.status = ${status ?? null}::lead_status)
       AND (${assignee ?? null}::text IS NULL OR l.assignee_id = ${assignee ?? null})
       AND (${q ?? null}::text IS NULL OR l.search @@ plainto_tsquery('simple', ${q ?? null}))
     ORDER BY (l.status = 'live') DESC, l.rush DESC, l.deadline_at NULLS LAST, l.created_at
     LIMIT 200`);

  return c.json({ leads: rows });
});

leads.get('/:id', async (c) => {
  const org = c.get('org');
  const id = c.req.param('id');

  const found = await withOrg(c.get('sql'), org.id, async (tx) => {
    const [lead] = await tx`SELECT * FROM leads WHERE id = ${id}`;
    if (!lead) return null;
    const messages = await tx`SELECT id, channel, direction, author, body, provider_id, sent_at
                                FROM messages WHERE lead_id = ${id} ORDER BY sent_at`;
    const attachments = await tx`SELECT id, r2_key, filename, mime, bytes FROM attachments WHERE lead_id = ${id}`;
    const activity = await tx`SELECT id, actor, kind, detail, at FROM activity WHERE lead_id = ${id} ORDER BY at`;
    return { lead, messages, attachments, activity };
  });

  return found ? c.json(found) : c.json({ error: 'not found' }, 404);
});

const Reply = z.object({ body: z.string().min(1).max(1600) });

/**
 * POST /api/leads/:id/reply
 *
 * Sends on the lead's own channel, from the tenant's number, then records the message and
 * flips the ticket to replied. The send happens before the write so a Twilio failure surfaces
 * as a 502 instead of a ticket that claims a reply the customer never got.
 */
leads.post('/:id/reply', async (c) => {
  const org = c.get('org');
  const userId = c.get('userId');
  const id = c.req.param('id');

  const parsed = Reply.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'body required' }, 400);
  const { body } = parsed.data;

  const sql = c.get('sql');

  const target = await withOrg(sql, org.id, async (tx) => {
    const [row] = await tx<{ channel: string; phone: string | null; email: string | null }[]>`
      SELECT l.channel, c.phone, c.email
        FROM leads l LEFT JOIN contacts c ON c.id = l.contact_id
       WHERE l.id = ${id}`;
    return row ?? null;
  });

  if (!target) return c.json({ error: 'not found' }, 404);

  if (target.channel !== 'sms') {
    // voice/email/chat replies land here once those channels ship (GETTING-STARTED §5).
    return c.json({ error: `reply on ${target.channel} not implemented yet` }, 501);
  }
  if (!target.phone) return c.json({ error: 'contact has no phone' }, 422);

  const from = org.comms.sms_number;
  if (!from) return c.json({ error: 'tenant has no comms.sms_number configured' }, 500);

  let sent;
  try {
    sent = await sendSms(c.env, from, target.phone, body);
  } catch (err) {
    console.error('reply send failed', err);
    return c.json({ error: String(err instanceof Error ? err.message : err) }, 502);
  }

  await withOrg(sql, org.id, async (tx) => {
    await tx`INSERT INTO messages (id, lead_id, channel, direction, author, body, provider_id)
             VALUES (${ulid()}, ${id}, 'sms', 'out', ${userId}, ${body}, ${sent.sid})`;
    await tx`UPDATE leads
                SET status = 'replied',
                    first_reply_at = COALESCE(first_reply_at, now())
              WHERE id = ${id}`;
    await tx`INSERT INTO activity (id, org_id, lead_id, actor, kind, detail)
             VALUES (${ulid()}, ${org.id}, ${id}, ${userId}, 'replied',
                     ${tx.json({ channel: 'sms', provider_id: sent.sid })})`;
  });

  return c.json({ ok: true, provider_id: sent.sid, status: 'replied' });
});
