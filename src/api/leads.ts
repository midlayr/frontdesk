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
           l.confidence, l.intent_score, l.first_reply_at, l.created_at, l.updated_at,
           -- newest inbound timestamp: lets the queue pulse a row that just got a reply,
           -- which updated_at alone would miss when only messages changed
           (SELECT max(sent_at) FROM messages m WHERE m.lead_id = l.id AND m.direction = 'in') AS last_in_at,
           -- to_jsonb: Hyperdrive needs fetch_types:false, which leaves postgres.js unable to
           -- parse text[] — without this the client receives the string '{}' instead of [].
           to_jsonb(l.missing_fields) AS missing_fields,
           c.name AS contact_name, c.phone AS contact_phone, c.email AS contact_email,
           cs.do_id AS chat_sid
      FROM leads l
      LEFT JOIN contacts c ON c.id = l.contact_id
      LEFT JOIN LATERAL (
        SELECT do_id FROM chat_sessions WHERE lead_id = l.id ORDER BY started_at DESC LIMIT 1
      ) cs ON true
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
    // trailing to_jsonb wins over the text[] from SELECT * (see note above)
    const [lead] = await tx`
      SELECT l.*, to_jsonb(l.missing_fields) AS missing_fields,
             -- the list endpoint joins contacts; without the same join here the ticket
             -- header fell back to "Anonymous" for a lead that plainly has a contact
             c.name AS contact_name, c.phone AS contact_phone, c.email AS contact_email,
             (SELECT do_id FROM chat_sessions WHERE lead_id = l.id ORDER BY started_at DESC LIMIT 1) AS chat_sid
        FROM leads l LEFT JOIN contacts c ON c.id = l.contact_id
       WHERE l.id = ${id}`;
    if (!lead) return null;
    const messages = await tx`SELECT id, channel, direction, author, body, provider_id, sent_at,
                                     audio_r2_key IS NOT NULL AS has_audio, transcript_status
                                FROM messages WHERE lead_id = ${id} ORDER BY sent_at`;
    const attachments = await tx`SELECT id, r2_key, filename, mime, bytes FROM attachments WHERE lead_id = ${id}`;
    const activity = await tx`SELECT id, actor, kind, detail, at FROM activity WHERE lead_id = ${id} ORDER BY at`;
    return { lead, messages, attachments, activity };
  });

  return found ? c.json(found) : c.json({ error: 'not found' }, 404);
});

/**
 * Re-run extraction over a ticket's inbound messages.
 *
 * Needed whenever the prompt or model changes, or a job died into the DLQ — otherwise the
 * only way to re-extract is to ask the customer to text again.
 */
leads.post('/:id/reextract', async (c) => {
  const org = c.get('org');
  const id = c.req.param('id');

  const exists = await withOrg(c.get('sql'), org.id, async (tx) => {
    const [row] = await tx<{ id: string }[]>`SELECT id FROM leads WHERE id = ${id}`;
    return !!row;
  });
  if (!exists) return c.json({ error: 'not found' }, 404);

  await c.env.JOBS.send({ kind: 'extract_specs', orgId: org.id, leadId: id });
  return c.json({ ok: true, queued: 'extract_specs' });
});

/**
 * The rep's end of a live chat.
 *
 * Deliberately separate from /widget/session: that route is public and always opens a
 * visitor socket, so a rep socket has to sit behind /api where auth already applies.
 */
leads.get('/:id/chat', async (c) => {
  if (c.req.header('upgrade') !== 'websocket') return c.text('expected websocket', 426);
  const org = c.get('org');
  const id = c.req.param('id');

  const [row] = await withOrg(c.get('sql'), org.id, (tx) =>
    tx<{ do_id: string }[]>`
      SELECT do_id FROM chat_sessions
       WHERE lead_id = ${id} AND do_id IS NOT NULL
       ORDER BY started_at DESC LIMIT 1`);
  if (!row) return c.text('no chat session for this lead', 404);

  const url = new URL('https://do/');
  url.searchParams.set('role', 'rep');
  url.searchParams.set('sid', row.do_id);
  return c.env.CHAT_SESSION.get(c.env.CHAT_SESSION.idFromName(row.do_id)).fetch(url.toString(), c.req.raw);
});

/** Rep joins a live chat: hand the DO the rep's identity so both sides see the switch. */
leads.post('/:id/takeover', async (c) => {
  const org = c.get('org');
  const userId = c.get('userId');
  const id = c.req.param('id');

  const found = await withOrg(c.get('sql'), org.id, async (tx) => {
    const [row] = await tx<{ do_id: string | null; name: string }[]>`
      SELECT cs.do_id, u.name
        FROM chat_sessions cs
        JOIN leads l ON l.id = cs.lead_id
        LEFT JOIN users u ON u.id = ${userId}
       WHERE cs.lead_id = ${id}
       ORDER BY cs.started_at DESC LIMIT 1`;
    return row ?? null;
  });

  if (!found?.do_id) return c.json({ error: 'no chat session for this lead' }, 404);

  const stub = c.env.CHAT_SESSION.get(c.env.CHAT_SESSION.idFromName(found.do_id));
  const res = await stub.fetch('https://do/takeover', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': c.env.SESSION_SECRET },
    body: JSON.stringify({ repId: userId, repName: found.name ?? 'A rep' }),
  });
  if (!res.ok) return c.json({ error: `takeover failed: ${await res.text()}` }, 502);

  await withOrg(c.get('sql'), org.id, async (tx) => {
    await tx`UPDATE chat_sessions SET rep_id = ${userId}, state = 'live' WHERE do_id = ${found.do_id}`;
    await tx`UPDATE leads SET status = 'live' WHERE id = ${id}`;
    await tx`INSERT INTO activity (id, org_id, lead_id, actor, kind, detail)
             VALUES (${ulid()}, ${org.id}, ${id}, ${userId}, 'takeover', ${tx.json({})})`;
  });

  return c.json({ ok: true });
});

/**
 * Stream a voicemail recording.
 *
 * The R2 key comes from the message row inside the tenant's own transaction, never from the
 * request, so this cannot be pointed at another tenant's audio — and RLS means a message id
 * belonging to someone else simply does not resolve. Range requests are honoured so the
 * browser's audio scrubber works.
 */
leads.get('/:id/audio/:messageId', async (c) => {
  const org = c.get('org');
  const { id, messageId } = c.req.param();

  const [row] = await withOrg(c.get('sql'), org.id, (tx) =>
    tx<{ audio_r2_key: string | null }[]>`
      SELECT m.audio_r2_key FROM messages m
        JOIN leads l ON l.id = m.lead_id
       WHERE m.id = ${messageId} AND m.lead_id = ${id}`);

  const key = row?.audio_r2_key;
  if (!key || !key.startsWith(`org/${org.id}/`)) return c.json({ error: 'not found' }, 404);

  const range = c.req.header('range');
  const obj = await c.env.FILES.get(key, range ? { range: c.req.raw.headers } : undefined);
  if (!obj) return c.json({ error: 'recording missing' }, 404);

  const headers = new Headers({
    'content-type': obj.httpMetadata?.contentType ?? 'audio/mpeg',
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
  });
  if (obj.range && 'offset' in obj.range) {
    const start = obj.range.offset ?? 0;
    const end = start + (obj.range.length ?? obj.size) - 1;
    headers.set('content-range', `bytes ${start}-${end}/${obj.size}`);
    return new Response(obj.body, { status: 206, headers });
  }
  return new Response(obj.body, { headers });
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
