import { ulid } from 'ulid';
import type { Env } from '../env';
import { withOrg, type Sql, type Tx } from '../db';
import { learnInterval, radarFor } from '../lib/radar';
import { enroll } from '../lib/enroll';
import { ticketPrefix } from '../org';

/**
 * The Pathfinder radar.
 *
 * Works out which customers are due to reorder and which have gone quiet, then enrols them
 * into whichever campaigns are waiting on that. This is what `reorder_due` and `lapsed`
 * depend on — without it those triggers are names in a picker that never fire.
 *
 * A drip needs a ticket to live on, and a reorder nudge has no inbound message to hang
 * from, so one is opened on the 'campaign' channel. That keeps the conversation, the
 * replies and the eventual order in the same place as every other job.
 */

const LAPSED_AFTER_DAYS = 180;

export async function runRadar(env: Env, sql: Sql, now = new Date()): Promise<{ scanned: number; flagged: number; enrolled: number }> {
  const orgs = await sql<{ id: string; slug: string; brand: Record<string, unknown> }[]>`
    SELECT id, slug, brand FROM orgs WHERE status = 'active'`;

  let scanned = 0, flagged = 0, enrolled = 0;
  for (const org of orgs) {
    await withOrg(sql, org.id, async (tx) => {
      const companies = await tx<{ id: string; reorder_interval_days: number | null; reorder_interval_source: string | null }[]>`
        SELECT id, reorder_interval_days, reorder_interval_source
          FROM companies WHERE org_id = ${org.id}`;

      for (const co of companies) {
        scanned++;
        const orders = await tx<{ won_at: string; quote_amount: string | null }[]>`
          SELECT won_at, quote_amount FROM leads
           WHERE company_id = ${co.id} AND status = 'won' AND won_at IS NOT NULL
           ORDER BY won_at`;

        const dates = orders.map((o) => new Date(o.won_at));
        const value = orders.reduce((a, o) => a + Number(o.quote_amount ?? 0), 0);
        const last = dates.length ? dates[dates.length - 1] : null;

        // A rhythm someone typed in beats one we inferred; they know the customer.
        const learned = learnInterval(dates);
        const interval = co.reorder_interval_source === 'manual'
          ? co.reorder_interval_days
          : learned ?? co.reorder_interval_days;

        const radar = radarFor({
          lastOrderAt: last, intervalDays: interval ?? null,
          lapsedAfterDays: LAPSED_AFTER_DAYS, now,
        });

        await tx`UPDATE companies
                    SET last_order_at = ${last?.toISOString() ?? null},
                        lifetime_value = ${value},
                        reorder_interval_days = ${interval ?? null},
                        reorder_interval_source = ${co.reorder_interval_source === 'manual' ? 'manual'
                                                   : learned ? 'learned' : co.reorder_interval_source},
                        radar = ${radar}
                  WHERE id = ${co.id}`;
        if (radar) flagged++;
        if (radar) enrolled += await chase(tx, org, co.id, radar);
      }
    });
  }
  return { scanned, flagged, enrolled };
}

/** Enrol a flagged company into any campaign waiting on that flag. */
async function chase(
  tx: Tx, org: { id: string; slug: string; brand: Record<string, unknown> },
  companyId: string, radar: string,
): Promise<number> {
  const seqs = await tx<{ id: string }[]>`
    SELECT id FROM sequences
     WHERE org_id = ${org.id} AND active AND trigger = ${radar}`;
  if (!seqs.length) return 0;

  // The contact who has been dealt with most recently, not an arbitrary one.
  const [contact] = await tx<{ id: string }[]>`
    SELECT c.id FROM contacts c
     WHERE c.company_id = ${companyId} AND NOT c.opted_out
     ORDER BY (SELECT max(l.created_at) FROM leads l WHERE l.contact_id = c.id) DESC NULLS LAST
     LIMIT 1`;
  if (!contact) return 0;

  let n = 0;
  for (const s of seqs) {
    // One open chase per company per campaign. Without this the radar re-enrols every night
    // for as long as the customer stays overdue, which is exactly how a shop sends somebody
    // thirty emails.
    const [already] = await tx<{ id: string }[]>`
      SELECT e.id FROM enrollments e
        JOIN leads l ON l.id = e.lead_id
       WHERE e.sequence_id = ${s.id} AND l.company_id = ${companyId}
         AND e.state IN ('active','held','paused')
       LIMIT 1`;
    if (already) continue;

    const [{ next }] = await tx<{ next: number }[]>`
      UPDATE counters SET next_ticket = next_ticket + 1
       WHERE org_id = ${org.id} RETURNING next_ticket - 1 AS next`;
    const ticketNo = `${ticketPrefix(org as never)}-${next}`;
    const leadId = ulid();

    await tx`INSERT INTO leads (id, org_id, ticket_no, contact_id, company_id, channel, status, spec)
             VALUES (${leadId}, ${org.id}, ${ticketNo}, ${contact.id}, ${companyId},
                     'campaign', 'new', ${tx.json({ subject: radar === 'reorder_due' ? 'Time to reorder' : 'Checking back in' })})`;
    await tx`INSERT INTO activity (id, org_id, lead_id, actor, kind, detail)
             VALUES (${ulid()}, ${org.id}, ${leadId}, 'system', 'lead_created',
                     ${tx.json({ channel: 'campaign', ticket_no: ticketNo, radar })})`;

    if ((await enroll(tx, org.id, leadId, s.id)).ok) n++;
  }
  return n;
}
