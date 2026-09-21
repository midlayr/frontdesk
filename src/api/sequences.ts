import { Hono } from 'hono';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { Env, Org } from '../env';
import { withOrg, type Sql } from '../db';
import { CONDITIONS, ACTIONS, fill, normalise, validate, type Branch } from '../lib/drip';
import { TRIGGERS, enroll } from '../lib/enroll';
import { SPANS, compute, store, type Span } from '../jobs/sequence-stats';

type Vars = { org: Org; sql: Sql; userId: string; role: 'sales' | 'admin' };

export const sequences = new Hono<{ Bindings: Env; Variables: Vars }>();

/** Writing a sequence sends on the shop's behalf, so it is an admin decision. */
const adminOnly = (c: { get: (k: 'role') => string }) => c.get('role') !== 'admin';
const forbidden = { error: 'admins only' } as const;

const BranchSchema = z.object({
  if: z.enum(CONDITIONS),
  value: z.number().optional(),
  then: z.enum(ACTIONS),
  config: z.object({
    subject: z.string().optional(), step: z.number().int().optional(),
    user_id: z.string().optional(), text: z.string().optional(), tag: z.string().optional(),
  }).optional(),
});

const SequenceBody = z.object({
  name: z.string().min(1).max(80),
  trigger: z.enum(TRIGGERS),
  channel: z.enum(['sms', 'email']),
  trigger_config: z.record(z.string(), z.unknown()).optional(),
  send_window: z.object({
    days: z.array(z.number().int().min(1).max(7)),
    start: z.string(), end: z.string(), tz: z.string(),
  }).optional(),
  send_as: z.enum(['rep', 'org']).optional(),
});

const StepBody = z.object({
  kind: z.enum(['email', 'sms', 'wait', 'task']).optional(),
  subject: z.string().max(200).nullable().optional(),
  body: z.string().max(4000).optional(),
  delay_hours: z.number().min(0).max(24 * 365).optional(),
  attach_quote: z.boolean().optional(),
  branches: z.array(BranchSchema).optional(),
});

/** The list, with the rolled-up numbers alongside so the page needs one request. */
sequences.get('/', async (c) => {
  const org = c.get('org');
  const data = await withOrg(c.get('sql'), org.id, async (tx) => {
    const list = await tx`
      SELECT s.id, s.name, s.trigger, s.trigger_config, s.channel, s.active, s.send_window,
             s.send_as, s.created_at,
             (SELECT count(*)::int FROM sequence_steps st WHERE st.sequence_id = s.id) AS steps,
             (SELECT count(*)::int FROM enrollments e
               WHERE e.sequence_id = s.id AND e.state = 'active') AS active_count,
             (SELECT count(*)::int FROM enrollments e
               WHERE e.sequence_id = s.id AND e.state = 'held') AS held_count,
             (SELECT count(*)::int FROM enrollments e WHERE e.sequence_id = s.id) AS total_count
        FROM sequences s WHERE s.org_id = ${org.id} ORDER BY s.created_at DESC`;
    return { sequences: list };
  });
  return c.json(data);
});

sequences.get('/:id', async (c) => {
  const org = c.get('org');
  const id = c.req.param('id');
  const found = await withOrg(c.get('sql'), org.id, async (tx) => {
    const [seq] = await tx`SELECT * FROM sequences WHERE id = ${id} AND org_id = ${org.id}`;
    if (!seq) return null;
    const steps = await tx`
      SELECT id, position, kind, subject, body, attach_quote, branches,
             EXTRACT(epoch FROM delay) / 3600 AS delay_hours
        FROM sequence_steps WHERE sequence_id = ${id} ORDER BY position`;
    return { sequence: seq, steps };
  });
  return found ? c.json(found) : c.json({ error: 'not found' }, 404);
});

sequences.post('/', async (c) => {
  if (adminOnly(c)) return c.json(forbidden, 403);
  const org = c.get('org');
  const parsed = SequenceBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'bad sequence', detail: parsed.error.issues }, 400);

  const id = ulid();
  await withOrg(c.get('sql'), org.id, (tx) =>
    tx`INSERT INTO sequences (id, org_id, name, trigger, channel, trigger_config, send_as, active)
       VALUES (${id}, ${org.id}, ${parsed.data.name}, ${parsed.data.trigger},
               ${parsed.data.channel}, ${tx.json((parsed.data.trigger_config ?? {}) as never)},
               ${parsed.data.send_as ?? 'rep'}, false)`);
  // Created switched off, always. A sequence that starts sending the moment it is named,
  // before anyone has written a step, is not a feature.
  return c.json({ ok: true, id, active: false }, 201);
});

