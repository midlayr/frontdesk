import { ulid } from 'ulid';
import type { Tx } from '../db';

/**
 * Putting a lead on a sequence.
 *
 * One place, because every trigger ends here and they must agree on the awkward parts: not
 * enrolling the same lead twice, not starting a drip at someone who has opted out, and
 * starting the clock from the first step's own delay rather than from now.
 */

export const TRIGGERS = [
  'lead_created', 'quoted_no_reply', 'reorder_due', 'lapsed', 'list', 'manual',
] as const;
export type Trigger = (typeof TRIGGERS)[number];
export const isTrigger = (v: string): v is Trigger => (TRIGGERS as readonly string[]).includes(v);

export type EnrollResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'already_enrolled' | 'opted_out' | 'no_steps' | 'no_contact' | 'not_found' };

export async function enroll(
  tx: Tx, orgId: string, leadId: string, sequenceId: string,
): Promise<EnrollResult> {
  const [lead] = await tx<{ contact_id: string | null }[]>`
    SELECT contact_id FROM leads WHERE id = ${leadId} AND org_id = ${orgId}`;
  if (!lead) return { ok: false, reason: 'not_found' };
  // Nothing to send to, and nothing to stop on: a drip needs a person at the other end.
  if (!lead.contact_id) return { ok: false, reason: 'no_contact' };

  const [contact] = await tx<{ opted_out: boolean }[]>`
    SELECT opted_out FROM contacts WHERE id = ${lead.contact_id}`;
  if (contact?.opted_out) return { ok: false, reason: 'opted_out' };

  const [first] = await tx<{ id: string; position: number; due: string }[]>`
    SELECT id, position, (now() + delay) AS due FROM sequence_steps
     WHERE sequence_id = ${sequenceId} ORDER BY position LIMIT 1`;
  // An empty sequence would enroll people and then never do anything, which looks like a
  // send that failed rather than a sequence nobody finished writing.
  if (!first) return { ok: false, reason: 'no_steps' };

  const id = ulid();
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO enrollments (id, sequence_id, lead_id, contact_id, next_step,
                             current_step_id, next_send_at, started_at)
    VALUES (${id}, ${sequenceId}, ${leadId}, ${lead.contact_id}, ${first.position},
            ${first.id}, ${first.due}, now())
    ON CONFLICT (sequence_id, lead_id) WHERE state IN ('active','held','paused') DO NOTHING
    RETURNING id`;
  if (!row) return { ok: false, reason: 'already_enrolled' };

  await tx`INSERT INTO activity (id, org_id, lead_id, actor, kind, detail)
           VALUES (${ulid()}, ${orgId}, ${leadId}, 'system', 'sequence_enrolled',
                   ${tx.json({ sequence_id: sequenceId, enrollment_id: id })})`;
  return { ok: true, id };
}

/**
 * Enroll a new lead into every active sequence that asked for new leads.
 *
 * Guarded by the enrollments_one_running index, so a retried webhook cannot start the same
 * drip twice — the index is partial, so a sequence that has finished can be run again.
 */
export async function onLeadCreated(tx: Tx, orgId: string, leadId: string): Promise<number> {
  const active = await tx<{ id: string }[]>`
    SELECT id FROM sequences
     WHERE org_id = ${orgId} AND active AND trigger = 'lead_created'`;
  let started = 0;
  for (const s of active) {
    const r = await enroll(tx, orgId, leadId, s.id);
    if (r.ok) started++;
  }
  return started;
}
