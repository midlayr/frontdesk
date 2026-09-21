import { ulid } from 'ulid';
import type { Env } from '../env';
import { connect, withOrg, type Sql, type Tx } from '../db';
import { sendSms } from '../lib/twilio';
import { sendEmail } from '../lib/mailgun';
import { enroll } from '../lib/enroll';
import {
  DEFAULT_WINDOW, evaluate, fill, heldReason, nextOpen, stopReason,
  type Branch, type LastSend, type SendWindow, type Standing,
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
  /** The branches on the step we last sent — evaluated now that this one is due. */
  prev_branches: Branch[] | null; prev_subject: string | null; prev_body: string | null;
  intent_score: number | null;
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
           prev.branches AS prev_branches, prev.subject AS prev_subject, prev.body AS prev_body,
           l.intent_score,
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
 LEFT JOIN LATERAL (
        SELECT p.branches, p.subject, p.body FROM sequence_steps p
         WHERE p.sequence_id = s.id AND p.position < st.position
         ORDER BY p.position DESC LIMIT 1) prev ON true
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

    /**
     * Branches are evaluated here, not after the previous send: the question "did they open
     * it?" has no answer the moment the mail leaves, and the honest time to ask is when the
     * follow-up falls due. The reply case is already covered above by the stop checks, so by
     * this point only the delivery outcomes are left to test.
     */
    let kind = d.kind, body0 = d.body, subject0 = d.subject;
    if (d.prev_branches?.length) {
      const [last] = await tx<{
        opened: boolean; clicked: boolean; bounced: boolean; delivered: boolean;
      }[]>`
        SELECT opened_at IS NOT NULL AS opened, clicked_at IS NOT NULL AS clicked,
               bounced_at IS NOT NULL AS bounced, delivered_at IS NOT NULL AS delivered
          FROM messages
         WHERE enrollment_id = ${d.enrollment_id} AND direction = 'out'
         ORDER BY sent_at DESC LIMIT 1`;

      // No delivery event has ever been recorded for this tenant's mail — no webhook yet, or
      // tracking off. Open-based branches stay silent rather than firing at everyone.
      const [{ tracked }] = await tx<{ tracked: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM messages m
                        JOIN leads l2 ON l2.id = m.lead_id
                       WHERE l2.org_id = ${d.org_id} AND m.opened_at IS NOT NULL) AS tracked`;

      const outcome: LastSend = {
        opened: !!last?.opened, clicked: !!last?.clicked, bounced: !!last?.bounced,
        delivered: !!last?.delivered, replied: false, health: d.intent_score,
      };
      const hit = evaluate(d.prev_branches, outcome, tracked);

      if (hit) {
        await note(tx, d, 'branch_fired', { if: hit.if, then: hit.then, at_step: d.position });
        switch (hit.then) {
          case 'stop':
            await tx`UPDATE enrollments SET state = 'completed' WHERE id = ${d.enrollment_id}`;
            return 'stopped';
          case 'skip_to': {
            const [to] = await tx<{ id: string; position: number; due: string }[]>`
              SELECT id, position, (now() + delay) AS due FROM sequence_steps
               WHERE sequence_id = ${d.sequence_id} AND position = ${hit.config?.step ?? 0}`;
            if (to) {
              await tx`UPDATE enrollments
                          SET next_step = ${to.position}, current_step_id = ${to.id},
                              next_send_at = now()
                        WHERE id = ${d.enrollment_id}`;
              return 'held';   // picked up on the next pass, at the step it jumped to
            }
            break;
          }
          case 'resend':
            // The previous step's words again, under a subject the author chose for the
            // second attempt — a resend is a second attempt, not a new message.
            body0 = d.prev_body ?? body0;
            subject0 = hit.config?.subject ?? subject0;
            break;
          case 'switch_sms': kind = 'sms'; break;
          case 'assign':
            await tx`UPDATE leads SET assignee_id = ${hit.config?.user_id ?? null} WHERE id = ${d.lead_id}`;
            break;
          case 'task':
            await tx`INSERT INTO tasks (id, org_id, lead_id, assignee_id, text, source)
                     SELECT ${ulid()}, ${d.org_id}, ${d.lead_id}, l.assignee_id,
                            ${hit.config?.text ?? 'Follow up'}, ${'sequence:' + d.sequence_id}
                       FROM leads l WHERE l.id = ${d.lead_id}`;
            break;
          case 'tag':
            await tx`UPDATE companies SET enrichment = COALESCE(enrichment, '{}'::jsonb)
                       || jsonb_build_object('tag', ${hit.config?.tag ?? ''})
                      WHERE id = (SELECT company_id FROM leads WHERE id = ${d.lead_id})`;
            break;
          case 'continue': break;
        }
      }
    }

    // A wait step is only a delay; a task step leaves work for a human. Neither sends.
    if (kind === 'wait') { await advance(tx, d); return 'sent'; }
    if (kind === 'task') {
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
    const body = fill(body0, values);
    const subject = fill(subject0 ?? '', values);
    const missing = [...new Set([...body.missing, ...subject.missing])];
    if (missing.length) {
      await hold(tx, d, heldReason(missing));
      return 'held';
    }

    const [org] = await tx<{ name: string; comms: Record<string, string> }[]>`
      SELECT name, comms FROM orgs WHERE id = ${d.org_id}`;

    let providerId: string | null = null;
    if (kind === 'sms') {
      if (!d.phone || !org.comms.sms_number) { await hold(tx, d, 'missing:{phone}'); return 'held'; }
      // The opt-out line is not optional and not the author's to remove.
      // Delivery receipts come back to /hooks/twilio/status, which is what makes the
      // sms_delivered branch condition answerable at all.
      const sent = await sendSms(
        env, org.comms.sms_number, d.phone, `${body.text}\n\nReply STOP to opt out.`,
        `${env.PUBLIC_ORIGIN ?? ''}/hooks/twilio/status` || undefined);
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
             VALUES (${ulid()}, ${d.lead_id}, ${kind === 'sms' ? 'sms' : 'email'}, 'out',
                     ${'sequence:' + d.sequence_id}, ${body.text}, ${providerId},
                     ${d.enrollment_id}, ${d.step_id})`;
    await note(tx, d, 'drip_sent', { step: d.position, kind, provider_id: providerId });
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

/**
 * The quoted-no-reply trigger.
 *
 * A cron sweep rather than an event, because the thing that fires it is the *absence* of a
 * message — there is no moment to hook. Guarded by the same unique index as every other
 * enrolment, so running it every five minutes cannot pile people onto the sequence twice.
 */
export async function sweepQuotedNoReply(env: Env, sql: Sql): Promise<number> {
  const seqs = await sql<{ id: string; org_id: string; trigger_config: { days?: number } }[]>`
    SELECT id, org_id, trigger_config FROM sequences
     WHERE active AND trigger = 'quoted_no_reply'`;

  let started = 0;
  for (const s of seqs) {
    const days = Number(s.trigger_config?.days ?? 2);
    started += await withOrg(sql, s.org_id, async (tx) => {
      const leads = await tx<{ id: string }[]>`
        SELECT l.id FROM leads l
         WHERE l.org_id = ${s.org_id} AND l.status = 'quoted' AND l.archived_at IS NULL
           AND COALESCE(l.quoted_at, l.updated_at) < now() - make_interval(days => ${days})
           AND NOT EXISTS (SELECT 1 FROM messages m
                            WHERE m.lead_id = l.id AND m.direction = 'in'
                              AND m.sent_at > COALESCE(l.quoted_at, l.updated_at))
         LIMIT 100`;
      let n = 0;
      for (const l of leads) if ((await enroll(tx, s.org_id, l.id, s.id)).ok) n++;
      return n;
    });
  }
  return started;
}
