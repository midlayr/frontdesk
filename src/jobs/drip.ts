import { ulid } from 'ulid';
import type { Env } from '../env';
import { connect, withOrg, type Sql, type Tx } from '../db';
import { sendSms } from '../lib/twilio';
import { sendEmail } from '../lib/mailgun';
import {
  DEFAULT_WINDOW, fill, heldReason, nextOpen, stopReason,
  type SendWindow, type Standing,
} from '../lib/drip';

/**
 * The drip runner, on the five-minute cron.
 *
 * Decisions live in lib/drip.ts and are tested there; this file is the part that cannot be:
 * loading the row, sending, and writing down what happened. It sends through the same
 * Twilio and Mailgun helpers a rep's own reply uses, so a drip cannot end up with different
 * deliverability, a different From, or a different Reply-To than a human message.
 */

interface Due {
  enrollment_id: string; sequence_id: string; lead_id: string; contact_id: string;
  org_id: string; started_at: string; last_sent_at: string | null; next_step: number;
  send_window: SendWindow | null; send_as: string; seq_name: string;
  step_id: string; kind: string; position: number; subject: string | null; body: string;
  lead_status: string; archived: boolean; ticket_no: string;
  qty: number | null; product: string | null; size: string | null; stock: string | null;
  deadline_at: string | null; quote_amount: string | null;
  first_name: string | null; company: string | null; email: string | null; phone: string | null;
  opted_out: boolean; rep_name: string | null; rep_phone: string | null;
}

const MAX_PER_RUN = 50;

export async function runDrips(env: Env, now = new Date()): Promise<{ sent: number; held: number; stopped: number }> {
  const sql = connect(env);
  const tally = { sent: 0, held: 0, stopped: 0 };
  try {
    // orgs sits outside RLS, so the sweep for work happens before any tenant context opens;
    // everything after this runs inside withOrg for the org that owns the row.
    const orgs = await sql<{ id: string }[]>`
      SELECT DISTINCT s.org_id AS id
        FROM enrollments e JOIN sequences s ON s.id = e.sequence_id
       WHERE e.state = 'active' AND e.next_send_at <= now() AND s.active`;

    for (const org of orgs) {
      const due = await withOrg(sql, org.id, (tx) => load(tx, org.id));
      for (const row of due) {
        const outcome = await step(env, sql, row, now);
        tally[outcome] += 1;
      }
    }
  } finally {
    await sql.end();
  }
  return tally;
}

function load(tx: Tx, orgId: string): Promise<Due[]> {
  return tx<Due[]>`
    SELECT e.id AS enrollment_id, e.sequence_id, e.lead_id, e.contact_id, s.org_id,
           e.started_at, e.last_sent_at, e.next_step,
           s.send_window, s.send_as, s.name AS seq_name,
           st.id AS step_id, st.kind, st.position, st.subject, st.body,
           l.status AS lead_status, (l.archived_at IS NOT NULL) AS archived, l.ticket_no,
           l.qty, l.product, l.size, l.stock, l.deadline_at, l.quote_amount,
           split_part(COALESCE(c.name, ''), ' ', 1) AS first_name,
           co.name AS company, c.email, c.phone, c.opted_out,
           u.name AS rep_name, ${''} AS rep_phone
      FROM enrollments e
      JOIN sequences s  ON s.id = e.sequence_id
      JOIN leads l      ON l.id = e.lead_id
      JOIN contacts c   ON c.id = e.contact_id
      JOIN sequence_steps st ON st.sequence_id = s.id AND st.position = e.next_step
 LEFT JOIN companies co ON co.id = l.company_id
 LEFT JOIN users u      ON u.id = l.assignee_id
     WHERE e.state = 'active' AND e.next_send_at <= now() AND s.active AND s.org_id = ${orgId}
     ORDER BY e.next_send_at
     LIMIT ${MAX_PER_RUN}`;
}