sequences.patch('/:id', async (c) => {
  if (adminOnly(c)) return c.json(forbidden, 403);
  const org = c.get('org');
  const id = c.req.param('id');
  const parsed = SequenceBody.partial().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'bad sequence', detail: parsed.error.issues }, 400);

  const patch: Record<string, unknown> = {};
  for (const k of ['name', 'trigger', 'channel', 'send_as'] as const) {
    if (parsed.data[k] !== undefined) patch[k] = parsed.data[k];
  }
  const updated = await withOrg(c.get('sql'), org.id, async (tx) => {
    if (parsed.data.trigger_config !== undefined) patch.trigger_config = tx.json(parsed.data.trigger_config as never);
    if (parsed.data.send_window !== undefined) patch.send_window = tx.json(parsed.data.send_window as never);
    if (!Object.keys(patch).length) return null;
    const [row] = await tx`UPDATE sequences SET ${tx(patch)} WHERE id = ${id} AND org_id = ${org.id} RETURNING *`;
    return row ?? null;
  });
  return updated ? c.json({ ok: true, sequence: updated }) : c.json({ error: 'not found' }, 404);
});

/**
 * Arm or disarm.
 *
 * Refuses to go live with no steps: enrolling people into nothing produces silence that
 * looks like a broken send rather than an unfinished sequence.
 */
sequences.post('/:id/live', async (c) => {
  if (adminOnly(c)) return c.json(forbidden, 403);
  const org = c.get('org');
  const id = c.req.param('id');
  const want = (await c.req.json().catch(() => ({}))) as { active?: boolean };

  const out = await withOrg(c.get('sql'), org.id, async (tx) => {
    const [{ n }] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM sequence_steps WHERE sequence_id = ${id}`;
    if (want.active && !n) return 'no-steps' as const;

    // Counting steps is not enough: a step added and never written would send an empty
    // email to a customer, and the sequence would look like it was working.
    if (want.active) {
      const blank = await tx<{ position: number }[]>`
        SELECT position FROM sequence_steps
         WHERE sequence_id = ${id} AND kind IN ('email','sms','task')
           AND btrim(COALESCE(body, '')) = ''
         ORDER BY position`;
      if (blank.length) return { blank: blank.map((b) => b.position) };
    }
    const [row] = await tx<{ active: boolean }[]>`
      UPDATE sequences SET active = ${!!want.active} WHERE id = ${id} AND org_id = ${org.id}
      RETURNING active`;
    return row ?? null;
  });
  if (out === 'no-steps') return c.json({ error: 'write a step before turning it on' }, 400);
  if (out && 'blank' in out) {
    const which = out.blank.map((p) => `step ${p}`).join(' and ');
    return c.json({ error: `${which} has nothing to send — write it or remove it` }, 400);
  }
  return out ? c.json({ ok: true, active: out.active }) : c.json({ error: 'not found' }, 404);
});

sequences.post('/:id/steps', async (c) => {
  if (adminOnly(c)) return c.json(forbidden, 403);
  const org = c.get('org');
  const id = c.req.param('id');
  const parsed = StepBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'bad step', detail: parsed.error.issues }, 400);

  const created = await withOrg(c.get('sql'), org.id, async (tx) => {
    const [seq] = await tx<{ id: string }[]>`SELECT id FROM sequences WHERE id = ${id} AND org_id = ${org.id}`;
    if (!seq) return null;
    const [{ next }] = await tx<{ next: number }[]>`
      SELECT COALESCE(max(position), 0) + 1 AS next FROM sequence_steps WHERE sequence_id = ${id}`;
    const stepId = ulid();
    const hours = parsed.data.delay_hours ?? (next === 1 ? 0 : 48);
    // Returns the whole row, not just an id. The client would otherwise have to fetch the
    // sequence again to show what it just created, and during those two round trips the list
    // is stale — which is long enough for someone to click again, or to act on the wrong step.
    const [row] = await tx`
      INSERT INTO sequence_steps (id, sequence_id, position, delay, kind, subject, body, branches)
      VALUES (${stepId}, ${id}, ${next}, make_interval(hours => ${hours}),
              ${parsed.data.kind ?? 'email'}, ${parsed.data.subject ?? null},
              ${parsed.data.body ?? ''}, ${tx.json(normalise([]) as never)})
      RETURNING id, position, kind, subject, body, attach_quote, branches,
                EXTRACT(epoch FROM delay) / 3600 AS delay_hours`;
    return { step: row };
  });
  return created ? c.json({ ok: true, ...created }, 201) : c.json({ error: 'not found' }, 404);
});

sequences.patch('/:id/steps/:stepId', async (c) => {
  if (adminOnly(c)) return c.json(forbidden, 403);
  const org = c.get('org');
  const { id, stepId } = c.req.param();
  const parsed = StepBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'bad step', detail: parsed.error.issues }, 400);

  const out = await withOrg(c.get('sql'), org.id, async (tx) => {
    const [seq] = await tx<{ id: string }[]>`SELECT id FROM sequences WHERE id = ${id} AND org_id = ${org.id}`;
    if (!seq) return null;

    if (parsed.data.branches) {
      const [{ n }] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM sequence_steps WHERE sequence_id = ${id}`;
      const branches = normalise(parsed.data.branches as Branch[]);
      const why = validate(branches, n);
      if (why) return { error: why };
      parsed.data.branches = branches;
    }

    const patch: Record<string, unknown> = {};
    for (const k of ['kind', 'subject', 'body', 'attach_quote'] as const) {
      if (parsed.data[k] !== undefined) patch[k] = parsed.data[k];
    }
    if (parsed.data.branches !== undefined) patch.branches = tx.json(parsed.data.branches as never);
    if (parsed.data.delay_hours !== undefined) {
      await tx`UPDATE sequence_steps SET delay = make_interval(hours => ${parsed.data.delay_hours})
                WHERE id = ${stepId} AND sequence_id = ${id}`;
    }
    if (!Object.keys(patch).length) return { ok: true };
    const [row] = await tx`UPDATE sequence_steps SET ${tx(patch)}
                            WHERE id = ${stepId} AND sequence_id = ${id} RETURNING id`;
    return row ? { ok: true } : null;
  });

  if (!out) return c.json({ error: 'not found' }, 404);
  if ('error' in out) return c.json(out, 400);
  return c.json(out);
});

