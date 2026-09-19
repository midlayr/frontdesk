// GET /api/leads · GET /api/leads/:id · PATCH /api/leads/:id · POST /api/leads/:id/reply
import { Hono } from 'hono';
import { ulid } from 'ulid';
import type { Env } from '../index';
import { connect, withOrg, type Org } from '../db';

type Vars = { org: Org; userId: string };
export const leads = new Hono<{ Bindings: Env; Variables: Vars }>();

// queue: live → rush → deadline → arrived
leads.get('/', async (c) => {
  const org = c.get('org'); const q = c.req.query();
  const sql = connect(c.env);
  const rows = await withOrg(sql, org.id, (tx) => tx`
    SELECT l.id, l.ticket_no, l.channel, l.status, l.rush, l.deadline_at, l.product, l.qty, l.size, l.stock, l.finish,
           l.missing_fields, l.confidence, l.intent_score, l.created_at, l.assignee_id,
           ct.name AS contact_name, ct.phone, ct.email, co.name AS company
    FROM leads l LEFT JOIN contacts ct ON ct.id = l.contact_id LEFT JOIN companies co ON co.id = l.company_id
    WHERE l.org_id = ${org.id}
      ${q.status ? tx`AND l.status = ${q.status}::lead_status` : tx`AND l.status NOT IN ('closed','spam')`}
      ${q.assignee ? tx`AND l.assignee_id = ${q.assignee}` : tx``}
      ${q.q ? tx`AND (l.search @@ plainto_tsquery('simple', ${q.q}) OR co.name ILIKE ${'%' + q.q + '%'} OR ct.name ILIKE ${'%' + q.q + '%'})` : tx``}
    ORDER BY (l.status = 'live') DESC, l.rush DESC, l.deadline_at NULLS LAST, l.created_at ASC
    LIMIT 200`);
  return c.json(rows);
});

leads.get('/:id', async (c) => {
  const org = c.get('org'); const id = c.req.param('id');
  const sql = connect(c.env);
  const data = await withOrg(sql, org.id, async (tx) => {
    const [lead] = await tx`SELECT l.*, ct.name AS contact_name, ct.phone, ct.email, co.name AS company FROM leads l
      LEFT JOIN contacts ct ON ct.id = l.contact_id LEFT JOIN companies co ON co.id = l.company_id WHERE l.id = ${id}`;
    if (!lead) return null;
    const [messages, attachments, activity] = await Promise.all([
      tx`SELECT id, channel, direction, author, body, audio_r2_key, transcript_status, sent_at FROM messages WHERE lead_id = ${id} ORDER BY sent_at`,
      tx`SELECT id, filename, mime, bytes, created_at FROM attachments WHERE lead_id = ${id} ORDER BY created_at`,
      tx`SELECT actor, kind, detail, at FROM activity WHERE lead_id = ${id} ORDER BY at`,
    ]);
    return { ...lead, messages, attachments, activity };
  });
  return data ? c.json(data) : c.notFound();
});

// inline spec edit — correcting the AI is the normal case
const EDITABLE = new Set(['product', 'qty', 'size', 'stock', 'color', 'finish', 'deadline_at', 'rush', 'status', 'assignee_id']);
leads.patch('/:id', async (c) => {
  const org = c.get('org'); const id = c.req.param('id'); const body = await c.req.json();
  const patch = Object.fromEntries(Object.entries(body).filter(([k]) => EDITABLE.has(k)));
  if (!Object.keys(patch).length) return c.json({ error: 'nothing editable' }, 400);
  const sql = connect(c.env);
  const row = await withOrg(sql, org.id, async (tx) => {
    const [r] = await tx`UPDATE leads SET ${tx(patch)},
      confidence = confidence || ${tx.json(Object.fromEntries(Object.keys(patch).map((k) => [k, 1])))},
      missing_fields = array_remove(array_remove(array_remove(missing_fields, ${patch.product ? 'product' : null}), ${patch.qty ? 'qty' : null}), ${patch.deadline_at ? 'deadline' : null})
      WHERE id = ${id} RETURNING *`;
    await tx`INSERT INTO activity (id, org_id, lead_id, actor, kind, detail) VALUES (${ulid()}, ${org.id}, ${id}, ${c.get('userId')}, 'spec.edited', ${tx.json(patch)})`;
    return r;
  });
  return c.json(row);
});

// reply on the channel the lead came in on, from the tenant's own number / address
leads.post('/:id/reply', async (c) => {
  const org = c.get('org'); const id = c.req.param('id'); const { body: text } = await c.req.json();
  const sql = connect(c.env);
  const result = await withOrg(sql, org.id, async (tx) => {
    const [lead] = await tx`SELECT l.channel, l.first_reply_at, ct.phone, ct.email, ct.name, ct.opted_out FROM leads l JOIN contacts ct ON ct.id = l.contact_id WHERE l.id = ${id}`;
    if (!lead) return null;
    if (lead.opted_out && (lead.channel === 'sms' || lead.channel === 'voice')) throw new Error('contact opted out of SMS');
    let providerId: string | null = null;
    if (lead.channel === 'sms' || lead.channel === 'voice') providerId = await sendSms(c.env, org, lead.phone, text);
    else if (lead.channel === 'email' || lead.channel === 'form') providerId = await sendEmail(c.env, org, lead.email, `Re: your quote request`, text);
    // chat: ChatSession DO handles delivery; just log
    await tx`INSERT INTO messages (id, lead_id, channel, direction, author, body, provider_id) VALUES (${ulid()}, ${id}, ${lead.channel}, 'out', ${c.get('userId')}, ${text}, ${providerId})`;
    await tx`UPDATE leads SET status = CASE WHEN status IN ('new','needs_info','live') THEN 'replied'::lead_status ELSE status END,
      first_reply_at = COALESCE(first_reply_at, now()) WHERE id = ${id}`;
    await tx`UPDATE enrollments SET state = 'replied' WHERE lead_id = ${id} AND state = 'active'`;
    await tx`INSERT INTO activity (id, org_id, lead_id, actor, kind, detail) VALUES (${ulid()}, ${org.id}, ${id}, ${c.get('userId')}, 'reply.sent', ${tx.json({ channel: lead.channel })})`;
    return { ok: true };
  });
  return result ? c.json(result) : c.notFound();
});

async function sendSms(env: Env, org: Org, to: string, body: string) {
  // Prefer the A2P-registered Messaging Service; fall back to the bare number
  const sender = org.comms.messaging_service_sid ? { MessagingServiceSid: org.comms.messaging_service_sid } : { From: org.comms.sms_number! };
  if (!sender.MessagingServiceSid && !sender.From) throw new Error('org has no SMS sender');
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
    method: 'POST', headers: { Authorization: 'Basic ' + btoa(`${env.TWILIO_SID}:${env.TWILIO_AUTH_TOKEN}`), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...sender, To: to, Body: body }),
  });
  const j = await r.json() as any; if (!r.ok) throw new Error(j.message); return j.sid as string;
}
async function sendEmail(env: Env, org: Org, to: string, subject: string, text: string) {
  const from = org.comms.email_from; if (!from) throw new Error('org has no email_from');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: `${org.name} <${from}>`, to, subject, text: text + (org.comms.signature ? `\n\n${org.comms.signature}` : '') }),
  });
  const j = await r.json() as any; if (!r.ok) throw new Error(j.message); return j.id as string;
}