async function step(env: Env, sql: Sql, d: Due, now: Date): Promise<'sent' | 'held' | 'stopped'> {
  return withOrg(sql, d.org_id, async (tx) => {
    // Re-read the things that can change under a running sequence. Checked here rather than
    // at enrolment because the whole point is that a week may pass between the two.
    const [{ inbound_since, rep_since }] = await tx<{ inbound_since: boolean; rep_since: boolean }[]>`
      SELECT
        EXISTS (SELECT 1 FROM messages m
                 WHERE m.lead_id = ${d.lead_id} AND m.direction = 'in'
                   AND m.sent_at > ${d.started_at}) AS inbound_since,
        EXISTS (SELECT 1 FROM messages m
                 WHERE m.lead_id = ${d.lead_id} AND m.direction = 'out'
                   AND m.enrollment_id IS NULL
                   AND m.sent_at > COALESCE(${d.last_sent_at}, ${d.started_at})) AS rep_since`;

    const standing: Standing = {
      optedOut: d.opted_out,
      leadStatus: d.lead_status,
      archived: d.archived,
      inboundSince: inbound_since,
      repRepliedSince: rep_since,
    };

    const stop = stopReason(standing);
    if (stop) {
      await tx`UPDATE enrollments SET state = ${stop}::enroll_state WHERE id = ${d.enrollment_id}`;
      await note(tx, d, 'sequence_stopped', { reason: stop });
      return 'stopped';
    }

    // Outside the window, the step is not skipped — it is moved to the next opening. A
    // window that can never open holds the enrollment rather than looping over candidates.
    const window = d.send_window ?? DEFAULT_WINDOW;
    const when = nextOpen(now, window);
    if (!when) {
      await hold(tx, d, 'window_never_opens');
      return 'held';
    }
    if (when.getTime() > now.getTime()) {
      await tx`UPDATE enrollments SET next_send_at = ${when.toISOString()} WHERE id = ${d.enrollment_id}`;
      return 'held';
    }

    // A wait step is only a delay; a task step leaves work for a human. Neither sends.
    if (d.kind === 'wait') { await advance(tx, d); return 'sent'; }
    if (d.kind === 'task') {
      await tx`INSERT INTO tasks (id, org_id, lead_id, assignee_id, text, source)
               SELECT ${ulid()}, ${d.org_id}, ${d.lead_id}, l.assignee_id, ${d.body}, ${'sequence:' + d.sequence_id}
                 FROM leads l WHERE l.id = ${d.lead_id}`;
      await advance(tx, d);
      return 'sent';
    }

    const values = {
      first_name: d.first_name, company: d.company, qty: d.qty, product: d.product,
      size: d.size, stock: d.stock, deadline: d.deadline_at?.slice(0, 10) ?? null,
      quote_amount: d.quote_amount ? `$${Number(d.quote_amount).toLocaleString('en-US')}` : null,
      quote_link: null, ticket_no: d.ticket_no,
      rep_name: d.rep_name, rep_phone: d.rep_phone,
    };
    const body = fill(d.body, values);
    const subject = fill(d.subject ?? '', values);
    const missing = [...new Set([...body.missing, ...subject.missing])];
    if (missing.length) {
      await hold(tx, d, heldReason(missing));
      return 'held';
    }

    const [org] = await tx<{ name: string; comms: Record<string, string> }[]>`
      SELECT name, comms FROM orgs WHERE id = ${d.org_id}`;

    let providerId: string | null = null;
    if (d.kind === 'sms') {
      if (!d.phone || !org.comms.sms_number) { await hold(tx, d, 'missing:{phone}'); return 'held'; }
      // The opt-out line is not optional and not the author's to remove.
      const sent = await sendSms(env, org.comms.sms_number, d.phone, `${body.text}\n\nReply STOP to opt out.`);
      providerId = sent.sid;
    } else {
      if (!d.email) { await hold(tx, d, 'missing:{email}'); return 'held'; }
      const display = d.send_as === 'rep' && d.rep_name ? d.rep_name : org.name;
      const sender = org.comms.email_sender || `${d.org_id}@${env.MAILGUN_DOMAIN}`;
      const sent = await sendEmail(env, {
        from: `${display} <${sender}>`,
        to: d.email,
        subject: subject.text || `About your enquiry · ${d.ticket_no}`,
        text: body.text,
        replyTo: org.comms.email_inbound ?? sender,
      });
      providerId = sent.id;
    }

    await tx`INSERT INTO messages (id, lead_id, channel, direction, author, body, provider_id,
                                   enrollment_id, step_id)
             VALUES (${ulid()}, ${d.lead_id}, ${d.kind === 'sms' ? 'sms' : 'email'}, 'out',
                     ${'sequence:' + d.sequence_id}, ${body.text}, ${providerId},
                     ${d.enrollment_id}, ${d.step_id})`;
    await note(tx, d, 'drip_sent', { step: d.position, kind: d.kind, provider_id: providerId });
    await advance(tx, d);
    return 'sent';
  });
}

/** Move to the next step, or finish when there is not one. */
async function advance(tx: Tx, d: Due): Promise<void> {
  const [next] = await tx<{ id: string; position: number; due: string }[]>`
    SELECT id, position, (now() + delay) AS due FROM sequence_steps
     WHERE sequence_id = ${d.sequence_id} AND position > ${d.position}
     ORDER BY position LIMIT 1`;

  if (!next) {
    await tx`UPDATE enrollments
                SET state = 'completed', last_sent_at = now(), current_step_id = ${d.step_id}
              WHERE id = ${d.enrollment_id}`;
    return;
  }
  await tx`UPDATE enrollments
              SET next_step = ${next.position}, current_step_id = ${next.id},
                  next_send_at = ${next.due}, last_sent_at = now(), held_reason = NULL
            WHERE id = ${d.enrollment_id}`;
}

async function hold(tx: Tx, d: Due, reason: string): Promise<void> {
  await tx`UPDATE enrollments SET state = 'held', held_reason = ${reason}
            WHERE id = ${d.enrollment_id}`;
  await note(tx, d, 'sequence_held', { reason, step: d.position });
}

const note = (tx: Tx, d: Due, kind: string, detail: Record<string, unknown>) =>
  tx`INSERT INTO activity (id, org_id, lead_id, actor, kind, detail)
     VALUES (${ulid()}, ${d.org_id}, ${d.lead_id}, ${'sequence:' + d.sequence_id}, ${kind},
             ${tx.json(detail as never)})`;