sequences.delete('/:id/steps/:stepId', async (c) => {
  if (adminOnly(c)) return c.json(forbidden, 403);
  const org = c.get('org');
  const { id, stepId } = c.req.param();
  await withOrg(c.get('sql'), org.id, async (tx) => {
    await tx`DELETE FROM sequence_steps st USING sequences s
              WHERE st.id = ${stepId} AND st.sequence_id = s.id
                AND s.id = ${id} AND s.org_id = ${org.id}`;
    // Close the gap, so positions stay 1..n and "step 3 of 4" keeps meaning something.
    await tx`WITH ordered AS (
               SELECT id, row_number() OVER (ORDER BY position) AS rn
                 FROM sequence_steps WHERE sequence_id = ${id})
             UPDATE sequence_steps st SET position = o.rn FROM ordered o WHERE o.id = st.id`;
  });
  return c.json({ ok: true });
});

/**
 * Render a step exactly as it would be sent, against a real lead.
 *
 * Reads from the same fill() the send engine uses, so a preview that looks right and a send
 * that goes out cannot disagree — the whole reason the preview is worth having.
 */
sequences.post('/:id/steps/:stepId/preview', async (c) => {
  const org = c.get('org');
  const { id, stepId } = c.req.param();
  const body = await c.req.json().catch(() => ({})) as { leadId?: string };

  const out = await withOrg(c.get('sql'), org.id, async (tx) => {
    const [step] = await tx<{ subject: string | null; body: string; kind: string }[]>`
      SELECT subject, body, kind FROM sequence_steps
       WHERE id = ${stepId} AND sequence_id = ${id}`;
    if (!step) return null;

    const [lead] = await tx<Record<string, string | number | null>[]>`
      SELECT l.ticket_no, l.qty, l.product, l.size, l.stock, l.quote_amount,
             to_char(l.deadline_at, 'Mon DD') AS deadline,
             split_part(COALESCE(c.name,''), ' ', 1) AS first_name,
             co.name AS company, c.email, c.phone, u.name AS rep_name
        FROM leads l
   LEFT JOIN contacts c ON c.id = l.contact_id
   LEFT JOIN companies co ON co.id = l.company_id
   LEFT JOIN users u ON u.id = l.assignee_id
       WHERE l.org_id = ${org.id}
         AND (${body.leadId ?? null}::text IS NULL OR l.id = ${body.leadId ?? null})
       ORDER BY l.created_at DESC LIMIT 1`;

    const values = {
      ...lead,
      quote_amount: lead?.quote_amount ? `$${Number(lead.quote_amount).toLocaleString('en-US')}` : null,
      quote_link: null, rep_phone: null,
    };
    const rendered = fill(step.body, values);
    const subject = fill(step.subject ?? '', values);
    const sender = org.comms.email_sender || org.comms.email_inbound || '';

    return {
      kind: step.kind,
      from: `${org.name} <${sender}>`,
      reply_to: org.comms.email_inbound ?? sender,
      subject: subject.text,
      body: rendered.text,
      footer: step.kind === 'sms' ? 'Reply STOP to opt out.' : (org.comms.footer ?? org.name),
      missing: [...new Set([...rendered.missing, ...subject.missing])],
      against: lead ? { ticket_no: lead.ticket_no, company: lead.company } : null,
    };
  });
  return out ? c.json(out) : c.json({ error: 'not found' }, 404);
});

