import type { Tx } from '../db';

/**
 * How long an open ticket keeps absorbing new contact from the same person.
 *
 * Inside the window a follow-up is almost always the same job — "actually make it 1000",
 * or a photo after the text. Outside it, the same number ringing again is a new enquiry:
 * threading it onto a stale ticket merges two unrelated jobs, hides the second one from the
 * queue, and leaves the first one's specs looking wrong.
 */
export const THREAD_WINDOW_HOURS = 6;

/**
 * The contact's open ticket, if it is still recent enough to belong to.
 *
 * Recency is measured from the last message rather than leads.updated_at, because a reply
 * writes to messages without touching the lead row.
 */
export async function findThreadableLead(
  tx: Tx,
  orgId: string,
  contactId: string,
  windowHours = THREAD_WINDOW_HOURS,
): Promise<string | null> {
  const [row] = await tx<{ id: string }[]>`
    SELECT l.id
      FROM leads l
     WHERE l.org_id = ${orgId}
       AND l.contact_id = ${contactId}
       AND l.status NOT IN ('won','lost','closed','spam')
       AND COALESCE(
             (SELECT max(m.sent_at) FROM messages m WHERE m.lead_id = l.id),
             l.created_at
           ) > now() - make_interval(hours => ${windowHours})
     ORDER BY l.created_at DESC
     LIMIT 1`;
  return row?.id ?? null;
}
