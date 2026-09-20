import { Hono } from 'hono';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { Env, Org } from '../env';
import { withOrg, type Sql } from '../db';
import { sendSms } from '../lib/twilio';
import { messagingFor, render } from '../lib/messaging';

type Vars = { org: Org; sql: Sql; userId: string };

export const leads = new Hono<{ Bindings: Env; Variables: Vars }>();

// queue order: live chats first, then rush, then soonest deadline, then oldest.
leads.get('/', async (c) => {
  const org = c.get('org');
  const status = c.req.query('status');
  const assignee = c.req.query('assignee');
  const q = c.req.query('q');
  const archived = c.req.query('archived') === '1';

  const rows = await withOrg(c.get('sql'), org.id, (tx) => tx`
    SELECT l.id, l.ticket_no, l.channel, l.status, l.rush, l.deadline_at, l.assignee_id,
           l.product, l.qty, l.size, l.stock, l.color, l.finish,
           l.confidence, l.intent_score, l.first_reply_at, l.created_at, l.updated_at, l.archived_at,
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
     WHERE (CASE WHEN ${archived} THEN l.archived_at IS NOT NULL ELSE l.archived_at IS NULL END)
       AND (${status ?? null}::text IS NULL OR l.status = ${status ?? null}::lead_status)
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
             co.name AS company_name,
             (SELECT do_id FROM chat_sessions WHERE lead_id = l.id ORDER BY started_at DESC LIMIT 1) AS chat_sid
        FROM leads l
        LEFT JOIN contacts c ON c.id = l.contact_id
        LEFT JOIN companies co ON co.id = l.company_id
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

const SPEC_FIELDS = ['product', 'qty', 'size', 'stock', 'color', 'finish'] as const;

const Patch = z.object({
  product: z.string().nullable().optional(),
  qty: z.number().int().positive().nullable().optional(),
  size: z.string().nullable().optional(),
  stock: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  finish: z.string().nullable().optional(),
  rush: z.boolean().optional(),
  deadline_at: z.string().datetime().nullable().optional(),
  status: z.enum(['live','new','needs_info','replied','quoted','won','lost','closed','spam']).optional(),
  contact: z.object({
    name: z.string().nullable().optional(),
    company: z.string().nullable().optional(),
    email: z.string().email().nullable().optional(),
    phone: z.string().nullable().optional(),
  }).optional(),
});

/**
 * Inline edit of a ticket.
 *
 * Matters most on voicemail: a caller leaves a number and rarely spells out their company or
 * email, so the rep fills it in while listening. Contact edits write through to the contacts
 * row rather than sitting on the lead, so the next enquiry from that person already knows who
 * they are — and a named company is matched or created the same way the chat flow does it.
 *
 * Unlike extraction, an edit here is authoritative: a rep correcting 500 to 1000 overwrites,
 * where the model only ever fills blanks.
 */
leads.patch('/:id', async (c) => {
  const org = c.get('org');
  const userId = c.get('userId');
  const id = c.req.param('id');

  const parsed = Patch.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'bad patch', detail: parsed.error.issues }, 400);
  const p = parsed.data;

  const result = await withOrg(c.get('sql'), org.id, async (tx) => {
    const [lead] = await tx<{ contact_id: string | null }[]>`
      SELECT contact_id FROM leads WHERE id = ${id}`;
    if (!lead) return null;

    if (p.contact) {
      let companyId: string | null = null;
      if (p.contact.company) {
        const [found] = await tx<{ id: string }[]>`
          SELECT id FROM companies WHERE org_id = ${org.id} AND lower(name) = lower(${p.contact.company}) LIMIT 1`;
        companyId = found?.id ?? ulid();
        if (!found) {
          await tx`INSERT INTO companies (id, org_id, name) VALUES (${companyId}, ${org.id}, ${p.contact.company})`;
        }
        await tx`UPDATE leads SET company_id = ${companyId} WHERE id = ${id}`;
      }

      let contactId = lead.contact_id;
      if (!contactId) {
        contactId = ulid();
        await tx`INSERT INTO contacts (id, org_id, source) VALUES (${contactId}, ${org.id}, 'manual')`;
        await tx`UPDATE leads SET contact_id = ${contactId} WHERE id = ${id}`;
      }

      // COALESCE on the *incoming* value: undefined leaves the column alone, an explicit
      // value overwrites, so a rep can correct a bad transcription.
      await tx`UPDATE contacts SET
                 name = COALESCE(${p.contact.name ?? null}, name),
                 email = COALESCE(${p.contact.email ?? null}, email),
                 phone = COALESCE(${p.contact.phone ?? null}, phone),
                 company_id = COALESCE(${companyId}, company_id)
               WHERE id = ${contactId}`;
    }

    // Only the keys actually sent are written, so omitting a field leaves it alone while
    // sending null clears it — which is what an inline editor needs.
    const patch: Record<string, unknown> = {};
    for (const f of SPEC_FIELDS) if (f in p) patch[f] = p[f] ?? null;
    if (p.rush !== undefined) patch.rush = p.rush;
    if (p.deadline_at !== undefined) patch.deadline_at = p.deadline_at;
    if (p.status !== undefined) patch.status = p.status;

    if (Object.keys(patch).length) {
      await tx`UPDATE leads SET ${tx(patch)} WHERE id = ${id}`;

      // Remember which fields a human set. extract_specs will not touch these again, so a
      // later message cannot quietly undo a correction the rep made while on the phone.
      const locked = SPEC_FIELDS.filter((f) => f in p);
      if (locked.length) {
        await tx`UPDATE leads
                    SET spec = jsonb_set(spec, '{locked_fields}',
                          COALESCE(spec->'locked_fields', '[]'::jsonb) ||
                          ${tx.json(locked)}::jsonb)
                  WHERE id = ${id}`;
      }

      // Keep the dashed "missing" chips honest after a manual edit.
      await tx`UPDATE leads SET missing_fields = ARRAY(
                 SELECT f FROM unnest(ARRAY['product','qty','size','stock','color','finish']) AS f
                  WHERE CASE f
                          WHEN 'product' THEN product WHEN 'qty' THEN qty::text
                          WHEN 'size' THEN size WHEN 'stock' THEN stock
                          WHEN 'color' THEN color ELSE finish END IS NULL)
               WHERE id = ${id}`;
    }

    await tx`INSERT INTO activity (id, org_id, lead_id, actor, kind, detail)
             VALUES (${ulid()}, ${org.id}, ${id}, ${userId}, 'edited', ${tx.json({
               fields: [...Object.keys(patch), ...(p.contact ? Object.keys(p.contact).map((k) => `contact.${k}`) : [])],
             })})`;

    const [fresh] = await tx`
      SELECT l.*, to_jsonb(l.missing_fields) AS missing_fields,
             c.name AS contact_name, c.phone AS contact_phone, c.email AS contact_email,
             co.name AS company_name
        FROM leads l
        LEFT JOIN contacts c ON c.id = l.contact_id
        LEFT JOIN companies co ON co.id = l.company_id
       WHERE l.id = ${id}`;
    return { ok: true, lead: fresh };
  });

  if (!result) return c.json({ error: 'not found' }, 404);
  return c.json(result);
});

/** Archive, and put back. Reversible, so no confirmation ceremony. */
leads.post('/:id/archive', async (c) => {
  const org = c.get('org');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const undo = c.req.query('undo') === '1';

  const [row] = await withOrg(c.get('sql'), org.id, async (tx) => {
    const r = await tx<{ id: string }[]>`
      UPDATE leads SET archived_at = ${undo ? null : new Date().toISOString()},
                       archived_by = ${undo ? null : userId}
       WHERE id = ${id} RETURNING id`;
    if (r.length) {
      await tx`INSERT INTO activity (id, org_id, lead_id, actor, kind, detail)
               VALUES (${ulid()}, ${org.id}, ${id}, ${userId}, ${undo ? 'unarchived' : 'archived'}, ${tx.json({})})`;
    }
    return r;
  });

  return row ? c.json({ ok: true, archived: !undo }) : c.json({ error: 'not found' }, 404);
});

/**
 * Delete a ticket for good.
 *
 * messages, attachments and activity cascade. Voicemail recordings in R2 do not — nothing
 * in Postgres knows about the bucket — so their keys are collected first and removed after
 * the row is gone. Orphaned audio would otherwise sit there indefinitely, billed monthly and
 * invisible.
 *
 * Chat sessions and drip enrolments keep their rows with a null lead: they are records of
 * something that happened, not children of the ticket.
 */
leads.delete('/:id', async (c) => {
  const org = c.get('org');
  const userId = c.get('userId');
  const id = c.req.param('id');

  const result = await withOrg(c.get('sql'), org.id, async (tx) => {
    const [lead] = await tx<{ ticket_no: string }[]>`SELECT ticket_no FROM leads WHERE id = ${id}`;
    if (!lead) return null;

    const audio = await tx<{ audio_r2_key: string }[]>`
      SELECT audio_r2_key FROM messages WHERE lead_id = ${id} AND audio_r2_key IS NOT NULL`;
    const files = await tx<{ r2_key: string }[]>`
      SELECT r2_key FROM attachments WHERE lead_id = ${id}`;

    await tx`DELETE FROM leads WHERE id = ${id}`;
    return {
      ticket: lead.ticket_no,
      keys: [...audio.map((a) => a.audio_r2_key), ...files.map((f) => f.r2_key)],
    };
  });

  if (!result) return c.json({ error: 'not found' }, 404);

  // Belt and braces: never let a crafted key reach outside the tenant's own prefix.
  const mine = result.keys.filter((k) => k.startsWith(`org/${org.id}/`));
  c.executionCtx.waitUntil(Promise.all(mine.map((k) => c.env.FILES.delete(k))));

  // The lead is gone so its activity rows went with it; this one is the audit trail.
  await withOrg(c.get('sql'), org.id, async (tx) => {
    await tx`INSERT INTO activity (id, org_id, lead_id, actor, kind, detail)
             VALUES (${ulid()}, ${org.id}, NULL, ${userId}, 'lead_deleted',
                     ${tx.json({ ticket_no: result.ticket, files_removed: mine.length })})`;
  });

  return c.json({ ok: true, deleted: result.ticket, files_removed: mine.length });
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

  // Only ask R2 for a range when the client actually sent one, otherwise a plain GET comes
  // back as a 206 for the whole object.
  const wantsRange = !!c.req.header('range');
  const obj = await c.env.FILES.get(key, wantsRange ? { range: c.req.raw.headers } : undefined);
  if (!obj) return c.json({ error: 'recording missing' }, 404);

  const headers = new Headers({
    'content-type': obj.httpMetadata?.contentType ?? 'audio/mpeg',
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
  });
  if (wantsRange && obj.range && 'offset' in obj.range) {
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

  // The signature is appended on the way out and stored with the message, so the thread
  // shows exactly what the customer received rather than what the rep typed.
  const { sms } = messagingFor(org);
  const signature = render(sms.signature ?? '', { org: org.name }).trim();
  const outgoing = signature ? `${body}\n\n${signature}` : body;

  let sent;
  try {
    sent = await sendSms(c.env, from, target.phone, outgoing);
  } catch (err) {
    console.error('reply send failed', err);
    return c.json({ error: String(err instanceof Error ? err.message : err) }, 502);
  }

  await withOrg(sql, org.id, async (tx) => {
    await tx`INSERT INTO messages (id, lead_id, channel, direction, author, body, provider_id)
             VALUES (${ulid()}, ${id}, 'sms', 'out', ${userId}, ${outgoing}, ${sent.sid})`;
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