sequences.get('/:id/enrollments', async (c) => {
  const org = c.get('org');
  const id = c.req.param('id');
  const state = c.req.query('state');
  const rows = await withOrg(c.get('sql'), org.id, (tx) => tx`
    SELECT e.id, e.state, e.held_reason, e.next_send_at, e.next_step, e.last_sent_at,
           l.id AS lead_id, l.ticket_no, l.status AS lead_status,
           COALESCE(co.name, c.name, c.email, c.phone) AS who,
           (SELECT count(*)::int FROM sequence_steps st WHERE st.sequence_id = e.sequence_id) AS steps
      FROM enrollments e
      JOIN sequences s ON s.id = e.sequence_id AND s.org_id = ${org.id}
      JOIN leads l ON l.id = e.lead_id
 LEFT JOIN contacts c ON c.id = e.contact_id
 LEFT JOIN companies co ON co.id = l.company_id
     WHERE e.sequence_id = ${id}
       AND (${state ?? null}::text IS NULL OR e.state::text = ${state ?? null})
     ORDER BY e.next_send_at NULLS LAST, l.ticket_no`);
  return c.json({ enrollments: rows });
});

/** Bulk pause, resume or remove from the enrolled tab. */
sequences.patch('/:id/enrollments', async (c) => {
  if (adminOnly(c)) return c.json(forbidden, 403);
  const org = c.get('org');
  const id = c.req.param('id');
  const parsed = z.object({
    ids: z.array(z.string()).min(1).max(500),
    state: z.enum(['active', 'paused', 'removed']),
  }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'bad request', detail: parsed.error.issues }, 400);

  const n = await withOrg(c.get('sql'), org.id, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      UPDATE enrollments e SET state = ${parsed.data.state}::enroll_state
        FROM sequences s
       WHERE e.sequence_id = s.id AND s.id = ${id} AND s.org_id = ${org.id}
         AND e.id IN (SELECT jsonb_array_elements_text(${tx.json(parsed.data.ids)}))
      RETURNING e.id`;
    return rows.length;
  });
  return c.json({ ok: true, changed: n });
});

/**
 * Performance for one span.
 *
 * Serves the stored rollup, and computes one if the nightly job has not run for this
 * sequence yet — using the same aggregation, so a tab opened on day one shows the same
 * numbers the rollup will. Without that the screen would be empty until midnight and look
 * broken rather than new.
 */
sequences.get('/:id/stats', async (c) => {
  const org = c.get('org');
  const id = c.req.param('id');
  const span = (SPANS as readonly string[]).includes(c.req.query('span') ?? '')
    ? c.req.query('span') as Span : '30d';

  const out = await withOrg(c.get('sql'), org.id, async (tx) => {
    const [seq] = await tx<{ id: string }[]>`
      SELECT id FROM sequences WHERE id = ${id} AND org_id = ${org.id}`;
    if (!seq) return null;

    let rows = await tx`
      SELECT step_id, span, enrolled, sent, opened, clicked, replied, won, revenue, read, computed_at
        FROM sequence_stats WHERE sequence_id = ${id} AND span = ${span}`;

    if (!rows.length) {
      const fresh = await compute(tx, id, span);
      await store(tx, org.id, id, fresh);
      rows = await tx`
        SELECT step_id, span, enrolled, sent, opened, clicked, replied, won, revenue, read, computed_at
          FROM sequence_stats WHERE sequence_id = ${id} AND span = ${span}`;
    }

    const steps = await tx`
      SELECT id, position, kind, subject FROM sequence_steps
       WHERE sequence_id = ${id} ORDER BY position`;
    return { span, stats: rows, steps };
  });
  return out ? c.json(out) : c.json({ error: 'not found' }, 404);
});

/** Manual enrolment — the trigger a rep uses from a ticket. */
export async function enrollLead(
  sql: Sql, org: Org, leadId: string, sequenceId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await withOrg(sql, org.id, async (tx) => {
    const [seq] = await tx<{ id: string }[]>`
      SELECT id FROM sequences WHERE id = ${sequenceId} AND org_id = ${org.id}`;
    if (!seq) return { ok: false as const, reason: 'not_found' as const };
    return enroll(tx, org.id, leadId, sequenceId);
  });
  if (r.ok) return { status: 201, body: { ok: true, enrollment_id: r.id } };
  const code = r.reason === 'not_found' ? 404 : 409;
  return { status: code, body: { ok: false, reason: r.reason } };
}
